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
