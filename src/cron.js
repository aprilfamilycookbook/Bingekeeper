import { markFallbackAttempted, markNotificationsSentWritten, recordNotificationAttempt, sendPushToUser } from './push.js';

export async function handleCron(env) {
  const startedAt = Date.now();
  const stats = { staleShows: 0, refreshedShows: 0, refreshFailures: 0, selectedUsers: 0, sent: 0, skipped: 0, failed: 0 };
  console.log(JSON.stringify({ event: 'notification_cron_start', at: new Date().toISOString() }));
  const stale = await env.DB.prepare(`SELECT DISTINCT s.id FROM shows s JOIN watchlist w ON s.id = w.show_id WHERE w.notify = 1 AND s.last_checked < ?`).bind(Math.floor(Date.now() / 1000) - 43200).all();
  stats.staleShows = stale.results?.length || 0;
  for (const show of stale.results || []) {
    const refreshed = await checkShowForUpdates(show.id, env);
    if (refreshed) stats.refreshedShows++;
    else stats.refreshFailures++;
    await new Promise(r => setTimeout(r, 150));
    if (Date.now() - startedAt > 45000) {
      console.warn(JSON.stringify({ event: 'notification_cron_refresh_budget_exhausted', stats }));
      break;
    }
  }
  const upcoming = await getUpcomingNotifications(env);
  const candidates = (upcoming.results || []).filter(shouldNotifyToday);
  stats.selectedUsers = candidates.length;
  for (const item of candidates) {
    try {
      const episodeKey = episodeKeyFor(item);
      const alreadySent = await env.DB.prepare('SELECT id FROM notifications_sent WHERE user_id=? AND show_id=? AND episode_key=?').bind(item.user_id, item.show_id, episodeKey).first();
      if (alreadySent) {
        stats.skipped++;
        continue;
      }

      const result = await sendReleaseNotification(env, item, episodeKey);
      if (result.delivered) {
        await env.DB.prepare('INSERT INTO notifications_sent (user_id, show_id, episode_key) VALUES (?, ?, ?)').bind(item.user_id, item.show_id, episodeKey).run();
        await markNotificationsSentWritten(env, { user_id: item.user_id, show_id: item.show_id, episode_key: episodeKey });
        stats.sent++;
      } else {
        stats.failed++;
        console.warn(JSON.stringify({ event: 'notification_delivery_failed', user_id: item.user_id, show_id: item.show_id, episode_key: episodeKey, reason: result.reason }));
      }
    } catch (error) {
      stats.failed++;
      console.error(JSON.stringify({ event: 'notification_item_failed', user_id: item.user_id, show_id: item.show_id, error: error?.message || String(error) }));
    }
  }
  console.log(JSON.stringify({ event: 'notification_cron_complete', duration_ms: Date.now() - startedAt, stats }));
}

async function getUpcomingNotifications(env) {
  const baseQuery = `SELECT w.user_id, w.show_id, u.email, u.name, u.notify_email, s.name as show_name, s.poster_path, s.next_episode_date, s.next_season_number, s.next_episode_number, s.next_episode_title`;
  const joins = ` FROM watchlist w JOIN users u ON w.user_id = u.id JOIN shows s ON w.show_id = s.id WHERE w.notify = 1 AND s.next_episode_date IS NOT NULL AND s.next_episode_date BETWEEN date('now') AND date('now', '+2 days')`;
  try {
    return await env.DB.prepare(`${baseQuery}, COALESCE(w.notify_pref, 'two_days') as notify_pref${joins}`).all();
  } catch {
    return await env.DB.prepare(`SELECT w.user_id, w.show_id, u.email, u.name, u.notify_email, s.name as show_name, s.poster_path, s.next_episode_date, s.next_season_number, s.next_episode_number, NULL as next_episode_title, 'two_days' as notify_pref${joins}`).all();
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
    let nextDate = null, nextSeason = null, nextEpisode = null, nextTitle = null;
    if (data.next_episode_to_air) { nextDate = data.next_episode_to_air.air_date; nextSeason = data.next_episode_to_air.season_number; nextEpisode = data.next_episode_to_air.episode_number; nextTitle = data.next_episode_to_air.name || null; }
    try {
      await env.DB.prepare(`UPDATE shows SET next_episode_date=?, next_season_number=?, next_episode_number=?, next_episode_title=?, last_checked=? WHERE id=?`).bind(nextDate, nextSeason, nextEpisode, nextTitle, Math.floor(Date.now() / 1000), showId).run();
    } catch {
      await env.DB.prepare(`UPDATE shows SET next_episode_date=?, next_season_number=?, next_episode_number=?, last_checked=? WHERE id=?`).bind(nextDate, nextSeason, nextEpisode, Math.floor(Date.now() / 1000), showId).run();
    }
    return true;
  } catch (e) {
    console.error(JSON.stringify({ event: 'tmdb_show_refresh_failed', show_id: showId, error: e?.message || String(e) }));
    return false;
  }
}

