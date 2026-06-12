import { verifyJWT } from './auth.js';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

async function getUser(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return await verifyJWT(auth.slice(7), env.JWT_SECRET);
}

export async function handleWatchlist(request, env, path) {
  const user = await getUser(request, env);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  if (path === '/api/watchlist' && request.method === 'GET') {
    const rows = await env.DB.prepare(`SELECT w.*, s.name, s.poster_path, s.overview, s.next_episode_date, s.next_season_number, s.next_episode_number FROM watchlist w JOIN shows s ON w.show_id = s.id WHERE w.user_id = ? ORDER BY w.added_at DESC`).bind(user.userId).all();
    return jsonResponse({ watchlist: rows.results });
  }

  if (path === '/api/watchlist' && request.method === 'POST') {
    const { show_id, name, poster_path, overview, first_air_date, status, service, current_season, current_episode } = await request.json();
    if (!show_id || !name) return jsonResponse({ error: 'show_id and name required' }, 400);
    await env.DB.prepare(`INSERT INTO shows (id, name, poster_path, overview, first_air_date) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, poster_path=excluded.poster_path`).bind(show_id, name, poster_path || null, overview || null, first_air_date || null).run();
    try {
      await env.DB.prepare(`INSERT INTO watchlist (user_id, show_id, status, service, current_season, current_episode) VALUES (?, ?, ?, ?, ?, ?)`).bind(user.userId, show_id, status || 'Watching', service || 'Other', current_season || 1, current_episode || 1).run();
    } catch (e) { return jsonResponse({ error: 'Already in watchlist' }, 409); }
    return jsonResponse({ message: 'Added to watchlist' });
  }

  const match = path.match(/^\/api\/watchlist\/(\d+)$/);
  if (match && request.method === 'PUT') {
    const showId = parseInt(match[1]);
    const { status, service, current_season, current_episode, notify } = await request.json();
    await env.DB.prepare(`UPDATE watchlist SET status=?, service=?, current_season=?, current_episode=?, notify=? WHERE user_id=? AND show_id=?`).bind(status, service, current_season, current_episode, notify ? 1 : 0, user.userId, showId).run();
    return jsonResponse({ message: 'Updated' });
  }

  if (match && request.method === 'DELETE') {
    const showId = parseInt(match[1]);
    await env.DB.prepare('DELETE FROM watchlist WHERE user_id=? AND show_id=?').bind(user.userId, showId).run();
    return jsonResponse({ message: 'Removed' });
  }

  return jsonResponse({ error: 'Not found' }, 404);
}
