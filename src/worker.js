export default {
  async fetch(request, env) {
      const url = new URL(request.url);

          const headers = {
                'Access-Control-Allow-Origin': '*',
                      'Content-Type': 'application/json',
                          };

                              if (url.pathname === '/api/search') {
                                    const q = url.searchParams.get('q');
                                          if (!q) {
                                                  return new Response(JSON.stringify({ error: 'Missing search query' }), { status: 400, headers });
                                                        }

                                                              try {
                                                                      const tmdbRes = await fetch(
                                                                                `https://api.themoviedb.org/3/search/tv?api_key=${env.TMDB_API_KEY}&query=${encodeURIComponent(q)}&language=en-US&page=1`
                                                                                        );
                                                                                                const data = await tmdbRes.json();

                                                                                                        if (data.status_code === 7) {
                                                                                                                  return new Response(JSON.stringify({ error: 'Invalid TMDB API key.' }), { status: 401, headers });
                                                                                                                          }
                                                                                                                          
                                                                                                                                  return new Response(JSON.stringify({ results: data.results || [] }), { headers });
                                                                                                                                        } catch (err) {
                                                                                                                                                return new Response(JSON.stringify({ error: 'Search failed. Please try again.' }), { status: 500, headers });
                                                                                                                                                      }
                                                                                                                                                          }
                                                                                                                                                          
                                                                                                                                                              return env.ASSETS.fetch(request);
                                                                                                                                                                }
                                                                                                                                                                };