async function sendReleaseNotification(env, item, episodeKey) {
  const message = releaseMessage(item);
  const testId = crypto.randomUUID();
  let pushResult;
  try {
    pushResult = await sendPushToUser(env, item.user_id, {
      title: message.subject,
      body: message.body,
      url: '/',
      show_id: item.show_id,
      episode_key: episodeKey
    }, {
      source: 'scheduled',
      showId: item.show_id,
      episodeKey,
      testId
    });
  } catch (error) {
    const reason = error?.message || 'Push failed before provider response';
    pushResult = { sent: 0, error: reason };
    await recordNotificationAttempt(env, {
      test_id: testId,
      source: 'scheduled',
      user_id: item.user_id,
      show_id: item.show_id,
      episode_key: episodeKey,
      channel: 'push',
      success: 0,
      failure_reason: reason
    });
  }

  if (pushResult.sent > 0) return { delivered: true, channel: 'push', pushResult };

  await markFallbackAttempted(env, { user_id: item.user_id, show_id: item.show_id, episode_key: episodeKey, test_id: testId });
  const emailResult = await sendEmailNotification(env, item, message, episodeKey, true);
  if (emailResult.success) return { delivered: true, channel: 'email', pushResult, emailResult };
  return { delivered: false, channel: 'none', pushResult, emailResult, reason: emailResult.reason || pushResult.error || 'No delivery channel available' };
}

export function releaseMessage(item) {
  const isNewSeason = item.next_episode_number === 1;
  const episodeLabel = isNewSeason ? `Season ${item.next_season_number} premiere` : `Season ${item.next_season_number}, Episode ${item.next_episode_number}`;
  const subject = isNewSeason ? `New season of ${item.show_name} starts soon!` : `New episode of ${item.show_name} soon!`;
  const airDate = formatLongDate(item.next_episode_date);
  return {
    subject,
    episodeLabel,
    airDate,
    body: `${episodeLabel} airs ${airDate}.`
  };
}

async function sendEmailNotification(env, item, message, episodeKey, fallbackAttempted = false) {
  const baseAttempt = {
    source: 'scheduled',
    user_id: item.user_id,
    show_id: item.show_id,
    episode_key: episodeKey,
    channel: 'email',
    fallback_attempted: fallbackAttempted ? 1 : 0
  };
  if (!item.notify_email) {
    const reason = 'Email notifications disabled';
    await recordNotificationAttempt(env, { ...baseAttempt, success: 0, failure_reason: reason });
    return { attempted: false, success: false, reason };
  }
  if (!env.RESEND_API_KEY) {
    const reason = 'Email provider is not configured';
    await recordNotificationAttempt(env, { ...baseAttempt, success: 0, failure_reason: reason });
    return { attempted: false, success: false, reason };
  }
  const html = notificationEmailHtml(item, message);
  try {
    const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'Bingekeeper <hello@bingekeeper.tv>', to: item.email, subject: message.subject, html }) });
    const failureBody = response.ok ? '' : await response.text().catch(() => '');
    await recordNotificationAttempt(env, {
      ...baseAttempt,
      provider_status: response.status,
      success: response.ok ? 1 : 0,
      failure_reason: response.ok ? '' : (failureBody || 'Email provider rejected notification')
    });
    return { attempted: true, success: response.ok, status: response.status, reason: response.ok ? '' : (failureBody || 'Email provider rejected notification').slice(0, 220) };
  } catch (error) {
    const reason = error?.message || 'Email request failed';
    await recordNotificationAttempt(env, { ...baseAttempt, provider_status: 0, success: 0, failure_reason: reason });
    return { attempted: true, success: false, status: 0, reason };
  }
}

