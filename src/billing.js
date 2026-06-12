import { verifyJWT } from './auth.js';

const SITE_URL = 'https://bingekeeper.tv';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function getUser(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return await verifyJWT(auth.slice(7), env.JWT_SECRET);
}

async function stripeRequest(env, path, body) {
  if (!env.STRIPE_SECRET_KEY) throw new Error('Missing STRIPE_SECRET_KEY');
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Stripe request failed');
  return data;
}

export async function handleBilling(request, env, path) {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
  const tokenUser = await getUser(request, env);
  if (!tokenUser) return jsonResponse({ error: 'Unauthorized' }, 401);

  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(tokenUser.userId).first();
  if (!user) return jsonResponse({ error: 'User not found' }, 404);

  if (path === '/api/billing/checkout') {
    if (!env.STRIPE_PLUS_PRICE_ID) return jsonResponse({ error: 'Missing STRIPE_PLUS_PRICE_ID' }, 500);

    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripeRequest(env, '/customers', {
        email: user.email,
        name: user.name,
        'metadata[user_id]': String(user.id)
      });
      customerId = customer.id;
      await env.DB.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').bind(customerId, user.id).run();
    }

    const session = await stripeRequest(env, '/checkout/sessions', {
      mode: 'subscription',
      customer: customerId,
      client_reference_id: String(user.id),
      success_url: `${SITE_URL}/#billing=success`,
      cancel_url: `${SITE_URL}/#billing=cancelled`,
      'line_items[0][price]': env.STRIPE_PLUS_PRICE_ID,
      'line_items[0][quantity]': '1',
      'metadata[user_id]': String(user.id),
      'subscription_data[metadata][user_id]': String(user.id)
    });
    return jsonResponse({ url: session.url });
  }

  if (path === '/api/billing/portal') {
    if (!user.stripe_customer_id) return jsonResponse({ error: 'No billing account yet' }, 400);
    const session = await stripeRequest(env, '/billing_portal/sessions', {
      customer: user.stripe_customer_id,
      return_url: SITE_URL
    });
    return jsonResponse({ url: session.url });
  }

  return jsonResponse({ error: 'Not found' }, 404);
}

export async function handleStripeWebhook(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
  const rawBody = await request.text();
  const signature = request.headers.get('Stripe-Signature') || '';
  const valid = await verifyStripeSignature(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return jsonResponse({ error: 'Invalid signature' }, 400);

  const event = JSON.parse(rawBody);
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.client_reference_id || session.metadata?.user_id;
    if (userId) {
      await env.DB.prepare(`UPDATE users SET plan = 'plus', stripe_customer_id = ?, stripe_subscription_id = ?, subscription_status = 'active' WHERE id = ?`)
        .bind(session.customer, session.subscription, userId).run();
    }
  }

  if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const isPlus = ['active', 'trialing'].includes(subscription.status);
    await env.DB.prepare(`UPDATE users SET plan = ?, stripe_subscription_id = ?, subscription_status = ? WHERE stripe_customer_id = ?`)
      .bind(isPlus ? 'plus' : 'free', subscription.id, subscription.status, subscription.customer).run();
  }

  return jsonResponse({ received: true });
}

async function verifyStripeSignature(payload, header, secret) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(header.split(',').map(part => {
    const [key, value] = part.split('=');
    return [key, value];
  }));
  if (!parts.t || !parts.v1) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${parts.t}.${payload}`));
  const expected = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  return timingSafeEqual(expected, parts.v1);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}
