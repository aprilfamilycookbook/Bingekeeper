async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function base64UrlEncode(value) {
  const raw = typeof value === 'string' ? value : String.fromCharCode(...new Uint8Array(value));
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  return atob(padded);
}

function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateReferralCode() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(36).padStart(2, '0')).join('').slice(0, 10);
}

const OAUTH_PROVIDERS = {
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
    scope: 'openid email profile',
    clientIdEnv: 'GOOGLE_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_CLIENT_SECRET'
  }
  // Facebook can be added later with the same start/callback shape.
};

const TURNSTILE_SITE_KEY = '0x4AAAAAADlYKalja0cX172h';
const FREE_SHOW_BASE_LIMIT = 10;
const FREE_SHOW_REFERRAL_CAP = 25;
const REFERRAL_BONUS_SLOTS = 5;

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function verifyTurnstile(env, token, request, expectedAction) {
  if (!env.TURNSTILE_SECRET_KEY) {
    return { ok: false, error: 'Security check is not available right now. Please try again soon.' };
  }

  if (!token) {
    return { ok: false, error: 'Please complete the security check before continuing.' };
  }

  try {
    const body = new URLSearchParams({
      secret: env.TURNSTILE_SECRET_KEY,
      response: token
    });
    const remoteIp = request.headers.get('CF-Connecting-IP');
    if (remoteIp) body.set('remoteip', remoteIp);

    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.success) {
      return { ok: false, error: 'Security check failed. Please refresh and try again.' };
    }

    if (expectedAction && result.action && result.action !== expectedAction) {
      return { ok: false, error: 'Security check failed. Please refresh and try again.' };
    }

    return { ok: true };
  } catch {
    return { ok: false, error: 'Security check failed. Please refresh and try again.' };
  }
}

