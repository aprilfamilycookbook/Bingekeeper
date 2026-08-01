import { verifyJWT } from './auth.js';
import { ensureNotificationDeliverySchema, sendPushToUser } from './push.js';

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

  if (path === '/api/admin/analytics' && request.method === 'GET') {
    const [
      totalUsers,
      newUsersToday,
      totalWatchlists,
      totalTrackedShows,
      plusSubscribers
    ] = await Promise.all([
      countQuery(env, 'SELECT COUNT(*) AS total FROM users'),
      countQuery(env, "SELECT COUNT(*) AS total FROM users WHERE created_at >= unixepoch('now', 'start of day')"),
      countQuery(env, 'SELECT COUNT(*) AS total FROM watchlist'),
      countQuery(env, 'SELECT COUNT(DISTINCT show_id) AS total FROM watchlist'),
      countQuery(env, "SELECT COUNT(*) AS total FROM users WHERE COALESCE(plan, 'free') = 'plus' OR subscription_status = 'active'")
    ]);

    return jsonResponse({
      generated_at: new Date().toISOString(),
      metrics: {
        total_users: totalUsers,
        new_users_today: newUsersToday,
        total_watchlists: totalWatchlists,
        total_tracked_shows: totalTrackedShows,
        average_shows_per_user: totalUsers ? Number((totalWatchlists / totalUsers).toFixed(1)) : 0,
        plus_subscribers: plusSubscribers
      }
    });
  }

  if (path === '/api/admin/notifications/audit' && request.method === 'GET') {
    await ensureNotificationDeliverySchema(env);
    const attempts = await env.DB.prepare(`
      SELECT
        a.id,
        a.test_id,
        a.source,
        a.user_id,
        u.email,
        a.show_id,
        s.name AS show_name,
        a.episode_key,
        a.channel,
        a.subscription_id,
        a.device_id,
        a.device,
        a.attempted_at,
        a.provider_status,
        a.success,
        a.failure_reason,
        a.fallback_attempted,
        a.notifications_sent_written,
        a.sw_received_at,
        a.sw_displayed_at
      FROM notification_delivery_attempts a
      LEFT JOIN users u ON u.id = a.user_id
      LEFT JOIN shows s ON s.id = a.show_id
      ORDER BY a.attempted_at DESC, a.id DESC
      LIMIT 20
    `).all();
    const subscriptions = await activeNotificationSubscriptions(env);
    return jsonResponse({
      generated_at: new Date().toISOString(),
      attempts: (attempts.results || []).map(redactAttempt),
      active_subscriptions: subscriptions
    });
  }

  if (path === '/api/admin/notifications/test' && request.method === 'POST') {
    await ensureNotificationDeliverySchema(env);
    const body = await request.json().catch(() => ({}));
    const userId = Number(body.user_id || 0);
    const subscriptionId = Number(body.subscription_id || 0);
    if (!userId) return jsonResponse({ error: 'user_id is required' }, 400);
    if (!subscriptionId) return jsonResponse({ error: 'subscription_id is required' }, 400);

    const subscription = await env.DB.prepare(`
      SELECT id, user_id, endpoint, enabled
      FROM push_subscriptions
      WHERE id = ? AND user_id = ? AND enabled = 1
    `).bind(subscriptionId, userId).first();
    if (!subscription) return jsonResponse({ error: 'Active subscription not found for that user' }, 404);

    const testId = crypto.randomUUID();
    const result = await sendPushToUser(env, userId, {
      title: 'BingeKeeper remote push test',
      body: `Remote encrypted test ${testId.slice(0, 8)}`,
      url: '/',
      test_id: testId
    }, {
      source: 'admin_test',
      subscriptionId,
      testId
    });

    console.log(JSON.stringify({
      event: 'admin_remote_push_test',
      test_id: testId,
      admin_user_id: admin.id,
      user_id: userId,
      subscription_id: subscriptionId,
      attempted: result.attempted,
      sent: result.sent
    }));

    return jsonResponse({
      test_id: testId,
      accepted: result.sent > 0,
      attempted: result.attempted,
      sent: result.sent,
      failed: result.failed,
      error: result.error || ''
    }, result.sent > 0 ? 200 : 502);
  }

  if (path === '/api/admin/social' && request.method === 'GET') {
    const today = new Date().toISOString().slice(0, 10);
    const weekEnd = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const tmdbApiKey = env.TMDB_API_KEY || env['TMDB_API_KEY '];
    if (!tmdbApiKey) return jsonResponse({ error: 'TMDB API key is not configured' }, 500);

    const trackedMeta = await getTrackedShowMeta(env);
    const [releasedToday, premieringThisWeek, trendingPopular] = await Promise.all([
      safeSocialSection(() => getAiringToday(tmdbApiKey, trackedMeta, today)),
      safeSocialSection(() => getPremieringThisWeek(tmdbApiKey, trackedMeta, today, weekEnd)),
      safeSocialSection(() => getTrendingShows(tmdbApiKey, trackedMeta))
    ]);

    const newSeasonsToday = releasedToday.filter(item => item.episode_number === 1 && item.season_number && item.season_number > 1);
    const newEpisodesToday = releasedToday.filter(item => !(item.episode_number === 1 && item.season_number && item.season_number > 1));
    const trendingThisWeek = editorialPicks([
      ...newSeasonsToday,
      ...newEpisodesToday,
      ...premieringThisWeek,
      ...trendingPopular
    ], 10);

    return jsonResponse({
      generated_at: new Date().toISOString(),
      sections: {
        trending_this_week: trendingThisWeek,
        new_seasons_today: editorialPicks(newSeasonsToday, 10),
        new_episodes_today: editorialPicks(newEpisodesToday, 12),
        premiering_this_week: editorialPicks(premieringThisWeek, 12),
        trending_tracked: editorialPicks(trendingPopular, 12)
      }
    });
  }

  return jsonResponse({ error: 'Not found' }, 404);
}

