import { verifyJWT } from './auth.js';

const EXPECTED_SERVICE_WORKER_VERSION = 'bingekeeper-sw-v16';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

async function getUser(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return await verifyJWT(auth.slice(7), env.JWT_SECRET);
}

export async function handlePush(request, env, path) {
  if (path === '/api/push/ack' && request.method === 'POST') {
    const { token, stage } = await request.json().catch(() => ({}));
    const ack = await verifyAckToken(env, token);
    if (!ack || !['received', 'displayed'].includes(stage)) return jsonResponse({ error: 'Invalid acknowledgement' }, 400);
    await recordServiceWorkerAck(env, ack, stage);
    return jsonResponse({ ok: true });
  }

  const user = await getUser(request, env);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  if (path === '/api/push/config' && request.method === 'GET') {
    return jsonResponse({
      supported: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY),
      vapidPublicKey: env.VAPID_PUBLIC_KEY || '',
      expectedServiceWorkerVersion: EXPECTED_SERVICE_WORKER_VERSION
    });
  }

  if (path === '/api/push/subscribe' && request.method === 'POST') {
    await ensurePushDiagnosticsColumns(env);
    const { subscription, device_id } = await request.json().catch(() => ({}));
    if (!isValidSubscription(subscription)) return jsonResponse({ error: 'Invalid push subscription' }, 400);
    await saveSubscription(env, user.userId, subscription, request.headers.get('User-Agent') || '', normalizeDeviceId(device_id));
    return jsonResponse({ message: 'Push notifications enabled' });
  }

  if (path === '/api/push/subscribe' && request.method === 'DELETE') {
    await ensurePushDiagnosticsColumns(env);
    const { endpoint, device_id } = await request.json().catch(() => ({}));
    if (endpoint) {
      await env.DB.prepare('UPDATE push_subscriptions SET enabled = 0, updated_at = unixepoch() WHERE user_id = ? AND endpoint = ?').bind(user.userId, endpoint).run();
    } else if (device_id) {
      await env.DB.prepare('UPDATE push_subscriptions SET enabled = 0, updated_at = unixepoch() WHERE user_id = ? AND device_id = ?').bind(user.userId, normalizeDeviceId(device_id)).run();
    } else {
      await env.DB.prepare('UPDATE push_subscriptions SET enabled = 0, updated_at = unixepoch() WHERE user_id = ?').bind(user.userId).run();
    }
    return jsonResponse({ message: 'Push notifications disabled' });
  }

  if (path === '/api/push/test' && request.method === 'POST') {
    await ensurePushDiagnosticsColumns(env);
    const { endpoint } = await request.json().catch(() => ({}));
    const result = await sendPushToUser(env, user.userId, {
      title: 'BingeKeeper notifications are on',
      body: 'You will get alerts when tracked shows have new episodes or seasons.',
      url: '/',
      test_id: crypto.randomUUID()
    }, {
      endpoint,
      source: 'manual_test'
    });
    if (!result.sent) return jsonResponse({ error: result.error || 'No active push subscriptions found' }, 400);
    return jsonResponse({
      message: 'Test notification sent',
      test_id: result.testId,
      sent: result.sent,
      attempted: result.attempted,
      failed: result.failed
    });
  }

  if (path === '/api/push/diagnostics' && request.method === 'GET') {
    await ensurePushDiagnosticsColumns(env);
    const currentEndpoint = new URL(request.url).searchParams.get('endpoint') || '';
    const rows = await env.DB.prepare(`
      SELECT endpoint, enabled, last_success_at, last_failure_at, last_failure_status, last_failure_reason
      FROM push_subscriptions
      WHERE user_id = ?
      ORDER BY updated_at DESC
    `).bind(user.userId).all();
    const subscriptions = rows.results || [];
    const activeSubscriptions = subscriptions.filter(sub => Number(sub.enabled) === 1);
    const lastFailure = subscriptions
      .filter(sub => sub.last_failure_at)
      .sort((a, b) => Number(b.last_failure_at || 0) - Number(a.last_failure_at || 0))[0] || null;
    const lastSuccess = subscriptions
      .filter(sub => sub.last_success_at)
      .sort((a, b) => Number(b.last_success_at || 0) - Number(a.last_success_at || 0))[0] || null;
    const currentSubscription = currentEndpoint
      ? subscriptions.find(sub => sub.endpoint === currentEndpoint) || null
      : null;

    return jsonResponse({
      vapid_public_key_exists: Boolean(env.VAPID_PUBLIC_KEY),
      vapid_private_key_exists: Boolean(env.VAPID_PRIVATE_KEY),
      vapid_subject_exists: Boolean(env.VAPID_SUBJECT),
      active_subscription_count: activeSubscriptions.length,
      endpoint_origins: [...new Set(activeSubscriptions.map(sub => endpointOrigin(sub.endpoint)).filter(Boolean))],
      current_device_subscription_exists: Boolean(currentSubscription),
      current_device_subscription_enabled: Boolean(currentSubscription && Number(currentSubscription.enabled) === 1),
      last_success_at: lastSuccess?.last_success_at || null,
      last_failure_status: lastFailure?.last_failure_status || null,
      last_failure_reason: lastFailure?.last_failure_reason || null,
      last_failure_at: lastFailure?.last_failure_at || null,
      expected_service_worker_version: EXPECTED_SERVICE_WORKER_VERSION
    });
  }

  return jsonResponse({ error: 'Not found' }, 404);
}