async function createJWT(userId, email, secret) {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({ userId, email, exp: Math.floor(Date.now() / 1000) + 86400 * 30 }));
  const sigInput = `${header}.${payload}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(sigInput));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return `${sigInput}.${sigB64}`;
}

export async function verifyJWT(token, secret) {
  try {
    const [header, payload, sig] = token.split('.');
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('HMAC', key, Uint8Array.from(atob(sig), c => c.charCodeAt(0)), encoder.encode(`${header}.${payload}`));
    if (!valid) return null;
    const data = JSON.parse(atob(payload));
    if (data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

export async function handleAuth(request, env, path) {
  const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};

  if (path === '/api/auth/config' && request.method === 'GET') {
    return jsonResponse({ turnstileSiteKey: env.TURNSTILE_SITE_KEY || TURNSTILE_SITE_KEY });
  }

  if ((path === '/auth/google/start' || path === '/api/auth/google/start') && request.method === 'GET') {
    return startOAuth(request, env, 'google');
  }

  if ((path === '/auth/google/callback' || path === '/api/auth/google/callback') && request.method === 'GET') {
    return finishOAuth(request, env, 'google');
  }

  if (path === '/api/auth/me' && request.method === 'GET') {
    const auth = request.headers.get('Authorization');
    if (!auth || !auth.startsWith('Bearer ')) return jsonResponse({ error: 'Unauthorized' }, 401);
    const tokenUser = await verifyJWT(auth.slice(7), env.JWT_SECRET);
    if (!tokenUser) return jsonResponse({ error: 'Unauthorized' }, 401);
    const user = await getUserById(env, tokenUser.userId);
    if (!user) return jsonResponse({ error: 'User not found' }, 404);
    return jsonResponse({ user: await buildPublicUser(env, user) });
  }

  if (path === '/api/auth/account' && request.method === 'DELETE') {
    const auth = request.headers.get('Authorization');
    if (!auth || !auth.startsWith('Bearer ')) return jsonResponse({ error: 'Unauthorized' }, 401);
    const tokenUser = await verifyJWT(auth.slice(7), env.JWT_SECRET);
    if (!tokenUser) return jsonResponse({ error: 'Unauthorized' }, 401);
    await env.DB.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').bind(tokenUser.userId).run();
    await env.DB.prepare('DELETE FROM notifications_sent WHERE user_id = ?').bind(tokenUser.userId).run();
    await env.DB.prepare('DELETE FROM watchlist WHERE user_id = ?').bind(tokenUser.userId).run();
    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(tokenUser.userId).run();
    return jsonResponse({ message: 'Account deleted' });
  }

  if (path === '/api/auth/register' && request.method === 'POST') {
    const { email, password, name, turnstileToken, referralCode } = body;
    if (!email || !password || !name) return jsonResponse({ error: 'All fields required' }, 400);
    if (password.length < 8) return jsonResponse({ error: 'Password must be at least 8 characters' }, 400);
    const turnstile = await verifyTurnstile(env, turnstileToken, request, 'register');
    if (!turnstile.ok) return jsonResponse({ error: turnstile.error }, 400);
    const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email.toLowerCase()).first();
    if (existing) return jsonResponse({ error: 'Email already registered' }, 409);
    const hash = await hashPassword(password);
    const token = generateToken();
    const newReferralCode = await uniqueReferralCode(env);
    await env.DB.prepare('INSERT INTO users (email, password_hash, name, verify_token, referral_code) VALUES (?, ?, ?, ?, ?)').bind(email.toLowerCase(), hash, name, token, newReferralCode).run();
    const created = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email.toLowerCase()).first();
    if (created?.id) await recordReferral(env, referralCode, created.id);
    const verifyUrl = `https://bingekeeper.tv/#verify?token=${token}`;
    await sendEmail(env, email, 'Verify your Bingekeeper account', `<h2>Welcome to Bingekeeper, ${name}!</h2><p>Click below to verify your email:</p><a href="${verifyUrl}" style="background:#378ADD;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block">Verify Email</a>`);
    return jsonResponse({ message: 'Account created! Check your email to verify.' });
  }

  if (path === '/api/auth/login' && request.method === 'POST') {
    const { email, password } = body;
    if (!email || !password) return jsonResponse({ error: 'Email and password required' }, 400);
    const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email.toLowerCase()).first();
    if (!user) return jsonResponse({ error: 'Invalid email or password' }, 401);
    const hash = await hashPassword(password);
    if (hash !== user.password_hash) return jsonResponse({ error: 'Invalid email or password' }, 401);
    if (!user.verified) return jsonResponse({ error: 'Please verify your email first. Check your inbox.' }, 403);
    const jwt = await createJWT(user.id, user.email, env.JWT_SECRET);
    return jsonResponse({ token: jwt, user: await buildPublicUser(env, user) });
  }

  if (path === '/api/auth/verify' && request.method === 'POST') {
    const { token } = body;
    const user = await env.DB.prepare('SELECT id FROM users WHERE verify_token = ?').bind(token).first();
    if (!user) return jsonResponse({ error: 'Invalid or expired token' }, 400);
    await env.DB.prepare('UPDATE users SET verified = 1, verify_token = NULL WHERE id = ?').bind(user.id).run();
    return jsonResponse({ message: 'Email verified! You can now log in.' });
  }

  if (path === '/api/auth/forgot' && request.method === 'POST') {
    const { email, turnstileToken } = body;
    if (!email) return jsonResponse({ error: 'Please enter your email' }, 400);
    const turnstile = await verifyTurnstile(env, turnstileToken, request, 'password_reset');
    if (!turnstile.ok) return jsonResponse({ error: turnstile.error }, 400);
    const user = await env.DB.prepare('SELECT id, name FROM users WHERE email = ?').bind(email.toLowerCase()).first();
    if (!user) return jsonResponse({ message: 'If that email exists, a reset link has been sent.' });
    const token = generateToken();
    const expires = Math.floor(Date.now() / 1000) + 3600;
    await env.DB.prepare('UPDATE users SET reset_token = ?, reset_expires = ? WHERE id = ?').bind(token, expires, user.id).run();
    const resetUrl = `https://bingekeeper.tv/#reset?token=${token}`;
    await sendEmail(env, email, 'Reset your Bingekeeper password', `<h2>Password Reset</h2><p>Click below to reset your password. This link expires in 1 hour.</p><a href="${resetUrl}" style="background:#378ADD;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block">Reset Password</a>`);
    return jsonResponse({ message: 'If that email exists, a reset link has been sent.' });
  }

  if (path === '/api/auth/reset' && request.method === 'POST') {
    const { token, password } = body;
    if (!password || password.length < 8) return jsonResponse({ error: 'Password must be at least 8 characters' }, 400);
    const user = await env.DB.prepare('SELECT id, reset_expires FROM users WHERE reset_token = ?').bind(token).first();
    if (!user || user.reset_expires < Math.floor(Date.now() / 1000)) return jsonResponse({ error: 'Invalid or expired token' }, 400);
    const hash = await hashPassword(password);
    await env.DB.prepare('UPDATE users SET password_hash = ?, reset_token = NULL, reset_expires = NULL WHERE id = ?').bind(hash, user.id).run();
    return jsonResponse({ message: 'Password updated! You can now log in.' });
  }

  return jsonResponse({ error: 'Not found' }, 404);
}