async function countQuery(env, sql) {
  const row = await env.DB.prepare(sql).first();
  return Number(row?.total || 0);
}

async function activeNotificationSubscriptions(env) {
  try {
    const rows = await env.DB.prepare(`
      SELECT
        ps.id,
        ps.user_id,
        u.email,
        ps.endpoint,
        ps.user_agent,
        ps.device_id,
        ps.enabled,
        ps.last_success_at,
        ps.last_failure_at,
        ps.last_failure_status,
        ps.last_failure_reason,
        ps.updated_at
      FROM push_subscriptions ps
      JOIN users u ON u.id = ps.user_id
      WHERE ps.enabled = 1
      ORDER BY ps.updated_at DESC
      LIMIT 50
    `).all();
    return (rows.results || []).map(redactSubscription);
  } catch {
    const rows = await env.DB.prepare(`
      SELECT
        ps.id,
        ps.user_id,
        u.email,
        ps.endpoint,
        ps.user_agent,
        NULL AS device_id,
        ps.enabled,
        ps.last_success_at,
        ps.last_failure_at,
        ps.last_failure_status,
        ps.last_failure_reason,
        ps.updated_at
      FROM push_subscriptions ps
      JOIN users u ON u.id = ps.user_id
      WHERE ps.enabled = 1
      ORDER BY ps.updated_at DESC
      LIMIT 50
    `).all();
    return (rows.results || []).map(redactSubscription);
  }
}

function redactAttempt(row) {
  return {
    id: row.id,
    test_id: row.test_id || null,
    source: row.source || null,
    user_id: row.user_id,
    email: row.email || null,
    show_id: row.show_id || null,
    show_name: row.show_name || null,
    episode_key: row.episode_key || null,
    channel: row.channel,
    subscription_id: row.subscription_id || null,
    device_id: row.device_id ? String(row.device_id).slice(0, 12) : null,
    device: row.device || null,
    attempted_at: row.attempted_at || null,
    provider_status: row.provider_status || null,
    success: Boolean(row.success),
    failure_reason: row.failure_reason || null,
    fallback_attempted: Boolean(row.fallback_attempted),
    notifications_sent_written: Boolean(row.notifications_sent_written),
    sw_received_at: row.sw_received_at || null,
    sw_displayed_at: row.sw_displayed_at || null
  };
}

function redactSubscription(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    email: row.email || null,
    endpoint_origin: endpointOrigin(row.endpoint),
    device_id: row.device_id ? String(row.device_id).slice(0, 12) : null,
    device: safeUserAgent(row.user_agent, row.device_id),
    enabled: Boolean(row.enabled),
    last_success_at: row.last_success_at || null,
    last_failure_at: row.last_failure_at || null,
    last_failure_status: row.last_failure_status || null,
    last_failure_reason: row.last_failure_reason || null,
    updated_at: row.updated_at || null
  };
}

function endpointOrigin(endpoint) {
  try {
    return new URL(endpoint).origin;
  } catch {
    return '';
  }
}