export async function sendPushToUser(env, userId, payload, options = {}) {
  await ensureNotificationDeliverySchema(env);
  const testId = payload.test_id || options.testId || '';
  const source = options.source || 'scheduled';
  const showId = options.showId || null;
  const episodeKey = options.episodeKey || null;
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    await recordNotificationAttempt(env, {
      test_id: testId,
      source,
      user_id: userId,
      show_id: showId,
      episode_key: episodeKey,
      channel: 'push',
      success: 0,
      failure_reason: 'Push is not configured'
    });
    return { sent: 0, attempted: 0, failed: [], attempts: [], error: 'Push is not configured', testId };
  }

  const endpointFilter = options.endpoint || '';
  const subscriptionId = Number(options.subscriptionId || 0);
  const rows = await activeSubscriptions(env, userId, { endpoint: endpointFilter, subscriptionId });
  let sent = 0;
  const failed = [];
  const attempts = [];
  const subscriptions = rows.results || [];
  if (testId) payload.test_id = testId;

  if (!subscriptions.length) {
    const reason = endpointFilter || subscriptionId ? 'Selected push subscription is not active' : 'No active push subscriptions found';
    await recordNotificationAttempt(env, {
      test_id: testId,
      source,
      user_id: userId,
      show_id: showId,
      episode_key: episodeKey,
      channel: 'push',
      success: 0,
      failure_reason: reason
    });
    return { sent: 0, attempted: 0, failed, attempts, error: reason, testId };
  }

  for (const sub of subscriptions) {
    const perSubscriptionPayload = {
      ...payload,
      subscription_id: sub.id,
      ack_token: testId ? await createAckToken(env, { test_id: testId, user_id: userId, subscription_id: sub.id }) : ''
    };
    const result = await sendWebPush(env, {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth }
    }, perSubscriptionPayload, options).catch(error => ({ ok: false, status: 0, error }));

    const attempt = {
      test_id: testId,
      source,
      user_id: userId,
      show_id: showId,
      episode_key: episodeKey,
      channel: 'push',
      subscription_id: sub.id,
      device_id: sub.device_id || null,
      device: safeDeviceLabel(sub.user_agent, sub.device_id),
      provider_status: result.status || 0,
      success: result.ok ? 1 : 0,
      failure_reason: result.ok ? '' : String(result.error?.message || result.error || result.body || 'Push service rejected the notification').slice(0, 220)
    };
    await recordNotificationAttempt(env, attempt);
    attempts.push(attempt);

    if (result.ok) {
      sent++;
      await recordPushSuccess(env, sub.id);
    } else if ([404, 410].includes(result.status)) {
      const reason = 'Expired browser subscription';
      await recordPushFailure(env, sub.id, result.status, reason, true);
      failed.push({ endpoint_origin: endpointOrigin(sub.endpoint), status: result.status, reason });
    } else {
      const reason = String(result.error?.message || result.error || result.body || 'Push service rejected the notification').slice(0, 220);
      await recordPushFailure(env, sub.id, result.status || 0, reason, false);
      failed.push({ endpoint_origin: endpointOrigin(sub.endpoint), status: result.status || 0, reason });
    }
  }
  const error = sent ? '' : pushFailureMessage(failed, subscriptions.length);
  return { sent, attempted: subscriptions.length, failed, attempts, error, testId };
}