async function startOAuth(request, env, providerName) {
  const provider = OAUTH_PROVIDERS[providerName];
  if (!provider) return jsonResponse({ error: 'OAuth provider not supported' }, 404);
  const clientId = env[provider.clientIdEnv];
  const url = new URL(request.url);
  if (!clientId || !env[provider.clientSecretEnv]) return redirectOAuthError('Google login is not configured yet.', url.origin);

  const returnTo = safeReturnTo(url.searchParams.get('returnTo'));
  const referralCode = normalizeReferralCode(url.searchParams.get('ref'));
  const redirectUri = new URL(`/auth/${providerName}/callback`, url.origin).toString();
  const nonce = generateToken();
  const state = await createOAuthState({ provider: providerName, returnTo, nonce, referralCode, ts: Date.now() }, env.JWT_SECRET);
  const authUrl = new URL(provider.authUrl);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', provider.scope);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('nonce', nonce);
  authUrl.searchParams.set('prompt', 'select_account');

  return Response.redirect(authUrl.toString(), 302);
}

async function finishOAuth(request, env, providerName) {
  const provider = OAUTH_PROVIDERS[providerName];
  if (!provider) return redirectOAuthError('OAuth provider not supported.');
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const stateParam = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');
  if (oauthError) return redirectOAuthError('Google login was cancelled or failed.', url.origin);
  if (!code || !stateParam) return redirectOAuthError('Google login response was incomplete.', url.origin);

  const state = await verifyOAuthState(stateParam, env.JWT_SECRET);
  if (!state || state.provider !== providerName || Date.now() - Number(state.ts || 0) > 10 * 60 * 1000) {
    return redirectOAuthError('Google login expired. Please try again.', url.origin);
  }

  try {
    const redirectUri = new URL(`/auth/${providerName}/callback`, url.origin).toString();
    const tokenResponse = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env[provider.clientIdEnv],
        client_secret: env[provider.clientSecretEnv],
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      })
    });
    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenData.id_token) return redirectOAuthError('Google login failed. Please try again.', url.origin);

    const profile = await verifyGoogleIdToken(tokenData.id_token, provider, env, state.nonce);
    if (!profile) return redirectOAuthError('Google identity could not be verified.', url.origin);

    const user = await findOrCreateOAuthUser(env, {
      provider: providerName,
      providerUserId: profile.sub,
      email: String(profile.email).toLowerCase(),
      name: profile.name || profile.given_name || String(profile.email).split('@')[0],
      referralCode: state.referralCode
    });
    const jwt = await createJWT(user.id, user.email, env.JWT_SECRET);
    return oauthSuccessPage(jwt, await buildPublicUser(env, user), state.returnTo);
  } catch {
    return redirectOAuthError('Google login failed. Please try again.', url.origin);
  }
}

async function createOAuthState(payload, secret) {
  const body = base64UrlEncode(JSON.stringify(payload));
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return `${body}.${base64UrlEncode(sig)}`;
}

async function verifyOAuthState(state, secret) {
  try {
    const [body, sig] = state.split('.');
    if (!body || !sig) return null;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('HMAC', key, Uint8Array.from(base64UrlDecode(sig), c => c.charCodeAt(0)), encoder.encode(body));
    if (!valid) return null;
    return JSON.parse(base64UrlDecode(body));
  } catch {
    return null;
  }
}