function episodeKeyFor(item) {
  return `${item.show_id}-S${item.next_season_number}E${item.next_episode_number}`;
}

export function notificationEmailHtml(item, message) {
  const showName = escapeHtml(item.show_name);
  const userName = escapeHtml(item.name || 'there');
  const episodeTitle = item.next_episode_title ? escapeHtml(item.next_episode_title) : '';
  const posterUrl = item.poster_path ? `https://image.tmdb.org/t/p/w342${item.poster_path}` : '';
  const manageUrl = 'https://bingekeeper.tv/';
  const preferencesUrl = 'https://bingekeeper.tv/';

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(message.subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:#0f0f13;color:#f0f0f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0f0f13;margin:0;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;max-width:560px;background:#1a1a22;border:1px solid rgba(255,255,255,0.10);border-radius:14px;overflow:hidden;">
            <tr>
              <td style="padding:22px 22px 10px;">
                <div style="font-size:24px;line-height:1.1;font-weight:800;color:#ffffff;">Binge<span style="color:#8b85ff;">Keeper</span></div>
                <div style="margin-top:8px;color:#33d6c7;font-size:12px;font-weight:700;text-transform:uppercase;">Release reminder</div>
              </td>
            </tr>
            ${posterUrl ? `<tr><td style="padding:8px 22px 0;"><img src="${posterUrl}" alt="${showName} poster" width="160" style="display:block;width:160px;max-width:42%;height:auto;border-radius:10px;border:1px solid rgba(255,255,255,0.12);"></td></tr>` : ''}
            <tr>
              <td style="padding:18px 22px 8px;">
                <h1 style="margin:0 0 10px;font-size:28px;line-height:1.15;color:#ffffff;">${showName}</h1>
                <p style="margin:0;color:#b9b8d4;font-size:16px;line-height:1.55;">Hi ${userName}, a show you track has a release coming up.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:10px 22px 18px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#242430;border:1px solid rgba(108,99,255,0.35);border-radius:12px;">
                  <tr>
                    <td style="padding:18px;text-align:left;">
                      <div style="color:#8b85ff;font-size:13px;font-weight:700;text-transform:uppercase;">Next release</div>
                      <div style="margin-top:6px;color:#ffffff;font-size:22px;line-height:1.25;font-weight:800;">${escapeHtml(message.episodeLabel)}</div>
                      ${episodeTitle ? `<div style="margin-top:6px;color:#f0f0f0;font-size:16px;line-height:1.4;">${episodeTitle}</div>` : ''}
                      <div style="margin-top:10px;color:#b9b8d4;font-size:15px;line-height:1.4;">Airs ${escapeHtml(message.airDate)}</div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:0 22px 22px;">
                <table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;">
                  <tr>
                    <td style="padding:0 0 10px;">
                      <a href="${manageUrl}" style="display:block;background:#6c63ff;color:#ffffff;text-decoration:none;text-align:center;border-radius:9px;padding:13px 16px;font-size:15px;font-weight:700;">Manage watchlist</a>
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <a href="${preferencesUrl}" style="display:block;color:#8b85ff;text-decoration:none;text-align:center;border-radius:9px;padding:10px 16px;font-size:14px;font-weight:700;">Manage notification preferences</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 22px 22px;border-top:1px solid rgba(255,255,255,0.08);">
                <p style="margin:0;color:#9999aa;font-size:12px;line-height:1.5;">You're receiving this because you track ${showName} on BingeKeeper.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function formatLongDate(date) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  });
}

function escapeHtml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function daysUntil(date) {
  const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  const target = new Date(`${date}T00:00:00Z`);
  return Math.round((target - today) / 86400000);
}
