export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/search')) {
      const q = url.searchParams.get('q');
      if (!q) return new Response(JSON.stringify({ error: 'Missing query' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
      try {
        const res = await fetch(
          `https://api.themoviedb.org/3/search/tv?api_key=${env.TMDB_API_KEY}&query=${encodeURIComponent(q)}&language=en-US`
        );
        const data = await res.json();
        return new Response(JSON.stringify({ results: data.results || [] }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch(e) {
        return new Response(JSON.stringify({ error: 'Search failed' }), {
          status: 500, headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    return env.ASSETS.fetch(request);
  }
};