async function verifyGoogleIdToken(idToken, provider, env, expectedNonce) {
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;

  let header;
  let payload;
  try {
    header = JSON.parse(base64UrlDecode(parts[0]));
    payload = JSON.parse(base64UrlDecode(parts[1]));
  } catch {
    return null;
  }

  if (header.alg !== 'RS256' || !header.kid) return null;
  const certsResponse = await fetch(provider.jwksUrl);
  if (!certsResponse.ok) return null;
  const certs = await certsResponse.json();
  const jwk = (certs.keys || []).find(key => key.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    Uint8Array.from(base64UrlDecode(parts[2]), c => c.charCodeAt(0)),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  if (!valid) return null;

  const now = Math.floor(Date.now() / 1000);
  if (!['https://accounts.google.com', 'accounts.google.com'].includes(payload.iss)) return null;
  if (payload.aud !== env[provider.clientIdEnv]) return null;
  if (Number(payload.exp || 0) < now) return null;
  if (payload.nonce !== expectedNonce) return null;
  if (!payload.sub || !payload.email || !(payload.email_verified === true || payload.email_verified === 'true')) return null;

  return payload;
}

async function findOrCreateOAuthUser(env, profile) {
  const linked = await env.DB.prepare(`
    SELECT u.* FROM oauth_accounts oa
    JOIN users u ON u.id = oa.user_id
    WHERE oa.provider = ? AND oa.provider_user_id = ?
  `).bind(profile.provider, profile.providerUserId).first();
  if (linked) {
    await env.DB.prepare('UPDATE oauth_accounts SET email = ?, updated_at = unixepoch() WHERE provider = ? AND provider_user_id = ?').bind(profile.email, profile.provider, profile.providerUserId).run();
    return linked;
  }

  let user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(profile.email).first();
  let createdUser = false;
  if (!user) {
    const passwordHash = await hashPassword(`oauth:${profile.provider}:${profile.providerUserId}:${generateToken()}`);
    const referralCode = await uniqueReferralCode(env);
    await env.DB.prepare('INSERT INTO users (email, password_hash, name, verified, referral_code) VALUES (?, ?, ?, 1, ?)').bind(profile.email, passwordHash, profile.name, referralCode).run();
    user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(profile.email).first();
    createdUser = true;
  } else if (!user.verified) {
    await env.DB.prepare('UPDATE users SET verified = 1, verify_token = NULL WHERE id = ?').bind(user.id).run();
    user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
  }

  if (createdUser) await recordReferral(env, profile.referralCode, user.id);

  await env.DB.prepare(`
    INSERT INTO oauth_accounts (user_id, provider, provider_user_id, email)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(provider, provider_user_id) DO UPDATE SET user_id = excluded.user_id, email = excluded.email, updated_at = unixepoch()
  `).bind(user.id, profile.provider, profile.providerUserId, profile.email).run();
  return user;
}

function oauthSuccessPage(token, user, returnTo) {
  const target = safeReturnTo(returnTo);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Signing in...</title></head><body><script>
localStorage.setItem('bk_token', ${JSON.stringify(token)});
localStorage.setItem('bk_user', ${JSON.stringify(JSON.stringify(user))});
localStorage.removeItem('bk_referral_code');
window.location.replace(${JSON.stringify(target)});
</script></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function redirectOAuthError(message, origin = 'https://bingekeeper.tv') {
  return Response.redirect(`${origin}/#oauth=error&message=${encodeURIComponent(message)}`, 302);
}

function safeReturnTo(value) {
  if (!value || typeof value !== 'string') return '/';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

async function sendEmail(env, to, subject, html) {
  if (!env.RESEND_API_KEY) return;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Bingekeeper <hello@bingekeeper.tv>', to, subject, html })
  });
}

async function getUserById(env, userId) {
  try {
    return await env.DB.prepare('SELECT id, email, name, plan, subscription_status, is_admin, referral_code, referral_bonus_slots FROM users WHERE id = ?').bind(userId).first();
  } catch {
    return await env.DB.prepare('SELECT id, email, name, plan, subscription_status FROM users WHERE id = ?').bind(userId).first();
  }
}

async function buildPublicUser(env, user) {
  const referralCode = await ensureReferralCode(env, user);
  const bonusSlots = Math.max(0, Number(user.referral_bonus_slots || 0));
  const freeShowLimit = Math.min(FREE_SHOW_REFERRAL_CAP, FREE_SHOW_BASE_LIMIT + bonusSlots);
  return {
    ...publicUser(user, env),
    referral_code: referralCode,
    referral_url: `https://bingekeeper.tv/?ref=${encodeURIComponent(referralCode)}`,
    referral_bonus_slots: bonusSlots,
    free_show_limit: freeShowLimit,
    free_show_base_limit: FREE_SHOW_BASE_LIMIT,
    free_show_referral_cap: FREE_SHOW_REFERRAL_CAP,
    referral_bonus_increment: REFERRAL_BONUS_SLOTS
  };
}

function publicUser(user, env) {
  const adminEmails = String(env.ADMIN_EMAILS || '')
    .split(',')
    .map(email => email.trim().toLowerCase())
    .filter(Boolean);

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    plan: user.plan || 'free',
    subscription_status: user.subscription_status || null,
    is_admin: Boolean(user.is_admin) || adminEmails.includes(String(user.email).toLowerCase())
  };
}