function safeUserAgent(userAgent, deviceId) {
  const id = deviceId ? `device ${String(deviceId).slice(0, 8)}` : 'unknown device';
  const ua = String(userAgent || '').replace(/\s+/g, ' ').slice(0, 120);
  return ua ? `${id} - ${ua}` : id;
}

async function getTrackedShowMeta(env) {
  const rows = await env.DB.prepare(`
    SELECT
      s.id AS show_id,
      COUNT(DISTINCT w.user_id) AS tracked_count,
      GROUP_CONCAT(DISTINCT w.service) AS services
    FROM shows s
    LEFT JOIN watchlist w ON w.show_id = s.id
    GROUP BY s.id
  `).all();

  const meta = new Map();
  for (const row of rows.results || []) {
    meta.set(Number(row.show_id), {
      tracked_count: Number(row.tracked_count || 0),
      services: normalizeServices(row.services)
    });
  }
  return meta;
}

async function getAiringToday(apiKey, trackedMeta, today) {
  const data = await tmdb(apiKey, '/tv/airing_today', { page: '1', timezone: 'America/New_York' });
  return hydrateShows(apiKey, data.results || [], trackedMeta, show => episodeForDate(show, today), 20);
}

async function getPremieringThisWeek(apiKey, trackedMeta, today, weekEnd) {
  const data = await tmdb(apiKey, '/discover/tv', {
    page: '1',
    sort_by: 'popularity.desc',
    'air_date.gte': today,
    'air_date.lte': weekEnd,
    timezone: 'America/New_York',
    include_adult: 'false',
    include_null_first_air_dates: 'false'
  });
  const items = await hydrateShows(apiKey, data.results || [], trackedMeta, show => episodeForDateRange(show, today, weekEnd), 20);
  return rankSocialItems(items.filter(item => item.release_date && item.release_date > today && item.release_date <= weekEnd));
}

async function getTrendingShows(apiKey, trackedMeta) {
  const data = await tmdb(apiKey, '/trending/tv/day', { page: '1' });
  return hydrateShows(apiKey, data.results || [], trackedMeta, show => {
    const episode = show.next_episode_to_air || show.last_episode_to_air || {};
    return {
      release_date: episode.air_date || show.first_air_date || null,
      season_number: episode.season_number || null,
      episode_number: episode.episode_number || null,
      episode_title: episode.name || null
    };
  }, 20);
}

async function hydrateShows(apiKey, shows, trackedMeta, episodeSelector, limit) {
  const unique = [];
  const seen = new Set();
  for (const show of shows) {
    if (!show?.id || seen.has(show.id)) continue;
    seen.add(show.id);
    unique.push(show);
    if (unique.length >= limit) break;
  }

  const items = await Promise.all(unique.map(async show => {
    const [details, providers] = await Promise.all([
      tmdb(apiKey, `/tv/${show.id}`, { language: 'en-US' }).catch(() => ({})),
      getProviders(apiKey, show.id)
    ]);
    const hydratedShow = { ...show, ...details };
    const episode = episodeSelector(hydratedShow);
    const tracked = trackedMeta.get(Number(show.id)) || { tracked_count: 0, services: [] };
    return normalizeSocialItem({
      show_id: show.id,
      name: hydratedShow.name,
      poster_path: hydratedShow.poster_path,
      release_date: episode.release_date,
      season_number: episode.season_number,
      episode_number: episode.episode_number,
      episode_title: episode.episode_title,
      services: [...providers, ...tracked.services],
      tracked_count: tracked.tracked_count,
      popularity: hydratedShow.popularity,
      vote_count: hydratedShow.vote_count,
      vote_average: hydratedShow.vote_average,
      networks: (hydratedShow.networks || []).map(network => network.name).filter(Boolean)
    });
  }));

  return rankSocialItems(items.filter(item => item.name));
}

async function safeSocialSection(loader) {
  try {
    return await loader();
  } catch {
    return [];
  }
}

function episodeForDate(show, date) {
  const candidates = [show.last_episode_to_air, show.next_episode_to_air].filter(Boolean);
  const episode = candidates.find(item => item.air_date === date) || candidates[0] || {};
  return {
    release_date: episode.air_date || date,
    season_number: episode.season_number || null,
    episode_number: episode.episode_number || null,
    episode_title: episode.name || null
  };
}