async function activeSubscriptions(env, userId, filters = {}) {
  const clauses = ['user_id = ?', 'enabled = 1'];
  const params = [userId];
  if (filters.endpoint) {
    clauses.push('endpoint = ?');
    params.push(filters.endpoint);
  }
  if (filters.subscriptionId) {
    clauses.push('id = ?');
    params.push(filters.subscriptionId);
  }

  try {
    return await env.DB.prepare(`
      SELECT id, endpoint, p256dh, auth, user_agent, device_id
      FROM push_subscriptions
      WHERE ${clauses.join(' AND ')}
      ORDER BY updated_at DESC
    `).bind(...params).all();
  } catch {
    return await env.DB.prepare(`
      SELECT id, endpoint, p256dh, auth, user_agent, NULL AS device_id
      FROM push_subscriptions
      WHERE ${clauses.join(' AND ')}
      ORDER BY updated_at DESC
    `).bind(...params).all();
  }
}

async function saveSubscription(env, userId, subscription, userAgent, deviceId) {
  try {
    await env.DB.prepare(`
      INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, device_id, enabled, last_failure_status, last_failure_reason, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, NULL, NULL, unixepoch())
      ON CONFLICT(endpoint) DO UPDATE SET
        user_id = excluded.user_id,
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        user_agent = excluded.user_agent,
        device_id = excluded.device_id,
        enabled = 1,
        last_failure_status = NULL,
        last_failure_reason = NULL,
        updated_at = unixepoch()
    `).bind(userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, userAgent, deviceId).run();

    if (deviceId) {
      await env.DB.prepare(`
        UPDATE push_subscriptions
        SET enabled = 0,
            last_failure_reason = 'Replaced by newer subscription on same device',
            updated_at = unixepoch()
        WHERE user_id = ? AND device_id = ? AND endpoint != ? AND enabled = 1
      `).bind(userId, deviceId, subscription.endpoint).run();
    }
  } catch {
    await env.DB.prepare(`
      INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, enabled, last_failure_status, last_failure_reason, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, NULL, NULL, unixepoch())
      ON CONFLICT(endpoint) DO UPDATE SET
        user_id = excluded.user_id,
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        user_agent = excluded.user_agent,
        enabled = 1,
        last_failure_status = NULL,
        last_failure_reason = NULL,
        updated_at = unixepoch()
    `).bind(userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, userAgent).run();
  }
}

function isValidSubscription(subscription) {
  return Boolean(subscription?.endpoint && subscription?.keys?.p256dh && subscription?.keys?.auth);
}

async function sendWebPush(env, subscription, payload, options = {}) {
  const vapidJwt = await createVapidJwt(env, new URL(subscription.endpoint).origin);
  const headers = {
    TTL: '86400',
    Urgency: 'normal',
    Authorization: `vapid t=${vapidJwt}, k=${env.VAPID_PUBLIC_KEY}`
  };
  let body;
  if (!options.noPayload) {
    body = await encryptPushPayload(subscription, JSON.stringify(payload));
    headers['Content-Encoding'] = 'aes128gcm';
    headers['Content-Type'] = 'application/octet-stream';
  }
  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers,
    body
  });
  const responseBody = response.ok ? '' : await response.text().catch(() => '');
  return { ok: response.ok, status: response.status, body: responseBody.slice(0, 220) };
}

