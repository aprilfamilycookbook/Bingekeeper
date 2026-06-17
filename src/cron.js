import { sendPushToUser } from './push.js';

export async function handleCron(env) {
  console.log('Running nightly notification check...');
  const stale = await env.DB.prepare(`SELECT DISTINCT s.id FROM shows s JOIN watchlist w ON s.id = w.show_id WHERE w.notify = 1 AND s.last_checked < ?`).bind(Math.floor(Date.now() / 1000) - 43200).all();
  for (const show of stale.results) { await checkShowForUpdates(show.id, env); await new Promise(r => setTimeout(r, 300)); }
  const upcoming = await getUpcomingNotifications(env);
  for (const item of upcoming.results.filter(shouldNotifyToday)) {
    const episodeKey = `${item.show_id}-S${item.next_season_number}E${item.next_episode_number}`;
    const alreadySent = await env.DB.prepare('SELECT id FROM notifications_sent WHERE user_id=? AND show_id=? AND episode_key=?').bind(item.user_id, item.show_id, episodeKey).first();
    if (!alreadySent) { await sendReleaseNotification(env, item); await env.DB.prepare('INSERT INTO notifications_sent (user_id, show_id, episode_key) VALUES (?, ?, ?)').bind(item.user_id, item.show_id, episodeKey).run(); }
  }
}

async function getUpcomingNotifications(env) {
  const baseQuery = `SELECT w.user_id, w.show_id, u.email, u.name, u.notify_email, s.name as show_name, s.next_episode_date, s.next_season_number, s.next_episode_number`;
  const joins = ` FROM watchlist w JOIN users u ON w.user_id = u.id JOIN shows s ON w.show_id = s.id WHERE w.notify = 1 AND s.next_episode_date IS NOT NULL AND s.next_episode_date BETWEEN date('now') AND date('now', '+2 days')`;
  try {
    return await env.DB.prepare(`${baseQuery}, COALESCE(w.notify_pref, 'two_days') as notify_pref${joins}`).all();
  } catch {
    return await env.DB.prepare(`${baseQuery}, 'two_days' as notify_pref${joins}`).all();
  }
}

function shouldNotifyToday(item) {
  const days = daysUntil(item.next_episode_date);
  if (days < 0) return false;
  if (item.notify_pref === 'none') return false;
  if (item.notify_pref === 'drop') return days === 0;
  if (item.notify_pref === 'day_before') return days === 1;
  return days <= 2;
}

async function checkShowForUpdates(showId, env) {
  try {
    const tmdbApiKey = env.TMDB_API_KEY || env['TMDB_API_KEY '];
    const res = await fetch(`https://api.themoviedb.org/3/tv/${showId}?api_key=${tmdbApiKey}&language=en-US`);
    const data = await res.json();
    let nextDate = null, nextSeason = null, nextEpisode = null;
    if (data.next_episode_to_air) { nextDate = data.next_episode_to_air.air_date; nextSeason = data.next_episode_to_air.season_number; nextEpisode = data.next_episode_to_air.episode_number; }
    await env.DB.prepare(`UPDATE shows SET next_episode_date=?, next_season_number=?, next_episode_number=?, last_checked=? WHERE id=?`).bind(nextDate, nextSeason, nextEpisode, Math.floor(Date.now() / 1000), showId).run();
  } catch (e) { console.error(`Failed to check show ${showId}:`, e); }
}

async function sendReleaseNotification(env, item) {
  const message = releaseMessage(item);
  const pushResult = await sendPushToUser(env, item.user_id, {
    title: message.subject,
    body: message.body,
    url: '/'
  }).catch(error => ({ sent: 0, error: error?.message || 'Push failed' }));

  if (pushResult.sent > 0) return;
  await sendEmailNotification(env, item, message);
}

function releaseMessage(item) {
  const isNewSeason = item.next_episode_number === 1;
  const days = daysUntil(item.next_episode_date);
  const when = days === 0 ? 'today' : days === 1 ? 'tomorrow' : 'soon';
  const episodeLabel = isNewSeason ? `Season ${item.next_season_number} premiere` : `S${item.next_season_number}E${item.next_episode_number}`;
  const subject = isNewSeason ? `New season of ${item.show_name} starts ${when}!` : `New episode of ${item.show_name} ${when}!`;
  return {
    subject,
    episodeLabel,
    body: `${episodeLabel} airs ${item.next_episode_date}.`
  };
}

async function sendEmailNotification(env, item, message) {
  if (!item.notify_email) return;
  if (!env.RESEND_API_KEY) return;
  const html = `<div style="font-family:-apple-system,sans-serif;max-width:500px;margin:0 auto;padding:24px"><h1 style="color:#378ADD">Bingekeeper</h1><h2>Hey ${item.name}!</h2><p style="font-size:16px"><strong>${item.show_name}</strong> has a new episode coming up:</p><div style="background:#f0f0f0;border-radius:12px;padding:16px;text-align:center"><div style="font-size:20px;font-weight:600">${message.episodeLabel}</div><div style="color:#666">Airs ${item.next_episode_date}</div></div><a href="https://bingekeeper.tv" style="color:#378ADD">Manage your watchlist</a></div>`;
  await fetch('https://api.resend.com/emails', { method: 'POST', headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'Bingekeeper <hello@bingekeeper.tv>', to: item.email, subject: message.subject, html }) });
}

function daysUntil(date) {
  const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  const target = new Date(`${date}T00:00:00Z`);
  return Math.round((target - today) / 86400000);
}
