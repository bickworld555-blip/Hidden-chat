// The XMPP core (ejabberd on the VPS, chat.hiddenmessenger.com) and this server: Phase 2 of the BEAM/XMPP move.
//
// Every signed-in device gets its own ejabberd account, so ejabberd's offline store keeps the per-device delivery the
// current queue has: a message waits for exactly one device and is deleted once that device has it. The address is
// derived, not chosen: "d" + the first 40 hex of SHA-256(userId \n deviceId) — valid under XMPP's lowercase rules for
// any ids, collision-free in practice, and it shows ejabberd no user or device id. Other devices compute the same
// address from a device list.
//
// Devices never hold an XMPP password. They sign in with a short-lived token (JWT, HS256) this server signs with
// XMPP_JWT_SECRET, the key ejabberd verifies (/etc/ejabberd/jwt.jwk). Accounts are created and removed through
// ejabberd's admin API (XMPP_ADMIN_PASSWORD); each gets a random password that is never stored or used.
//
// Lifecycle: an account is created before the device's first token (ejabberd stores offline messages only for
// accounts that exist), and removed — its live connection kicked first — when the device's session ends.
import { createHash, createHmac, randomBytes } from 'node:crypto';

export const XMPP_TOKEN_TTL_SECONDS = 600;
export const DEFAULT_XMPP_HOST = 'chat.hiddenmessenger.com';
const ADMIN_TIMEOUT_MS = 8000;

export function xmppConfigFromEnv(env = process.env) {
  const host = (env.XMPP_HOST || DEFAULT_XMPP_HOST).trim().toLowerCase();
  const secret = (env.XMPP_JWT_SECRET || '').trim();
  const adminPassword = (env.XMPP_ADMIN_PASSWORD || '').trim();
  return {
    host,
    secret,
    adminPassword,
    adminJid: `admin@${host}`,
    apiUrl: (env.XMPP_API_URL || `https://${host}/api`).replace(/\/+$/, ''),
    websocketUrl: env.XMPP_WEBSOCKET_URL || `wss://${host}/xmpp-websocket`,
    enabled: Boolean(secret && adminPassword),
  };
}

/** The XMPP localpart of one device: "d" + 40 hex characters. */
export function localpartFor(userId, deviceId) {
  return `d${createHash('sha256').update(`${userId}\n${deviceId}`).digest('hex').slice(0, 40)}`;
}

const base64url = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

/** An HS256 JWT ejabberd accepts for `jid` (its "jid" claim), valid for `ttlSeconds`. */
export function signXmppToken({ secret, jid, nowMs = Date.now(), ttlSeconds = XMPP_TOKEN_TTL_SECONDS }) {
  const iat = Math.floor(nowMs / 1000);
  const header = base64url({ alg: 'HS256', typ: 'JWT' });
  const payload = base64url({ jid, iat, exp: iat + ttlSeconds });
  // ejabberd's JWK holds the key as base64url ("k"); the signing key is those decoded bytes.
  const signature = createHmac('sha256', Buffer.from(secret, 'base64url')).update(`${header}.${payload}`).digest('base64url');
  return { token: `${header}.${payload}.${signature}`, expiresAt: (iat + ttlSeconds) * 1000 };
}

export function ensureXmppSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS xmpp_accounts (
    user_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    localpart TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, device_id)
  )`);
}

export function createXmpp({ db, config = xmppConfigFromEnv(), fetchImpl = globalThis.fetch, now = Date.now, log = console } = {}) {
  const accountOf = db.prepare('SELECT localpart FROM xmpp_accounts WHERE user_id = ? AND device_id = ?');
  const insertAccount = db.prepare('INSERT INTO xmpp_accounts(user_id, device_id, localpart, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING');
  const deleteAccount = db.prepare('DELETE FROM xmpp_accounts WHERE localpart = ?');
  const endedAccounts = db.prepare(`SELECT localpart FROM xmpp_accounts x
    WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = x.user_id AND s.device_id = x.device_id)`);
  const authorization = `Basic ${Buffer.from(`${config.adminJid}:${config.adminPassword}`).toString('base64')}`;

  // One admin API call. Resolves { status, body }; a network failure or timeout throws.
  async function admin(command, args) {
    const response = await fetchImpl(`${config.apiUrl}/${command}`, {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: config.host, ...args }),
      signal: AbortSignal.timeout(ADMIN_TIMEOUT_MS),
    });
    let body = null;
    try { body = await response.json(); } catch { /* empty or not JSON */ }
    return { status: response.status, body };
  }

  async function register(localpart) {
    const { status, body } = await admin('register', { user: localpart, password: randomBytes(24).toString('hex') });
    // 409 / 10090: the account already exists (a retry, or two token requests at once) — that is the goal.
    if (status === 200 || (status === 409 && body?.code === 10090)) return;
    throw Object.assign(new Error(`ejabberd register failed (${status})`), { status });
  }

  async function unregister(localpart) {
    await admin('kick_user', { user: localpart }).catch(() => {});
    const { status } = await admin('unregister', { user: localpart });
    if (status !== 200) throw Object.assign(new Error(`ejabberd unregister failed (${status})`), { status });
  }

  /** The device's account, created on ejabberd first when it is new. */
  async function ensureAccount(userId, deviceId) {
    const known = await accountOf.get(userId, deviceId);
    if (known) return known.localpart;
    const localpart = localpartFor(userId, deviceId);
    await register(localpart);
    await insertAccount.run(userId, deviceId, localpart, now());
    return localpart;
  }

  /** Removes the accounts of devices whose sessions have ended (a failed removal is retried on the next run). */
  let reconciling = null;
  function reconcile() {
    if (!config.enabled) return Promise.resolve(0);
    reconciling ??= (async () => {
      let removed = 0;
      try {
        for (const { localpart } of await endedAccounts.all()) {
          try {
            await unregister(localpart);
            await deleteAccount.run(localpart);
            removed += 1;
          } catch (error) {
            log.warn?.('xmpp: could not remove an ended device account', error?.message);
          }
        }
      } finally {
        reconciling = null;
      }
      return removed;
    })();
    return reconciling;
  }

  return {
    config,
    ensureAccount,
    reconcile,
    /** Runs a reconcile without waiting on it (after sign-outs). */
    reconcileSoon() {
      if (config.enabled) reconcile().catch(() => {});
    },
    /** POST /api/v1/xmpp/token: this device's address, a short-lived sign-in token and where to connect. */
    register(app, requireSession) {
      app.post('/api/v1/xmpp/token', requireSession, async (request, response) => {
        if (!config.enabled) return response.status(503).json({ error: 'Messaging over XMPP is not enabled on this server.', enabled: false });
        const { user_id: userId, device_id: deviceId } = request.session;
        if (!userId || !deviceId) return response.status(400).json({ error: 'This session has no device.' });
        let localpart;
        try {
          localpart = await ensureAccount(userId, deviceId);
        } catch (error) {
          log.warn?.('xmpp: account setup failed', error?.message);
          return response.status(502).json({ error: 'The messaging server is not reachable right now. Try again shortly.' });
        }
        const jid = `${localpart}@${config.host}`;
        const { token, expiresAt } = signXmppToken({ secret: config.secret, jid, nowMs: now() });
        response.set('Cache-Control', 'no-store');
        response.json({ enabled: true, jid, token, expiresAt, websocket: config.websocketUrl });
      });
    },
  };
}
