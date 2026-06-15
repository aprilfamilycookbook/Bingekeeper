import { handleAuth } from './auth.js';
import { handleWatchlist } from './watchlist.js';
import { handleSearch } from './search.js';
import { handleCron } from './cron.js';
import { handleBilling, handleStripeWebhook } from './billing.js';
import { handleAdmin } from './admin.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    let response;

    if (path === '/api/stripe/webhook') {
      response = await handleStripeWebhook(request, env);
    } else if (path.startsWith('/api/auth/')) {
      response = await handleAuth(request, env, path);
    } else if (path.startsWith('/api/billing/')) {
      response = await handleBilling(request, env, path);
    } else if (path.startsWith('/api/admin/')) {
      response = await handleAdmin(request, env, path);
    } else if (path.startsWith('/api/watchlist')) {
      response = await handleWatchlist(request, env, path);
    } else if (path.startsWith('/api/search')) {
      response = await handleSearch(request, env, url);
    } else if (!path.startsWith('/api/')) {
      if (request.method === 'GET' && !path.split('/').pop().includes('.')) {
        const indexUrl = new URL('/index.html', request.url);
        return env.ASSETS.fetch(new Request(indexUrl, request));
      }

      const assetResponse = await env.ASSETS.fetch(request);
      if (assetResponse.status !== 404 || request.method !== 'GET') {
        return assetResponse;
      }

      const indexUrl = new URL('/index.html', request.url);
      return env.ASSETS.fetch(new Request(indexUrl, request));
    } else {
      response = new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
    }

    const newHeaders = new Headers(response.headers);
    Object.entries(corsHeaders).forEach(([k, v]) => newHeaders.set(k, v));
    return new Response(response.body, { status: response.status, headers: newHeaders });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleCron(env));
  }
};
