async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
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

  if (path === '/api/auth/register' && request.method === 'POST') {
    const { email, password, name } = body;
    if (!email || !password || !name) return jsonResponse({ error: 'All fields required' }, 400);
    if (password.length < 8) return jsonResponse({ error: 'Password must be at least 8 characters' }, 400);
    const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email.toLowerCase()).first();
    if (existing) return jsonResponse({ error: 'Email already registered' }, 409);
    const hash = await hashPassword(password);
    const token = generateToken();
    await env.DB.prepare('INSERT INTO users (email, password_hash, name, verify_token) VALUES (?, ?, ?, ?)').bind(email.toLowerCase(), hash, name, token).run();
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
    return jsonResponse({ token: jwt, user: { id: user.id, email: user.email, name: user.name } });
  }

  if (path === '/api/auth/verify' && request.method === 'POST') {
    const { token } = body;
    const user = await env.DB.prepare('SELECT id FROM users WHERE verify_token = ?').bind(token).first();
    if (!user) return jsonResponse({ error: 'Invalid or expired token' }, 400);
    await env.DB.prepare('UPDATE users SET verified = 1, verify_token = NULL WHERE id = ?').bind(user.id).run();
    return jsonResponse({ message: 'Email verified! You can now log in.' });
  }

  if (path === '/api/auth/forgot' && request.method === 'POST') {
    const { email } = body;
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

async function sendEmail(env, to, subject, html) {
  if (!env.RESEND_API_KEY) return;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Bingekeeper <hello@bingekeeper.tv>', to, subject, html })
  });
}
