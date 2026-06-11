// ─── Helpers ──────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

function setCookieHeader(sessionId) {
  return `session=${sessionId}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 30}`;
}

function getSessionId(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/session=([^;]+)/);
  return match ? match[1] : null;
}

async function hashPassword(password) {
  const enc = new TextEncoder().encode(password);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateId() {
  return crypto.randomUUID();
}

async function getUser(request, env) {
  const sessionId = getSessionId(request);
  if (!sessionId) return null;
  const session = await env.DB.prepare('SELECT user_id FROM sessions WHERE id = ?').bind(sessionId).first();
  if (!session) return null;
  return await env.DB.prepare('SELECT id, email, notify_email FROM users WHERE id = ?').bind(session.user_id).first();
}

// ─── Worker ───────────────────────────────────────────────────────────────────

export default {

  // ── Cron: runs daily at 9am UTC ──────────────────────────────────────────
  async scheduled(event, env, ctx) {
    const today = new Date().toISOString().split('T')[0];
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];

    // Get all users with notifications enabled and their watchlists
    const users = await env.DB.prepare(
      'SELECT DISTINCT u.id, u.email FROM users u JOIN watchlist w ON u.id = w.user_id WHERE u.notify_email = 1'
    ).all();

    for (const user of users.results) {
      const shows = await env.DB.prepare(
        "SELECT show_id, show_name FROM watchlist WHERE user_id = ? AND status IN ('Watching', 'Plan to Watch')"
      ).bind(user.id).all();

      const alerts = [];

      for (const show of shows.results) {
        try {
          const res = await fetch(
            `https://api.themoviedb.org/3/tv/${show.show_id}?api_key=${env.TMDB_API_KEY}&append_to_response=next_episode_to_air`
          );
          const data = await res.json();
          if (data.next_episode_to_air) {
            const airDate = data.next_episode_to_air.air_date;
            if (airDate === today || airDate === tomorrow) {
              const when = airDate === today ? 'today' : 'tomorrow';
              const ep = data.next_episode_to_air;
              alerts.push(`• <strong>${show.show_name}</strong> — S${ep.season_number}E${ep.episode_number} airs ${when}!`);
            }
          }
        } catch (e) { /* skip show on error */ }
      }

      if (alerts.length > 0) {
        await sendEmail(env, user.email, alerts);
      }
    }
  },

  // ── HTTP handler ─────────────────────────────────────────────────────────
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        }
      });
    }

    // ── Auth routes ─────────────────────────────────────────────────────────

    if (path === '/api/register' && method === 'POST') {
      const { email, password } = await request.json();
      if (!email || !password || password.length < 6)
        return json({ error: 'Valid email and password (6+ chars) required' }, 400);
      try {
        const hash = await hashPassword(password);
        await env.DB.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').bind(email.toLowerCase().trim(), hash).run();
        const user = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email.toLowerCase().trim()).first();
        const sessionId = generateId();
        await env.DB.prepare('INSERT INTO sessions (id, user_id) VALUES (?, ?)').bind(sessionId, user.id).run();
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Set-Cookie': setCookieHeader(sessionId) }
        });
      } catch (e) {
        if (e.message?.includes('UNIQUE')) return json({ error: 'Email already registered' }, 400);
        return json({ error: 'Registration failed' }, 500);
      }
    }

    if (path === '/api/login' && method === 'POST') {
      const { email, password } = await request.json();
      const user = await env.DB.prepare('SELECT id, password_hash FROM users WHERE email = ?').bind(email.toLowerCase().trim()).first();
      if (!user) return json({ error: 'Invalid email or password' }, 401);
      const hash = await hashPassword(password);
      if (hash !== user.password_hash) return json({ error: 'Invalid email or password' }, 401);
      const sessionId = generateId();
      await env.DB.prepare('INSERT INTO sessions (id, user_id) VALUES (?, ?)').bind(sessionId, user.id).run();
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Set-Cookie': setCookieHeader(sessionId) }
      });
    }

    if (path === '/api/logout' && method === 'POST') {
      const sessionId = getSessionId(request);
      if (sessionId) await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'session=; HttpOnly; Secure; Path=/; Max-Age=0' }
      });
    }

    if (path === '/api/me' && method === 'GET') {
      const user = await getUser(request, env);
      if (!user) return json({ user: null });
      return json({ user: { email: user.email, notify_email: user.notify_email } });
    }

    // ── Search ──────────────────────────────────────────────────────────────

    if (path === '/api/search' && method === 'GET') {
      const q = url.searchParams.get('q');
      if (!q) return json({ error: 'Missing query' }, 400);
      try {
        const res = await fetch(
          `https://api.themoviedb.org/3/search/tv?api_key=${env.TMDB_API_KEY}&query=${encodeURIComponent(q)}&language=en-US&page=1`
        );
        const data = await res.json();
        if (data.status_code === 7) return json({ error: 'TMDB API key invalid' }, 401);
        return json({ results: data.results || [] });
      } catch (e) {
        return json({ error: 'Search failed' }, 500);
      }
    }

    // ── Watchlist (requires auth) ────────────────────────────────────────────

    if (path.startsWith('/api/watchlist')) {
      const user = await getUser(request, env);
      if (!user) return json({ error: 'Not logged in' }, 401);

      if (method === 'GET') {
        const shows = await env.DB.prepare('SELECT * FROM watchlist WHERE user_id = ? ORDER BY added_at DESC').bind(user.id).all();
        return json({ shows: shows.results });
      }

      if (method === 'POST') {
        const { show_id, show_name, poster, status, service, season, episode } = await request.json();
        try {
          await env.DB.prepare(
            'INSERT INTO watchlist (user_id, show_id, show_name, poster, status, service, season, episode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(user.id, show_id, show_name, poster || '', status, service, season, episode).run();
          return json({ ok: true });
        } catch (e) {
          if (e.message?.includes('UNIQUE')) return json({ error: 'Already in watchlist' }, 400);
          return json({ error: 'Failed to add show' }, 500);
        }
      }

      if (method === 'PUT') {
        const { id, status, service, season, episode } = await request.json();
        await env.DB.prepare(
          'UPDATE watchlist SET status = ?, service = ?, season = ?, episode = ? WHERE id = ? AND user_id = ?'
        ).bind(status, service, season, episode, id, user.id).run();
        return json({ ok: true });
      }

      if (method === 'DELETE') {
        const id = url.searchParams.get('id');
        await env.DB.prepare('DELETE FROM watchlist WHERE id = ? AND user_id = ?').bind(id, user.id).run();
        return json({ ok: true });
      }
    }

    // ── Settings ─────────────────────────────────────────────────────────────

    if (path === '/api/settings' && method === 'PUT') {
      const user = await getUser(request, env);
      if (!user) return json({ error: 'Not logged in' }, 401);
      const { notify_email } = await request.json();
      await env.DB.prepare('UPDATE users SET notify_email = ? WHERE id = ?').bind(notify_email ? 1 : 0, user.id).run();
      return json({ ok: true });
    }

    // ── Static assets ────────────────────────────────────────────────────────
    return env.ASSETS.fetch(request);
  }
};

// ─── Email via Resend ─────────────────────────────────────────────────────────

async function sendEmail(env, to, alerts) {
  if (!env.RESEND_API_KEY) return;
  const html = `
    <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:24px">
      <h2 style="color:#378ADD;margin-bottom:8px">📺 Bingekeeper</h2>
      <p style="color:#666;margin-bottom:16px">New episodes are coming up on your watchlist:</p>
      <div style="background:#f8f8f6;border-radius:8px;padding:16px;margin-bottom:16px">
        ${alerts.join('<br>')}
      </div>
      <p style="color:#999;font-size:13px">
        Manage your watchlist at <a href="https://bingekeeper.tv">bingekeeper.tv</a><br>
        <a href="https://bingekeeper.tv">Unsubscribe</a>
      </p>
    </div>`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Bingekeeper <notifications@bingekeeper.tv>',
      to,
      subject: `📺 New episodes coming up on your watchlist!`,
      html
    })
  });
}