async function recordPushSuccess(env, subscriptionId) {
  await env.DB.prepare(`
    UPDATE push_subscriptions
    SET last_success_at = unixepoch(),
        last_failure_status = NULL,
        last_failure_reason = NULL,
        updated_at = unixepoch()
    WHERE id = ?
  `).bind(subscriptionId).run();
}

async function recordPushFailure(env, subscriptionId, status, reason, disable) {
  await env.DB.prepare(`
    UPDATE push_subscriptions
    SET enabled = CASE WHEN ? THEN 0 ELSE enabled END,
        last_failure_at = unixepoch(),
        last_failure_status = ?,
        last_failure_reason = ?,
        updated_at = unixepoch()
    WHERE id = ?
  `).bind(disable ? 1 : 0, Number(status || 0), String(reason || '').slice(0, 220), subscriptionId).run();
}

async function ensurePushDiagnosticsColumns(env) {
  const columns = await env.DB.prepare('PRAGMA table_info(push_subscriptions)').all();
  const existing = new Set((columns.results || []).map(column => column.name));
  const missing = [
    ['last_success_at', 'ALTER TABLE push_subscriptions ADD COLUMN last_success_at INTEGER'],
    ['last_failure_at', 'ALTER TABLE push_subscriptions ADD COLUMN last_failure_at INTEGER'],
    ['last_failure_status', 'ALTER TABLE push_subscriptions ADD COLUMN last_failure_status INTEGER'],
    ['last_failure_reason', 'ALTER TABLE push_subscriptions ADD COLUMN last_failure_reason TEXT']
  ].filter(([name]) => !existing.has(name));

  for (const [, sql] of missing) {
    await env.DB.prepare(sql).run().catch(() => null);
  }
}

export async function ensureNotificationDeliverySchema(env) {
  await ensurePushDiagnosticsColumns(env);
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS notification_delivery_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      test_id TEXT,
      source TEXT,
      user_id INTEGER NOT NULL,
      show_id INTEGER,
      episode_key TEXT,
      channel TEXT NOT NULL,
      subscription_id INTEGER,
      device_id TEXT,
      device TEXT,
      attempted_at INTEGER DEFAULT (unixepoch()),
      provider_status INTEGER,
      success INTEGER DEFAULT 0,
      failure_reason TEXT,
      fallback_attempted INTEGER DEFAULT 0,
      notifications_sent_written INTEGER DEFAULT 0,
      sw_received_at INTEGER,
      sw_displayed_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    )
  `).run();
  const attemptColumns = await env.DB.prepare('PRAGMA table_info(notification_delivery_attempts)').all();
  const existingAttemptColumns = new Set((attemptColumns.results || []).map(column => column.name));
  const missingAttemptColumns = [
    ['sw_received_at', 'ALTER TABLE notification_delivery_attempts ADD COLUMN sw_received_at INTEGER'],
    ['sw_displayed_at', 'ALTER TABLE notification_delivery_attempts ADD COLUMN sw_displayed_at INTEGER']
  ].filter(([name]) => !existingAttemptColumns.has(name));
  for (const [, sql] of missingAttemptColumns) {
    await env.DB.prepare(sql).run().catch(() => null);
  }
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_notification_delivery_attempts_recent ON notification_delivery_attempts(attempted_at DESC)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_notification_delivery_attempts_user_episode ON notification_delivery_attempts(user_id, show_id, episode_key)').run();
}

export async function recordNotificationAttempt(env, attempt) {
  await ensureNotificationDeliverySchema(env);
  await env.DB.prepare(`
    INSERT INTO notification_delivery_attempts (
      test_id, source, user_id, show_id, episode_key, channel, subscription_id, device_id, device,
      provider_status, success, failure_reason, fallback_attempted, notifications_sent_written
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    attempt.test_id || null,
    attempt.source || 'scheduled',
    attempt.user_id,
    attempt.show_id || null,
    attempt.episode_key || null,
    attempt.channel,
    attempt.subscription_id || null,
    attempt.device_id || null,
    attempt.device || null,
    Number(attempt.provider_status || 0),
    attempt.success ? 1 : 0,
    String(attempt.failure_reason || '').slice(0, 220) || null,
    attempt.fallback_attempted ? 1 : 0,
    attempt.notifications_sent_written ? 1 : 0
  ).run();
}

