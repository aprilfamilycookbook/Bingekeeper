import { verifyJWT } from './auth.js';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

async function getTokenUser(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return await verifyJWT(auth.slice(7), env.JWT_SECRET);
}

function adminEmails(env) {
  return String(env.ADMIN_EMAILS || '')
    .split(',')
    .map(email => email.trim().toLowerCase())
    .filter(Boolean);
}

async function getAdminUser(request, env) {
  const tokenUser = await getTokenUser(request, env);
  if (!tokenUser) return null;

  let user;
  try {
    user = await env.DB.prepare('SELECT id, email, name, is_admin FROM users WHERE id = ?').bind(tokenUser.userId).first();
  } catch {
    user = await env.DB.prepare('SELECT id, email, name FROM users WHERE id = ?').bind(tokenUser.userId).first();
  }
  if (!user) return null;

  const isAdmin = Boolean(user.is_admin) || adminEmails(env).includes(String(user.email).toLowerCase());
  return isAdmin ? user : null;
}

export async function handleAdmin(request, env, path) {
  const admin = await getAdminUser(request, env);
  if (!admin) return jsonResponse({ error: 'Admin access required' }, 403);

  if (path === '/api/admin/me' && request.method === 'GET') {
    return jsonResponse({ user: { id: admin.id, email: admin.email, name: admin.name, is_admin: true } });
  }

  if (path === '/api/admin/social' && request.method === 'GET') {
    const today = new Date().toISOString().slice(0, 10);
    const weekEnd = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const rows = await env.DB.prepare(`
      SELECT
        s.id AS show_id,
        s.name,
        s.poster_path,
        s.next_episode_date,
        s.next_season_number,
        s.next_episode_number,
        COUNT(DISTINCT w.user_id) AS tracked_count,
        GROUP_CONCAT(DISTINCT w.service) AS services
      FROM shows s
      LEFT JOIN watchlist w ON w.show_id = s.id
      WHERE s.next_episode_date IS NOT NULL
         OR w.show_id IS NOT NULL
      GROUP BY s.id
      ORDER BY
        CASE WHEN s.next_episode_date IS NULL THEN 1 ELSE 0 END,
        s.next_episode_date ASC,
        tracked_count DESC,
        s.name ASC
    `).all();

    const items = (rows.results || []).map(row => normalizeSocialItem(row));
    const releasedToday = items.filter(item => item.release_date === today);
    const newSeasonsToday = releasedToday.filter(item => item.episode_number === 1 && item.season_number);
    const newEpisodesToday = releasedToday.filter(item => !(item.episode_number === 1 && item.season_number));
    const premieringThisWeek = items.filter(item => item.release_date && item.release_date > today && item.release_date <= weekEnd);
    const trendingTracked = items
      .filter(item => item.tracked_count > 0)
      .sort((a, b) => b.tracked_count - a.tracked_count || String(a.name).localeCompare(String(b.name)))
      .slice(0, 12);

    return jsonResponse({
      generated_at: new Date().toISOString(),
      sections: {
        new_seasons_today: newSeasonsToday,
        new_episodes_today: newEpisodesToday,
        premiering_this_week: premieringThisWeek,
        trending_tracked: trendingTracked
      }
    });
  }

  return jsonResponse({ error: 'Not found' }, 404);
}

function normalizeSocialItem(row) {
  const services = String(row.services || '')
    .split(',')
    .map(service => service.trim())
    .filter(service => service && service !== 'Other');

  return {
    show_id: row.show_id,
    name: row.name,
    poster_path: row.poster_path || null,
    poster_url: row.poster_path ? `https://image.tmdb.org/t/p/w185${row.poster_path}` : null,
    release_date: row.next_episode_date || null,
    season_number: row.next_season_number || null,
    episode_number: row.next_episode_number || null,
    episode_title: null,
    services: [...new Set(services)].slice(0, 4),
    tracked_count: Number(row.tracked_count || 0)
  };
}