async function ensureReferralCode(env, user) {
  if (user.referral_code) return user.referral_code;
  const code = await uniqueReferralCode(env);
  try {
    await env.DB.prepare('UPDATE users SET referral_code = ? WHERE id = ? AND referral_code IS NULL').bind(code, user.id).run();
    user.referral_code = code;
    return code;
  } catch {
    const fresh = await env.DB.prepare('SELECT referral_code FROM users WHERE id = ?').bind(user.id).first();
    if (fresh?.referral_code) return fresh.referral_code;
    const retryCode = await uniqueReferralCode(env);
    await env.DB.prepare('UPDATE users SET referral_code = ? WHERE id = ?').bind(retryCode, user.id).run();
    user.referral_code = retryCode;
    return retryCode;
  }
}

async function uniqueReferralCode(env) {
  for (let i = 0; i < 5; i++) {
    const code = generateReferralCode();
    const existing = await env.DB.prepare('SELECT id FROM users WHERE referral_code = ?').bind(code).first();
    if (!existing) return code;
  }
  return generateToken().slice(0, 12);
}

function normalizeReferralCode(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
}

async function recordReferral(env, referralCode, referredUserId) {
  const code = normalizeReferralCode(referralCode);
  if (!code) return;
  try {
    const referrer = await env.DB.prepare('SELECT id FROM users WHERE referral_code = ?').bind(code).first();
    if (!referrer || referrer.id === referredUserId) return;
    await env.DB.prepare('INSERT OR IGNORE INTO referrals (referrer_user_id, referred_user_id) VALUES (?, ?)').bind(referrer.id, referredUserId).run();
  } catch {}
}

export async function getFreeShowLimitForUser(env, userId) {
  try {
    const user = await env.DB.prepare('SELECT plan, referral_bonus_slots FROM users WHERE id = ?').bind(userId).first();
    if ((user?.plan || 'free') === 'plus') return { isPlus: true, limit: null };
    const bonusSlots = Math.max(0, Number(user?.referral_bonus_slots || 0));
    return { isPlus: false, limit: Math.min(FREE_SHOW_REFERRAL_CAP, FREE_SHOW_BASE_LIMIT + bonusSlots) };
  } catch {
    return { isPlus: false, limit: FREE_SHOW_BASE_LIMIT };
  }
}

export async function awardReferralBonusIfEligible(env, referredUserId) {
  try {
    const referral = await env.DB.prepare(`
      SELECT id, referrer_user_id, referred_user_id
      FROM referrals
      WHERE referred_user_id = ? AND status = 'pending'
    `).bind(referredUserId).first();
    if (!referral) return;

    const firstShow = await env.DB.prepare('SELECT COUNT(*) AS total FROM watchlist WHERE user_id = ?').bind(referredUserId).first();
    if ((firstShow?.total || 0) < 1) return;

    await env.DB.batch([
      env.DB.prepare(`UPDATE users SET referral_bonus_slots = MIN(?, COALESCE(referral_bonus_slots, 0) + ?) WHERE id = ?`).bind(FREE_SHOW_REFERRAL_CAP - FREE_SHOW_BASE_LIMIT, REFERRAL_BONUS_SLOTS, referral.referrer_user_id),
      env.DB.prepare(`UPDATE users SET referral_bonus_slots = MIN(?, COALESCE(referral_bonus_slots, 0) + ?) WHERE id = ?`).bind(FREE_SHOW_REFERRAL_CAP - FREE_SHOW_BASE_LIMIT, REFERRAL_BONUS_SLOTS, referral.referred_user_id),
      env.DB.prepare(`UPDATE referrals SET status = 'awarded', awarded_at = unixepoch() WHERE id = ? AND status = 'pending'`).bind(referral.id)
    ]);
  } catch {}
}