export async function markFallbackAttempted(env, context) {
  await ensureNotificationDeliverySchema(env);
  await env.DB.prepare(`
    UPDATE notification_delivery_attempts
    SET fallback_attempted = 1
    WHERE user_id = ?
      AND COALESCE(show_id, 0) = COALESCE(?, 0)
      AND COALESCE(episode_key, '') = COALESCE(?, '')
      AND COALESCE(test_id, '') = COALESCE(?, '')
      AND channel = 'push'
  `).bind(context.user_id, context.show_id || null, context.episode_key || null, context.test_id || null).run();
}

export async function markNotificationsSentWritten(env, context) {
  await ensureNotificationDeliverySchema(env);
  await env.DB.prepare(`
    UPDATE notification_delivery_attempts
    SET notifications_sent_written = 1
    WHERE user_id = ?
      AND COALESCE(show_id, 0) = COALESCE(?, 0)
      AND COALESCE(episode_key, '') = COALESCE(?, '')
      AND success = 1
  `).bind(context.user_id, context.show_id || null, context.episode_key || null).run();
}

async function recordServiceWorkerAck(env, ack, stage) {
  await ensureNotificationDeliverySchema(env);
  const column = stage === 'received' ? 'sw_received_at' : 'sw_displayed_at';
  await env.DB.prepare(`
    UPDATE notification_delivery_attempts
    SET ${column} = unixepoch()
    WHERE COALESCE(test_id, '') = ?
      AND user_id = ?
      AND subscription_id = ?
      AND channel = 'push'
  `).bind(ack.test_id || '', ack.user_id, ack.subscription_id).run();
  console.log(JSON.stringify({ event: 'push_service_worker_ack', stage, test_id: ack.test_id, user_id: ack.user_id, subscription_id: ack.subscription_id }));
}

function endpointOrigin(endpoint) {
  try {
    return new URL(endpoint).origin;
  } catch {
    return '';
  }
}

function normalizeDeviceId(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || null;
}

function safeDeviceLabel(userAgent, deviceId) {
  const ua = String(userAgent || '').replace(/\s+/g, ' ').slice(0, 120);
  const id = deviceId ? `device ${String(deviceId).slice(0, 8)}` : 'unknown device';
  return ua ? `${id} - ${ua}` : id;
}

async function createAckToken(env, payload) {
  if (!env.JWT_SECRET) return '';
  const body = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `${body}.${bytesToBase64Url(new Uint8Array(sig))}`;
}

async function verifyAckToken(env, token) {
  if (!env.JWT_SECRET || !token) return null;
  try {
    const [body, sig] = String(token).split('.');
    if (!body || !sig) return null;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('HMAC', key, base64UrlToBytes(sig), new TextEncoder().encode(body));
    if (!valid) return null;
    const data = JSON.parse(new TextDecoder().decode(base64UrlToBytes(body)));
    if (!data.test_id || !data.user_id || !data.subscription_id) return null;
    return {
      test_id: String(data.test_id),
      user_id: Number(data.user_id),
      subscription_id: Number(data.subscription_id)
    };
  } catch {
    return null;
  }
}

function pushFailureMessage(failed, subscriptionCount) {
  if (!subscriptionCount) return 'No active push subscriptions found';
  const first = failed[0];
  if (!first) return 'Push notification was not delivered';
  if (first.status === 401 || first.status === 403) return 'Push provider rejected the VAPID keys. Disable and re-enable notifications, then try again.';
  if (first.status === 404 || first.status === 410) return 'This browser subscription expired. Re-enable notifications on this device.';
  if (first.status === 400) return 'Push provider rejected the notification payload. Please try re-enabling notifications.';
  return `Push provider returned ${first.status || 'an error'}. Please try re-enabling notifications.`;
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
