// Admin sign-in for the standalone admin page (/admin), separate from chat accounts.
//
// - Credentials come from the hosting environment: ADMIN_USERNAME and ADMIN_PASSWORD. Unset (or a password under
//   12 characters) turns admin sign-in off; nothing falls back to a chat account.
// - An admin session is its own random token, kept in memory (a restart or redeploy signs admins out) and sent
//   as an HttpOnly, SameSite=Strict cookie scoped to /api/admin, so the chat app never sends it and chat tokens
//   are never accepted here.
// - Every admin API request must also carry the X-HM-Admin header, which a cross-site form or link can't add.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createLoginThrottle } from './parity.mjs';

export const ADMIN_API = '/api/admin/v1';
export const ADMIN_COOKIE = 'hm_admin';
export const ADMIN_HEADER = 'x-hm-admin';
const MIN_PASSWORD = 12;
const SESSION_MS = 8 * 60 * 60 * 1000;
const IDLE_MS = 60 * 60 * 1000;

const digest = (value) => createHash('sha256').update(String(value), 'utf8').digest();
const sameSecret = (a, b) => timingSafeEqual(digest(a), digest(b));

/** { username, password } from the environment, or null when admin sign-in isn't configured. */
export function adminCredentialsFrom(env = process.env, log = console) {
  const username = String(env.ADMIN_USERNAME ?? '').trim();
  const password = String(env.ADMIN_PASSWORD ?? '');
  if (!username || !password) return null;
  if (password.length < MIN_PASSWORD) {
    log.error?.(`ADMIN_PASSWORD is shorter than ${MIN_PASSWORD} characters, so admin sign-in is off.`);
    return null;
  }
  return { username, password };
}

function cookieValue(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

export function createAdminAuth({ app, credentials, now = () => Date.now() }) {
  const sessions = new Map(); // sha256(token) -> { username, expiresAt, lastSeen }
  const throttle = createLoginThrottle({ now });
  const fail = (response, status, error, extra = {}) => response.status(status).json({ error, ...extra });
  const secure = (request) => request.secure || String(request.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
  const setCookie = (request, response, token, maxAgeSeconds) => response.setHeader('Set-Cookie',
    `${ADMIN_COOKIE}=${token}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure(request) ? '; Secure' : ''}`);

  function sessionFor(request) {
    const token = cookieValue(request.headers.cookie, ADMIN_COOKIE);
    if (!token) return null;
    const key = digest(token).toString('hex');
    const session = sessions.get(key);
    if (!session) return null;
    const at = now();
    if (session.expiresAt <= at || session.lastSeen + IDLE_MS <= at) { sessions.delete(key); return null; }
    session.lastSeen = at;
    return { key, ...session };
  }

  // Every /api/admin response: never cached, never framed, and only from scripts on this page.
  app.use('/api/admin', (request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Robots-Tag', 'noindex');
    if (request.headers[ADMIN_HEADER] !== '1') return fail(response, 403, 'Missing admin request header.');
    return next();
  });

  /** Middleware for admin API routes: a valid admin session, or 401. */
  function requireAdmin(request, response, next) {
    const session = sessionFor(request);
    if (!session) return fail(response, 401, 'Sign in to the admin console.');
    request.admin = { username: session.username, actor: `admin:${session.username}` };
    return next();
  }

  app.get(`${ADMIN_API}/session`, (request, response) => {
    const session = sessionFor(request);
    response.json({ configured: Boolean(credentials), signedIn: Boolean(session), username: session?.username ?? null });
  });

  app.post(`${ADMIN_API}/login`, (request, response) => {
    if (!credentials) return fail(response, 503, 'Admin sign-in isn’t set up. Add ADMIN_USERNAME and ADMIN_PASSWORD to the server environment.');
    const username = typeof request.body?.username === 'string' ? request.body.username.trim() : '';
    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    if (!username || !password || username.length > 128 || password.length > 256) return fail(response, 400, 'Enter the admin username and password.');
    const keys = ['admin'];
    const wait = throttle.retryAfter(keys);
    if (wait) return fail(response, 429, `Too many attempts. Try again in ${Math.ceil(wait / 1000)} seconds.`, { retryAfterMs: wait });
    // Both compared in full, in constant time, so a wrong username and a wrong password look the same.
    const nameMatches = sameSecret(username.toLowerCase(), credentials.username.toLowerCase());
    const passwordMatches = sameSecret(password, credentials.password);
    if (!(nameMatches && passwordMatches)) { throttle.fail(keys); return fail(response, 401, 'Wrong username or password.'); }
    throttle.succeed(keys);
    const token = randomBytes(32).toString('base64url');
    const at = now();
    sessions.set(digest(token).toString('hex'), { username: credentials.username, expiresAt: at + SESSION_MS, lastSeen: at });
    if (sessions.size > 100) for (const [key, session] of sessions) if (session.expiresAt <= at) sessions.delete(key);
    setCookie(request, response, token, SESSION_MS / 1000);
    response.json({ signedIn: true, username: credentials.username });
  });

  app.post(`${ADMIN_API}/logout`, (request, response) => {
    const session = sessionFor(request);
    if (session) sessions.delete(session.key);
    setCookie(request, response, '', 0);
    response.json({ signedIn: false });
  });

  return { requireAdmin };
}
