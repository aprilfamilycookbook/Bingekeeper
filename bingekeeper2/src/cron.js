export async function handleCron(env) {
  console.log('Running nightly notification check...');

  // Get all shows that need checking (not checked in last 12 hours)
  const stale = await env.DB.prepare(`
    SELECT DISTINCT s.id FROM shows s
    JOIN watchlist w ON s.id = w.show_id
    WHERE w.notify = 1 AND s.last_checked < ?
  `).bind(Math.floor(Date.now() / 1000) - 43200).all();

  for (const show of stale.results) {
    await checkShowForUpdates(show.id, env);
    await new Promise(r => setTimeout(r, 300)); // rate limit
  }

  // Send notifications for shows with upcoming episodes
  const upcoming = await env.DB.prepare(`
    SELECT w.user_id, w.show_id, u.email, u.name, s.name as show_name,
           s.next_episode_date, s.next_season_number, s.next_episode_number
    FROM watchlist w
    JOIN users u ON w.user_id = u.id
    JOIN shows s ON w.show_id = s.id
    WHERE w.notify = 1 AND u.notify_email = 1
    AND s.next_episode_date IS NOT NULL
    AND s.next_episode_date BETWEEN date('now') AND date('now', '+2 days')
  `).all();

  for (const item of upcoming.results) {
    const episodeKey = `${item.show_id}-S${item.next_season_number}E${item.next_episode_number}`;

    // Check if already notified
    const alreadySent = await env.DB.prepare(`
      SELECT id FROM notifications_sent WHERE user_id=? AND show_id=? AND episode_key=?
    `).bind(item.user_id, item.show_id, episodeKey).first();

    if (!alreadySent) {
      await sendNotification(env, item);
      await env.DB.prepare(`
        INSERT INTO notifications_sent (user_id, show_id, episode_key) VALUES (?, ?, ?)
      `).bind(item.user_id, item.show_id, episodeKey).run();
    }
  }
}

async function checkShowForUpdates(showId, env) {
  try {
    const res = await fetch(
      `https://api.themoviedb.org/3/tv/${showId}?api_key=${env.TMDB_API_KEY}&language=en-US`
    );
    const data = await res.json();

    let nextDate = null, nextSeason = null, nextEpisode = null;

    if (data.next_episode_to_air) {
      nextDate = data.next_episode_to_air.air_date;
      nextSeason = data.next_episode_to_air.season_number;
      nextEpisode = data.next_episode_to_air.episode_number;
    }

    await env.DB.prepare(`
      UPDATE shows SET next_episode_date=?, next_season_number=?, next_episode_number=?, last_checked=?
      WHERE id=?
    `).bind(nextDate, nextSeason, nextEpisode, Math.floor(Date.now() / 1000), showId).run();
  } catch (e) {
    console.error(`Failed to check show ${showId}:`, e);
  }
}

async function sendNotification(env, item) {
  if (!env.RESEND_API_KEY) return;

  const isNewSeason = item.next_episode_number === 1;
  const subject = isNewSeason
    ? `🎬 New season of ${item.show_name} starts soon!`
    : `📺 New episode of ${item.show_name} tomorrow!`;

  const episodeLabel = isNewSeason
    ? `Season ${item.next_season_number} premiere`
    : `S${item.next_season_number} E${item.next_episode_number}`;

  const html = `
    <div style="font-family:-apple-system,sans-serif;max-width:500px;margin:0 auto;padding:24px">
      <div style="text-align:center;margin-bottom:24px">
        <h1 style="color:#378ADD;margin:0">📺 Bingekeeper</h1>
      </div>
      <h2 style="margin-top:0">Hey ${item.name}!</h2>
      <p style="font-size:16px;color:#444">
        <strong>${item.show_name}</strong> has a new episode coming up:
      </p>
      <div style="background:#f0f0f0;border-radius:12px;padding:16px;margin:16px 0;text-align:center">
        <div style="font-size:20px;font-weight:600;color:#1a1a1a">${episodeLabel}</div>
        <div style="color:#666;margin-top:4px">Airs ${item.next_episode_date}</div>
      </div>
      <p style="color:#666;font-size:14px">
        You're receiving this because you added this show to your Bingekeeper watchlist.
        <a href="https://bingekeeper.tv" style="color:#378ADD">Manage your watchlist</a>
      </p>
    </div>
  `;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Bingekeeper <hello@bingekeeper.tv>', to: item.email, subject, html })
  });
}
