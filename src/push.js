import { verifyJWT } from './auth.js';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

async function getUser(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return await verifyJWT(auth.slice(7), env.JWT_SECRET);
}

export async function handlePush(request, env, path) {
  const user = await getUser(request, env);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  if (path === '/api/push/config' && request.method === 'GET') {
    return jsonResponse({
      supported: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY),
      vapidPublicKey: env.VAPID_PUBLIC_KEY || ''
    });
  }

  if (path === '/api/push/subscribe' && request.method === 'POST') {
    const { subscription } = await request.json().catch(() => ({}));
    if (!isValidSubscription(subscription)) return jsonResponse({ error: 'Invalid push subscription' }, 400);
    await saveSubscription(env, user.userId, subscription, request.headers.get('User-Agent') || '');
    return jsonResponse({ message: 'Push notifications enabled' });
  }

  if (path === '/api/push/subscribe' && request.method === 'DELETE') {
    const { endpoint } = await request.json().catch(() => ({}));
    if (endpoint) {
      await env.DB.prepare('UPDATE push_subscriptions SET enabled = 0, updated_at = unixepoch() WHERE user_id = ? AND endpoint = ?').bind(user.userId, endpoint).run();
    } else {
      await env.DB.prepare('UPDATE push_subscriptions SET enabled = 0, updated_at = unixepoch() WHERE user_id = ?').bind(user.userId).run();
    }
    return jsonResponse({ message: 'Push notifications disabled' });
  }

  if (path === '/api/push/test' && request.method === 'POST') {
    const result = await sendPushToUser(env, user.userId, {
      title: 'BingeKeeper notifications are on',
      body: 'You will get alerts when tracked shows have new episodes or seasons.',
      url: '/'
    });
    if (!result.sent) return jsonResponse({ error: result.error || 'No active push subscriptions found' }, 400);
    return jsonResponse({ message: 'Test notification sent', sent: result.sent });
  }

  return jsonResponse({ error: 'Not found' }, 404);
}

export async function sendPushToUser(env, userId, payload) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return { sent: 0, error: 'Push is not configured' };

  const rows = await env.DB.prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ? AND enabled = 1').bind(userId).all();
  let sent = 0;
  for (const sub of rows.results || []) {
    const result = await sendWebPush(env, {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth }
    }, payload).catch(error => ({ ok: false, status: 0, error }));

    if (result.ok) {
      sent++;
    } else if ([404, 410].includes(result.status)) {
      await env.DB.prepare('UPDATE push_subscriptions SET enabled = 0, updated_at = unixepoch() WHERE id = ?').bind(sub.id).run();
    }
  }
  return { sent };
}

async function saveSubscription(env, userId, subscription, userAgent) {
  await env.DB.prepare(`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, enabled, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, unixepoch())
    ON CONFLICT(endpoint) DO UPDATE SET
      user_id = excluded.user_id,
      p256dh = excluded.p256dh,
      auth = excluded.auth,
      user_agent = excluded.user_agent,
      enabled = 1,
      updated_at = unixepoch()
  `).bind(userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, userAgent).run();
}

function isValidSubscription(subscription) {
  return Boolean(subscription?.endpoint && subscription?.keys?.p256dh && subscription?.keys?.auth);
}

async function sendWebPush(env, subscription, payload) {
  const body = JSON.stringify(payload);
  const encrypted = await encryptPushPayload(subscription, body);
  const vapidJwt = await createVapidJwt(env, new URL(subscription.endpoint).origin);
  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      TTL: '86400',
      Urgency: 'normal',
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      Authorization: `vapid t=${vapidJwt}, k=${env.VAPID_PUBLIC_KEY}`
    },
    body: encrypted
  });
  return { ok: response.ok, status: response.status };
}

async function createVapidJwt(env, audience) {
  const publicKey = base64UrlToBytes(env.VAPID_PUBLIC_KEY);
  const privateKey = env.VAPID_PRIVATE_KEY;
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: bytesToBase64Url(publicKey.slice(1, 33)),
    y: bytesToBase64Url(publicKey.slice(33, 65)),
    d: privateKey,
    ext: true
  };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const header = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: env.VAPID_SUBJECT || 'mailto:hello@bingekeeper.tv'
  })));
  const data = `${header}.${claims}`;
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(data)));
  return `${data}.${bytesToBase64Url(signature)}`;
}

async function encryptPushPayload(subscription, payload) {
  const userPublicKey = base64UrlToBytes(subscription.keys.p256dh);
  const authSecret = base64UrlToBytes(subscription.keys.auth);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const serverKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const serverPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', serverKeys.publicKey));
  const userPublicCryptoKey = await crypto.subtle.importKey('raw', userPublicKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: userPublicCryptoKey }, serverKeys.privateKey, 256));

  const prkKey = await hmac(authSecret, sharedSecret);
  const keyInfo = concatBytes(new TextEncoder().encode('WebPush: info\0'), userPublicKey, serverPublicRaw);
  const ikm = await hkdfExpand(prkKey, keyInfo, 32);
  const prk = await hmac(salt, ikm);
  const cek = await hkdfExpand(prk, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdfExpand(prk, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);
  const plaintext = concatBytes(new TextEncoder().encode(payload), new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plaintext));
  const rs = new Uint8Array([0, 0, 16, 0]);
  const idLen = new Uint8Array([serverPublicRaw.length]);
  return concatBytes(salt, rs, idLen, serverPublicRaw, ciphertext);
}

async function hmac(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, dataBytes));
}

async function hkdfExpand(prk, info, length) {
  const blocks = [];
  let previous = new Uint8Array();
  let counter = 1;
  while (concatBytes(...blocks).length < length) {
    previous = await hmac(prk, concatBytes(previous, info, new Uint8Array([counter++])));
    blocks.push(previous);
  }
  return concatBytes(...blocks).slice(0, length);
}

function concatBytes(...arrays) {
  const length = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}

function bytesToBase64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
