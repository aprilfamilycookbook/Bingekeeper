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
    trackedIds.add(showId);
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
    const sourceDetails = await getShowDetails(apiKey, source.show_id).catch(() => ({}));
    const sourceSignals = showSignals({ ...source, ...sourceDetails });
    const [recommended, similar] = await Promise.all([
      tmdb(apiKey, `/tv/${source.show_id}/recommendations`, { page: '1' }).catch(() => ({ results: [] })),
      tmdb(apiKey, `/tv/${source.show_id}/similar`, { page: '1' }).catch(() => ({ results: [] }))
    ]);
    const candidates = [
      ...(recommended.results || []).map(show => ({ ...show, match_sources: ['recommended'] })),
      ...(similar.results || []).map(show => ({ ...show, match_sources: ['similar'] }))
    ];
    const prefilteredCandidates = dedupeRawCandidates(candidates)
      .sort((a, b) => basicCandidateScore(b) - basicCandidateScore(a))
      .slice(0, 24);

    for (const show of prefilteredCandidates) {
      if (!show?.id || trackedIds.has(Number(show.id))) continue;
      const candidateDetails = await getShowDetails(apiKey, show.id).catch(() => ({}));
      const hydrated = { ...show, ...candidateDetails };
      const matchSources = [...new Set(show.match_sources || ['recommended'])];
      const score = recommendationScore(hydrated, sourceSignals, matchSources);
      if (!isViableRecommendation(hydrated, score, sourceSignals)) continue;
      collected.push({
        ...hydrated,
        match_sources: matchSources,
        recommendation_score: score,
        source_show_id: Number(source.show_id),
        source_show_name: source.name || sourceDetails.name || ''
      });
    }
  }

  const unique = dedupeRecommendations(collected)
    .sort((a, b) =>
      Number(b.recommendation_score || 0) - Number(a.recommendation_score || 0) ||
      Number(b.popularity || 0) - Number(a.popularity || 0) ||
      Number(b.vote_count || 0) - Number(a.vote_count || 0) ||
      String(a.name).localeCompare(String(b.name))
    )
    .slice(0, limit);

  return Promise.all(unique.map(async show => normalizeRecommendation(show, await getProviders(apiKey, show.id))));
}

function dedupeRawCandidates(shows) {
  const byId = new Map();
  for (const show of shows) {
    if (!show?.id) continue;
    const existing = byId.get(show.id);
    if (!existing) {
      byId.set(show.id, show);
    } else {
      existing.match_sources = [...new Set([...(existing.match_sources || []), ...(show.match_sources || [])])];
      if (basicCandidateScore(show) > basicCandidateScore(existing)) byId.set(show.id, { ...existing, ...show, match_sources: existing.match_sources });
    }
  }
  return [...byId.values()];
}

function basicCandidateScore(show) {
  return Number(show.popularity || 0) + Math.min(Math.log10(Number(show.vote_count || 0) + 1) * 12, 42) + recencyScore(yearFromDate(show.first_air_date));
}

function dedupeRecommendations(shows) {
  const byId = new Map();
  for (const show of shows) {
    const existing = byId.get(show.id);
    if (!existing || Number(show.recommendation_score || 0) > Number(existing.recommendation_score || 0)) byId.set(show.id, show);
  }
  return [...byId.values()];
}

function recommendationScore(show, sourceSignals = {}, matchSources = []) {
  const popularity = Number(show.popularity || 0);
  const votes = Number(show.vote_count || 0);
  const firstYear = yearFromDate(show.first_air_date);
  const voteBoost = Math.min(Math.log10(votes + 1) * 14, 52);
  const recencyBoost = recencyScore(firstYear);
  const sourceBoost = (matchSources.includes('recommended') ? 28 : 0) + (matchSources.includes('similar') ? 14 : 0);
  const candidateSignals = showSignals(show);
  const creatorBoost = overlapCount(sourceSignals.creatorIds, candidateSignals.creatorIds) * 42;
  const castBoost = Math.min(overlapCount(sourceSignals.castIds, candidateSignals.castIds) * 14, 56);
  const companyBoost = overlapCount(sourceSignals.companyIds, candidateSignals.companyIds) * 12;
  const networkBoost = overlapCount(sourceSignals.networkIds, candidateSignals.networkIds) * 8;
  const franchiseBoost = franchiseRelationshipScore(sourceSignals, candidateSignals);
  const oldPenalty = oldCatalogPenalty(firstYear, popularity, votes, creatorBoost + castBoost + franchiseBoost);

  return Math.round(
    popularity * 1.35 +
    voteBoost +
    recencyBoost +
    sourceBoost +
    creatorBoost +
    castBoost +
    companyBoost +
    networkBoost +
    franchiseBoost -
    oldPenalty
  );
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
    vote_count: Number(show.vote_count || 0),
    recommendation_score: Number(show.recommendation_score || 0),
    match_sources: show.match_sources || []
  };
}