function episodeForDateRange(show, today, weekEnd) {
  const candidates = [show.next_episode_to_air, show.last_episode_to_air].filter(Boolean);
  const episode = candidates.find(item => item.air_date && item.air_date > today && item.air_date <= weekEnd) || candidates[0] || {};
  return {
    release_date: episode.air_date || null,
    season_number: episode.season_number || null,
    episode_number: episode.episode_number || null,
    episode_title: episode.name || null
  };
}

async function tmdb(apiKey, path, params = {}) {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('language', 'en-US');
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  }
  const response = await fetch(url.toString());
  const data = await response.json();
  if (!response.ok || data.status_code === 7) throw new Error(data.status_message || 'TMDB request failed');
  return data;
}

async function getProviders(apiKey, showId) {
  try {
    const data = await tmdb(apiKey, `/tv/${showId}/watch/providers`, {});
    const us = data.results?.US;
    if (!us) return [];
    const providers = [...(us.flatrate || []), ...(us.ads || []), ...(us.free || [])];
    const names = providers.map(provider => normalizeProvider(provider.provider_name)).filter(Boolean);
    return [...new Set(names)].slice(0, 4);
  } catch {
    return [];
  }
}

function normalizeServices(services) {
  return String(services || '')
    .split(',')
    .map(service => service.trim())
    .filter(service => service && service !== 'Other');
}

function normalizeSocialItem(row) {
  const services = [...new Set(normalizeServices(row.services))].slice(0, 4);
  const networks = Array.isArray(row.networks) ? row.networks : normalizeServices(row.networks);
  const popularity = Number(row.popularity || 0);
  const voteCount = Number(row.vote_count || 0);
  const trackedCount = Number(row.tracked_count || 0);
  const isMajor = isMajorShow({ services, networks, voteCount, popularity, trackedCount });
  const engagementScore = socialScore({ popularity, voteCount, trackedCount, services, networks });

  return {
    show_id: row.show_id,
    name: row.name,
    poster_path: row.poster_path || null,
    poster_url: row.poster_path ? `https://image.tmdb.org/t/p/w185${row.poster_path}` : null,
    release_date: row.release_date || null,
    season_number: row.season_number || null,
    episode_number: row.episode_number || null,
    episode_title: row.episode_title || null,
    services,
    tracked_count: trackedCount,
    popularity,
    vote_count: voteCount,
    vote_average: Number(row.vote_average || 0),
    networks: networks.slice(0, 3),
    is_major: isMajor,
    engagement_score: engagementScore
  };
}

function editorialPicks(items, limit) {
  const ranked = rankSocialItems(items);
  return ranked
    .filter(item => item.is_major || item.engagement_score >= 70 || item.vote_count >= 500 || item.tracked_count >= 2)
    .slice(0, limit);
}

function rankSocialItems(items) {
  const unique = [];
  const seen = new Set();
  for (const item of items) {
    if (!item?.show_id || seen.has(item.show_id)) continue;
    seen.add(item.show_id);
    unique.push(item);
  }
  return unique.sort((a, b) =>
    Number(b.engagement_score || 0) - Number(a.engagement_score || 0) ||
    Number(b.popularity || 0) - Number(a.popularity || 0) ||
    Number(b.vote_count || 0) - Number(a.vote_count || 0) ||
    String(a.name).localeCompare(String(b.name))
  );
}

function socialScore({ popularity, voteCount, trackedCount, services, networks }) {
  const providerBoost = hasMajorService(services) ? 18 : 0;
  const networkBoost = hasMajorService(networks) ? 12 : 0;
  const trackedBoost = Math.min(Number(trackedCount || 0) * 8, 40);
  const voteBoost = Math.min(Math.log10(Number(voteCount || 0) + 1) * 12, 48);
  return Math.round((Number(popularity || 0) * 1.2) + voteBoost + trackedBoost + providerBoost + networkBoost);
}

function isMajorShow({ services, networks, voteCount, popularity, trackedCount }) {
  const majorPlatform = hasMajorService(services) || hasMajorService(networks);
  const audienceSignal = Number(popularity || 0) >= 35 || Number(voteCount || 0) >= 250 || Number(trackedCount || 0) >= 1;
  return (majorPlatform && audienceSignal) ||
    Number(voteCount || 0) >= 1000 ||
    Number(popularity || 0) >= 80 ||
    Number(trackedCount || 0) >= 3;
}

function hasMajorService(values = []) {
  const major = ['Netflix', 'Hulu', 'Max', 'Disney+', 'Apple TV+', 'Peacock', 'Paramount+', 'Amazon Prime'];
  return values.some(value => major.includes(normalizeProvider(value)));
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
