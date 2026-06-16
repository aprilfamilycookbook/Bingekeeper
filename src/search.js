import { verifyJWT } from './auth.js';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

async function getUser(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return await verifyJWT(auth.slice(7), env.JWT_SECRET);
}

export async function handleSearch(request, env, url) {
  const q = url.searchParams.get('q');
  if (!q) return new Response(JSON.stringify({ error: 'Missing query' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  try {
    const tmdbApiKey = env.TMDB_API_KEY || env['TMDB_API_KEY '];
    const res = await fetch(`https://api.themoviedb.org/3/search/tv?api_key=${tmdbApiKey}&query=${encodeURIComponent(q)}&language=en-US&page=1`);
    const data = await res.json();
    if (data.status_code === 7) return new Response(JSON.stringify({ error: 'TMDB API key invalid' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    const results = await Promise.all((data.results || []).slice(0, 6).map(async show => ({
      ...show,
      providers: await getProviders(tmdbApiKey, show.id)
    })));
    return new Response(JSON.stringify({ results }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Search failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

export async function handleRecommendations(request, env, url, path) {
  const user = await getUser(request, env);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  const tmdbApiKey = env.TMDB_API_KEY || env['TMDB_API_KEY '];
  if (!tmdbApiKey) return jsonResponse({ error: 'TMDB API key is not configured' }, 500);

  try {
    const tracked = await getTrackedShows(env, user.userId);
    const trackedIds = new Set(tracked.map(show => Number(show.show_id)));

    if (path === '/api/recommendations/dashboard') {
      const sourceShows = tracked.slice(0, 6);
      const recommendations = await recommendationsForSources(tmdbApiKey, sourceShows, trackedIds, 8);
      return jsonResponse({ source: 'tmdb', strategy: 'tracked_show_recommendations', recommendations });
    }

    const showId = Number(url.searchParams.get('show_id'));
    if (!showId) return jsonResponse({ error: 'show_id required' }, 400);
    const sourceShow = tracked.find(show => Number(show.show_id) === showId) || { show_id: showId, name: '' };
    const recommendations = await recommendationsForSources(tmdbApiKey, [sourceShow], trackedIds, 8);
    return jsonResponse({ source: 'tmdb', strategy: 'show_recommendations', recommendations });
  } catch {
    return jsonResponse({ error: 'Could not load recommendations' }, 500);
  }
}

async function getTrackedShows(env, userId) {
  try {
    const rows = await env.DB.prepare(`
      SELECT w.show_id, COALESCE(s.name, w.show_name) AS name
      FROM watchlist w
      LEFT JOIN shows s ON s.id = w.show_id
      WHERE w.user_id = ?
      ORDER BY w.added_at DESC
    `).bind(userId).all();
    return rows.results || [];
  } catch {
    const rows = await env.DB.prepare(`
      SELECT w.show_id, s.name
      FROM watchlist w
      LEFT JOIN shows s ON s.id = w.show_id
      WHERE w.user_id = ?
      ORDER BY w.added_at DESC
    `).bind(userId).all();
    return rows.results || [];
  }
}

async function recommendationsForSources(apiKey, sourceShows, trackedIds, limit) {
  const collected = [];
  for (const source of sourceShows) {
    if (!source?.show_id) continue;
    const data = await tmdb(apiKey, `/tv/${source.show_id}/recommendations`, { page: '1' }).catch(() => ({ results: [] }));
    for (const show of data.results || []) {
      if (!show?.id || trackedIds.has(Number(show.id))) continue;
      collected.push({ ...show, source_show_id: Number(source.show_id), source_show_name: source.name || '' });
    }
  }

  const unique = dedupeRecommendations(collected)
    .sort((a, b) =>
      recommendationScore(b) - recommendationScore(a) ||
      Number(b.popularity || 0) - Number(a.popularity || 0) ||
      String(a.name).localeCompare(String(b.name))
    )
    .slice(0, limit);

  return Promise.all(unique.map(async show => normalizeRecommendation(show, await getProviders(apiKey, show.id))));
}

function dedupeRecommendations(shows) {
  const byId = new Map();
  for (const show of shows) {
    const existing = byId.get(show.id);
    if (!existing || recommendationScore(show) > recommendationScore(existing)) byId.set(show.id, show);
  }
  return [...byId.values()];
}

function recommendationScore(show) {
  const popularity = Number(show.popularity || 0);
  const votes = Number(show.vote_count || 0);
  return popularity + Math.min(Math.log10(votes + 1) * 12, 42);
}

function normalizeRecommendation(show, providers = []) {
  return {
    id: show.id,
    name: show.name,
    poster_path: show.poster_path || null,
    overview: show.overview || '',
    first_air_date: show.first_air_date || null,
    providers,
    source: 'tmdb',
    source_show_id: show.source_show_id || null,
    source_show_name: show.source_show_name || '',
    popularity: Number(show.popularity || 0),
    vote_count: Number(show.vote_count || 0)
  };
}

async function tmdb(apiKey, path, params = {}) {
  const tmdbUrl = new URL(`https://api.themoviedb.org/3${path}`);
  tmdbUrl.searchParams.set('api_key', apiKey);
  tmdbUrl.searchParams.set('language', 'en-US');
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') tmdbUrl.searchParams.set(key, value);
  }
  const res = await fetch(tmdbUrl.toString());
  const data = await res.json();
  if (!res.ok || data.status_code === 7) throw new Error(data.status_message || 'TMDB request failed');
  return data;
}

async function getProviders(apiKey, showId) {
  try {
    const res = await fetch(`https://api.themoviedb.org/3/tv/${showId}/watch/providers?api_key=${apiKey}`);
    const data = await res.json();
    const us = data.results?.US;
    if (!us) return [];
    const providers = [...(us.flatrate || []), ...(us.ads || []), ...(us.free || [])];
    const names = providers.map(provider => normalizeProvider(provider.provider_name)).filter(Boolean);
    return [...new Set(names)].slice(0, 4);
  } catch {
    return [];
  }
}

function normalizeProvider(name) {
  const provider = (name || '').toLowerCase();
  if (provider.includes('netflix')) return 'Netflix';
  if (provider.includes('max') || provider.includes('hbo')) return 'Max';
  if (provider.includes('hulu')) return 'Hulu';
  if (provider.includes('disney')) return 'Disney+';
  if (provider.includes('apple')) return 'Apple TV+';
  if (provider.includes('peacock')) return 'Peacock';
  if (provider.includes('paramount')) return 'Paramount+';
  if (provider.includes('prime') || provider.includes('amazon')) return 'Amazon Prime';
  return name;
}
