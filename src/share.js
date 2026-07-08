const SITE_URL = 'https://bingekeeper.tv';
const DEFAULT_IMAGE = `${SITE_URL}/images/social-share.png`;

export async function handleShare(request, env, path) {
  const match = path.match(/^\/share\/show\/(\d+)\/?$/);
  if (!match || request.method !== 'GET') return null;

  const tmdbId = match[1];
  const url = new URL(request.url);
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const tmdbApiKey = env.TMDB_API_KEY || env['TMDB_API_KEY '];
  const show = tmdbApiKey
    ? await fetchShow(tmdbApiKey, tmdbId).catch(() => null)
    : null;

  const html = shareHtml({
    show,
    tmdbId,
    canonicalUrl: `${SITE_URL}/share/show/${tmdbId}`,
    context: releaseContext(url.searchParams)
  });

  const response = new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=UTF-8',
      'Cache-Control': 'public, max-age=1800, s-maxage=21600'
    }
  });
  await cache.put(cacheKey, response.clone()).catch(() => null);
  return response;
}

async function fetchShow(apiKey, tmdbId) {
  const url = new URL(`https://api.themoviedb.org/3/tv/${tmdbId}`);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('language', 'en-US');
  const response = await fetch(url.toString());
  const data = await response.json();
  if (!response.ok || data.status_code === 7) throw new Error(data.status_message || 'TMDB request failed');
  return data;
}

function releaseContext(params) {
  const season = positiveNumber(params.get('season'));
  const episode = positiveNumber(params.get('episode'));
  const date = params.get('date') || '';
  const type = params.get('type') || '';

  let label = '';
  if (season && episode) label = `Season ${season}, Episode ${episode}`;
  else if (season) label = `Season ${season}`;
  else if (type === 'upcoming') label = 'Coming soon';

  return {
    season,
    episode,
    date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '',
    label
  };
}

function shareHtml({ show, tmdbId, canonicalUrl, context }) {
  const title = show?.name || 'Track this show on BingeKeeper';
  const image = imageUrl(show);
  const contextTitle = context.label ? `${title} ${context.label}` : title;
  const releaseLine = releaseSummary(context);
  const description = truncate(
    releaseLine
      ? `${releaseLine} ${show?.overview || 'Track this show and never miss a new episode or season.'}`
      : (show?.overview || 'Track this show and never miss a new episode or season.'),
    180
  );
  const poster = show?.poster_path ? `https://image.tmdb.org/t/p/w342${show.poster_path}` : '';
  const backdrop = show?.backdrop_path ? `https://image.tmdb.org/t/p/w1280${show.backdrop_path}` : image;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(contextTitle)} | BingeKeeper</title>
  <meta name="description" content="${esc(description)}">
  <link rel="canonical" href="${esc(canonicalUrl)}">
  <meta property="og:title" content="${esc(contextTitle)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${esc(canonicalUrl)}">
  <meta property="og:site_name" content="BingeKeeper">
  <meta property="og:image" content="${esc(image)}">
  <meta property="og:image:secure_url" content="${esc(image)}">
  <meta property="og:image:alt" content="${esc(`${title} on BingeKeeper`)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(contextTitle)}">
  <meta name="twitter:description" content="${esc(description)}">
  <meta name="twitter:image" content="${esc(image)}">
  <meta name="twitter:image:alt" content="${esc(`${title} on BingeKeeper`)}">
  <meta name="theme-color" content="#6c63ff">
  <style>
    :root { color-scheme: dark; --bg:#0f0f13; --panel:#1a1a22; --text:#f5f4ff; --muted:#b9b8d4; --purple:#6c63ff; --cyan:#33d6c7; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    .hero { min-height: 100vh; display: grid; place-items: center; padding: 28px 16px; background: linear-gradient(90deg, rgba(15,15,19,.95), rgba(15,15,19,.76)), url("${esc(backdrop)}") center/cover; }
    .shell { width: min(1040px, 100%); display: grid; grid-template-columns: minmax(0, 1fr) 240px; gap: 32px; align-items: center; }
    .brand { display: inline-flex; align-items: center; gap: 10px; color: var(--text); text-decoration: none; font-weight: 800; margin-bottom: 34px; }
    .brand img { width: 32px; height: 32px; border-radius: 8px; }
    .eyebrow { color: var(--cyan); font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; }
    h1 { margin: 12px 0 14px; font-size: clamp(36px, 7vw, 72px); line-height: .98; max-width: 780px; }
    p { color: var(--muted); font-size: 18px; line-height: 1.55; max-width: 680px; }
    .release { color: var(--text); font-weight: 800; }
    .cta { display: inline-block; margin-top: 18px; padding: 14px 18px; border-radius: 8px; background: var(--purple); color: white; text-decoration: none; font-weight: 800; }
    .poster { width: 100%; border-radius: 12px; box-shadow: 0 22px 60px rgba(0,0,0,.5); border: 1px solid rgba(255,255,255,.12); }
    .poster-fallback { aspect-ratio: 2 / 3; display: grid; place-items: center; border-radius: 12px; background: var(--panel); color: var(--muted); font-size: 48px; border: 1px solid rgba(255,255,255,.12); }
    @media (max-width: 760px) {
      .hero { align-items: start; padding-top: 22px; }
      .shell { grid-template-columns: 1fr; gap: 22px; }
      .poster, .poster-fallback { width: min(190px, 58vw); }
      .media { order: -1; }
      .brand { margin-bottom: 24px; }
    }
  </style>
</head>
<body>
  <main class="hero">
    <div class="shell">
      <section>
        <a class="brand" href="/">
          <img src="/images/logo.png" alt="">
          <span>BingeKeeper</span>
        </a>
        <div class="eyebrow">Show tracker</div>
        <h1>${esc(title)}</h1>
        ${releaseLine ? `<p class="release">${esc(releaseLine)}</p>` : ''}
        <p>${esc(show?.overview || 'Track this show and get reminded when new episodes or seasons are released.')}</p>
        <a class="cta" href="/?track=${encodeURIComponent(tmdbId)}">Track this show on BingeKeeper</a>
      </section>
      <aside class="media">
        ${poster ? `<img class="poster" src="${esc(poster)}" alt="${esc(`${title} poster`)}">` : '<div class="poster-fallback">TV</div>'}
      </aside>
    </div>
  </main>
</body>
</html>`;
}

function imageUrl(show) {
  if (show?.backdrop_path) return `https://image.tmdb.org/t/p/w1280${show.backdrop_path}`;
  if (show?.poster_path) return `https://image.tmdb.org/t/p/w780${show.poster_path}`;
  return DEFAULT_IMAGE;
}

function releaseSummary(context) {
  const date = context.date ? formatDate(context.date) : '';
  if (context.label && date) return `${context.label} arrives ${date}.`;
  if (context.label) return `${context.label} is ready to track.`;
  if (date) return `New release arrives ${date}.`;
  return '';
}

function formatDate(value) {
  return new Date(`${value}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  });
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function truncate(value, length) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= length) return text;
  return `${text.slice(0, length - 1).trim()}...`;
}

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