async function getShowDetails(apiKey, showId) {
  return tmdb(apiKey, `/tv/${showId}`, { append_to_response: 'aggregate_credits' });
}

function showSignals(show = {}) {
  const title = normalizeText(show.name || show.original_name || '');
  const creatorIds = new Set((show.created_by || []).map(person => Number(person.id)).filter(Boolean));
  const networkIds = new Set((show.networks || []).map(network => Number(network.id)).filter(Boolean));
  const companyIds = new Set((show.production_companies || []).map(company => Number(company.id)).filter(Boolean));
  const castIds = new Set((show.aggregate_credits?.cast || [])
    .slice()
    .sort((a, b) => Number(a.order ?? 99) - Number(b.order ?? 99))
    .slice(0, 14)
    .map(person => Number(person.id))
    .filter(Boolean));
  return {
    title,
    firstYear: yearFromDate(show.first_air_date),
    creatorIds,
    networkIds,
    companyIds,
    castIds,
    universe: detectUniverse(title)
  };
}

function isViableRecommendation(show, score, sourceSignals = {}) {
  const popularity = Number(show.popularity || 0);
  const votes = Number(show.vote_count || 0);
  const year = yearFromDate(show.first_air_date);
  const modern = !year || year >= new Date().getFullYear() - 15;
  const connectedUniverse = sourceSignals.universe && detectUniverse(normalizeText(show.name || show.original_name || '')) === sourceSignals.universe;
  if (connectedUniverse) return score >= 45;
  if (year && year < 2000 && popularity < 45 && votes < 800) return false;
  if (!modern && popularity < 65 && votes < 1500 && score < 105) return false;
  return score >= 55 || popularity >= 45 || votes >= 1000;
}

function recencyScore(year) {
  if (!year) return 4;
  const currentYear = new Date().getFullYear();
  const age = currentYear - year;
  if (age <= 3) return 34;
  if (age <= 8) return 28;
  if (age <= 15) return 20;
  if (age <= 25) return 5;
  return -28;
}

function oldCatalogPenalty(year, popularity, votes, relationshipScore) {
  if (!year) return 0;
  if (year >= new Date().getFullYear() - 15) return 0;
  const age = new Date().getFullYear() - year;
  const audience = Number(popularity || 0) + Math.min(Math.log10(Number(votes || 0) + 1) * 12, 42);
  const penalty = Math.max(0, age - 15) * 3.2;
  return Math.max(0, penalty - audience * 0.22 - Number(relationshipScore || 0) * 0.55);
}

function franchiseRelationshipScore(sourceSignals, candidateSignals) {
  let score = 0;
  if (sourceSignals.universe && sourceSignals.universe === candidateSignals.universe) score += 90;
  if (sourceSignals.universe === 'yellowstone' && isTaylorSheridanAdjacent(candidateSignals.title)) score += 38;
  return score;
}

function detectUniverse(title) {
  if (!title) return '';
  if (
    title.includes('yellowstone') ||
    title.includes('1883') ||
    title.includes('1923') ||
    title.includes('marshals') ||
    title.includes('dutton')
  ) return 'yellowstone';
  return '';
}

function isTaylorSheridanAdjacent(title) {
  return [
    'landman',
    'lawmen bass reeves',
    'mayor of kingstown',
    'tulsa king',
    'lioness',
    'special ops lioness',
    'the last cowboy'
  ].some(name => title.includes(name));
}

function overlapCount(a = new Set(), b = new Set()) {
  let count = 0;
  for (const item of a) if (b.has(item)) count++;
  return count;
}

function yearFromDate(date) {
  const year = Number(String(date || '').slice(0, 4));
  return Number.isFinite(year) && year > 0 ? year : 0;
}

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
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
