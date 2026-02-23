import { Hono } from 'hono';
import type { Env } from '../index';
import type { AuthVariables } from '../middleware/auth';

/**
 * Auth routes — local auth with KV-stored credentials, falling back to ChittyAuth proxy.
 * These endpoints are NOT behind authMiddleware since they handle auth themselves.
 */

export const authRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

/** GET /auth/login — serve login form */
authRoutes.get('/login', (c) => {
  return c.html(loginPage);
});

/**
 * POST /auth/login — authenticate with email + password.
 * Checks KV-stored credentials first (local auth), then falls back to ChittyAuth.
 * Body: { email: string, password: string }
 * Returns: { token: string, user_id: string, scopes: string[] }
 */
authRoutes.post('/login', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return c.json({ error: 'Invalid request body' }, 400);
  }

  const { email, password } = body as { email?: string; password?: string };
  if (!email || !password) {
    return c.json({ error: 'Email and password are required' }, 400);
  }

  // ── Local auth: check KV-stored credentials ──
  const storedHash = await c.env.COMMAND_KV.get(`auth:user:${email.toLowerCase()}`);
  if (storedHash) {
    const valid = await verifyPassword(password, storedHash);
    if (!valid) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }
    const userId = email.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const token = await generateToken(userId, c.env.COMMAND_KV);
    return c.json({ token, user_id: userId, scopes: ['admin'] });
  }

  // ── ChittyAuth proxy fallback ──
  const authUrl = c.env.CHITTYAUTH_URL;
  if (!authUrl) {
    return c.json({ error: 'No account found. Register first via POST /auth/register' }, 401);
  }

  try {
    const res = await fetch(`${authUrl}/v1/tokens/provision`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Source-Service': 'chittycommand',
      },
      body: JSON.stringify({ email, password }),
    });

    if (!res.ok) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }

    const data = await res.json() as { token: string; user_id: string; scopes: string[] };
    return c.json(data);
  } catch {
    return c.json({ error: 'No account found. Register first via POST /auth/register' }, 401);
  }
});

/**
 * POST /auth/register — create a local account with email + password.
 * Stores bcrypt-like hash in KV. Single-user system (admin only).
 * Body: { email: string, password: string }
 */
authRoutes.post('/register', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return c.json({ error: 'Invalid request body' }, 400);
  }

  const { email, password } = body as { email?: string; password?: string };
  if (!email || !password) {
    return c.json({ error: 'Email and password are required' }, 400);
  }
  if (password.length < 8) {
    return c.json({ error: 'Password must be at least 8 characters' }, 400);
  }

  const key = `auth:user:${email.toLowerCase()}`;
  const existing = await c.env.COMMAND_KV.get(key);
  if (existing) {
    return c.json({ error: 'Account already exists' }, 409);
  }

  const hash = await hashPassword(password);
  await c.env.COMMAND_KV.put(key, hash);

  const userId = email.toLowerCase().replace(/[^a-z0-9]/g, '-');
  const token = await generateToken(userId, c.env.COMMAND_KV);

  return c.json({ token, user_id: userId, scopes: ['admin'], message: 'Account created' }, 201);
});

/**
 * GET /auth/me — verify current token.
 * Returns user identity or 401.
 */
authRoutes.get('/me', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Not authenticated' }, 401);
  }

  const token = authHeader.slice(7);

  // Check local tokens in KV
  const userId = await c.env.COMMAND_KV.get(`auth:token:${token}`);
  if (userId) {
    return c.json({ user_id: userId, scopes: ['admin'] });
  }

  // Fall back to ChittyAuth
  const authUrl = c.env.CHITTYAUTH_URL;
  if (authUrl) {
    try {
      const res = await fetch(`${authUrl}/v1/tokens/validate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Source-Service': 'chittycommand',
        },
        body: JSON.stringify({ token }),
      });
      if (res.ok) {
        const identity = await res.json() as { user_id: string; scopes: string[] };
        return c.json(identity);
      }
    } catch { /* fall through */ }
  }

  return c.json({ error: 'Token expired or invalid' }, 401);
});

// ── Helpers ──

async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const hash = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');
  const hashHex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${saltHex}:${hashHex}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const hash = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  const computedHex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  return computedHex === hashHex;
}

async function generateToken(userId: string, kv: KVNamespace): Promise<string> {
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = Array.from(tokenBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  // Store token → userId mapping, expires in 30 days
  await kv.put(`auth:token:${token}`, userId, { expirationTtl: 30 * 86400 });
  return token;
}

// ── Login page HTML ──

const loginPage = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ChittyCommand — Sign In</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #e5e5e5; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .card { background: #141414; border: 1px solid #262626; border-radius: 12px; padding: 40px; width: 100%; max-width: 400px; }
  h1 { font-size: 20px; font-weight: 600; margin-bottom: 4px; }
  .sub { color: #737373; font-size: 14px; margin-bottom: 28px; }
  label { display: block; font-size: 13px; font-weight: 500; color: #a3a3a3; margin-bottom: 6px; }
  input { width: 100%; padding: 10px 12px; background: #0a0a0a; border: 1px solid #262626; border-radius: 8px; color: #e5e5e5; font-size: 14px; outline: none; transition: border-color 0.15s; }
  input:focus { border-color: #525252; }
  .field { margin-bottom: 20px; }
  button { width: 100%; padding: 10px; background: #fff; color: #0a0a0a; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; transition: opacity 0.15s; }
  button:hover { opacity: 0.9; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .error { background: #1c0a0a; border: 1px solid #7f1d1d; color: #fca5a5; padding: 10px 12px; border-radius: 8px; font-size: 13px; margin-bottom: 16px; display: none; }
  .success { background: #0a1c0a; border: 1px solid #166534; color: #86efac; padding: 10px 12px; border-radius: 8px; font-size: 13px; margin-bottom: 16px; display: none; }
</style>
</head>
<body>
<div class="card">
  <h1>ChittyCommand</h1>
  <p class="sub">Sign in to your dashboard</p>
  <div class="error" id="error"></div>
  <div class="success" id="success"></div>
  <form id="form">
    <div class="field">
      <label for="email">Email</label>
      <input type="email" id="email" name="email" required autocomplete="email" autofocus>
    </div>
    <div class="field">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required autocomplete="current-password">
    </div>
    <button type="submit" id="btn">Sign In</button>
  </form>
</div>
<script>
  const form = document.getElementById('form');
  const errorEl = document.getElementById('error');
  const successEl = document.getElementById('success');
  const btn = document.getElementById('btn');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.style.display = 'none';
    successEl.style.display = 'none';
    btn.disabled = true;
    btn.textContent = 'Signing in...';
    try {
      const res = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: document.getElementById('email').value,
          password: document.getElementById('password').value,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Login failed');
      }
      localStorage.setItem('cc_token', data.token);
      localStorage.setItem('cc_user', data.user_id);
      successEl.textContent = 'Signed in. Redirecting...';
      successEl.style.display = 'block';
      setTimeout(() => { window.location.href = '/'; }, 500);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = 'block';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign In';
    }
  });
</script>
</body>
</html>`;
