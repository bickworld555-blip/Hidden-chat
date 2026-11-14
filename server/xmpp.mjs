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
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import express from 'express';

export const XMPP_TOKEN_TTL_SECONDS = 600;
// ejabberd's offline hook (mod_hm on the VPS): requests older or newer than this are refused (replays, clock drift).
export const OFFLINE_HOOK_MAX_SKEW_SECONDS = 300;
// A device gets at most one wake-up push this often, however many messages wait for it.
export const WAKE_COALESCE_MS = 15_000;
export const DEFAULT_XMPP_HOST = 'chat.hiddenmessenger.com';
const ADMIN_TIMEOUT_MS = 8000;
const FORGET_DEBOUNCE_MS = 200;
export const OPS_ALERT_KINDS = new Set(['ejabberd', 'websocket', 'coturn', 'backup', 'disk', 'offline-queue']);

// Rollout (Phase 3): who uses XMPP. XMPP_ROLLOUT_PERCENT (0-100, default 0) of users by a stable hash of the user id,
// plus everyone in XMPP_ROLLOUT_USER_IDS (comma-separated, for test accounts). Everyone else stays on the current path.
export function rolloutFromEnv(env = process.env) {
  const percent = Number.parseInt(String(env.XMPP_ROLLOUT_PERCENT ?? '0'), 10);
  return {
    percent: Number.isInteger(percent) ? Math.min(100, Math.max(0, percent)) : 0,
    userIds: new Set(String(env.XMPP_ROLLOUT_USER_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean)),
  };
}

/** A user's rollout bucket, 0-99: the same on every device and every server, so a person moves over all at once. */
export function rolloutBucket(userId) {
  return createHash('sha256').update(`xmpp-rollout\n${userId}`).digest().readUInt32BE(0) % 100;
}

export function xmppConfigFromEnv(env = process.env) {
  const host = (env.XMPP_HOST || DEFAULT_XMPP_HOST).trim().toLowerCase();
  const secret = (env.XMPP_JWT_SECRET || '').trim();
  const adminPassword = (env.XMPP_ADMIN_PASSWORD || '').trim();
  return {
    rollout: rolloutFromEnv(env),
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

/** The hook's signature: hex HMAC-SHA256 of the exact request body, keyed with the JWT key (one shared secret). */
export function signOfflineHook(secret, body) {
  return createHmac('sha256', Buffer.from(secret, 'base64url')).update(body).digest('hex');
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

// `wake(userId, deviceId, { fromUserId })`: sends that one device the wake-up push (index.mjs pushToDevice); resolves how
// many went. fromUserId (when the sender is known) lets the push name the sender.
export function createXmpp({ db, config = xmppConfigFromEnv(), fetchImpl = globalThis.fetch, now = Date.now, log = console, wake = async () => 0,
  // alert(kind, text): the app's operations alerts (monitoring.mjs); the VPS health check reports through it.
  alert = async () => false,
  verdict = async () => 'allow',
  // groupPost({ groupId, senderUserId, membersHash }) -> may this sender post there with this (current) members hash;
  // groupMember(groupId, userId) -> is that user a member. Used for group fan-out (index.mjs).
  groupPost = async () => false, groupMember = async () => false } = {}) {
  const accountOf = db.prepare('SELECT localpart FROM xmpp_accounts WHERE user_id = ? AND device_id = ?');
  const insertAccount = db.prepare('INSERT INTO xmpp_accounts(user_id, device_id, localpart, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING');
  const deleteAccount = db.prepare('DELETE FROM xmpp_accounts WHERE localpart = ?');
  const accountByLocalpart = db.prepare('SELECT user_id AS "userId", device_id AS "deviceId" FROM xmpp_accounts WHERE localpart = ?');
  const lastWake = new Map();
  const endedAccounts = db.prepare(`SELECT localpart FROM xmpp_accounts x
    WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = x.user_id AND s.device_id = x.device_id)`);
  const liveAccounts = db.prepare(`SELECT localpart FROM xmpp_accounts x
    WHERE EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = x.user_id AND s.device_id = x.device_id)`);
  const allLocalparts = db.prepare('SELECT localpart FROM xmpp_accounts');
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

  /**
   * The device's account. The row is written BEFORE ejabberd creates the account (and dropped if that fails), so an
   * account on ejabberd always has a row: anything on ejabberd without one is an orphan the sweep may remove.
   */
  async function ensureAccount(userId, deviceId) {
    const known = await accountOf.get(userId, deviceId);
    if (known) return known.localpart;
    const localpart = localpartFor(userId, deviceId);
    await insertAccount.run(userId, deviceId, localpart, now());
    try {
      await register(localpart);
    } catch (error) {
      await deleteAccount.run(localpart).catch(() => {});
      throw error;
    }
    return localpart;
  }

  // ejabberd as a mirror of xmpp_accounts: device accounts with no row are removed (left by a crash, or by data
  // restored from a backup); rows of signed-in devices whose account is missing are created again. ejabberd's list
  // is read first, so an account being created meanwhile already has its row and is never taken for an orphan.
  async function sweepMirror() {
    const { status, body } = await admin('registered_users', {});
    if (status !== 200 || !Array.isArray(body)) throw Object.assign(new Error(`ejabberd registered_users failed (${status})`), { status });
    const onEjabberd = new Set(body.filter((user) => /^d[0-9a-f]{40}$/.test(user)));
    const known = new Set((await allLocalparts.all()).map((row) => row.localpart));
    let removed = 0;
    let restored = 0;
    for (const localpart of onEjabberd) {
      if (known.has(localpart)) continue;
      try { await unregister(localpart); removed += 1; } catch (error) { log.warn?.('xmpp: could not remove an orphaned account', error?.message); }
    }
    for (const { localpart } of await liveAccounts.all()) {
      if (onEjabberd.has(localpart)) continue;
      try { await register(localpart); restored += 1; } catch (error) { log.warn?.('xmpp: could not restore a device account', error?.message); }
    }
    return { removed, restored };
  }

  /** Removes the accounts of devices whose sessions have ended (a failed removal is retried on the next run). */
  let reconciling = null;
  function reconcile({ mirror = false } = {}) {
    if (!config.enabled) return Promise.resolve(0);
    reconciling ??= (async () => {
      let removed = 0;
      try {
        if (mirror) {
          try { removed += (await sweepMirror()).removed; } catch (error) { log.warn?.('xmpp: mirror sweep failed', error?.message); }
        }
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

  const DEVICE = /^d[0-9a-f]{40}$/;
  const rollout = config.rollout ?? { percent: 0, userIds: new Set() };

  /**
   * 'xmpp' when this user is moved over (and the XMPP core is configured), else 'legacy'. Only users on 'xmpp' get
   * device accounts, appear reachable in device lists and may send or receive through ejabberd, so nobody is sent
   * anything over XMPP while their app still listens on the current path.
   */
  function transportFor(userId) {
    if (!config.enabled || !userId) return 'legacy';
    return rollout.userIds.has(userId) || rolloutBucket(userId) < rollout.percent ? 'xmpp' : 'legacy';
  }
  // A request from mod_hm: HMAC-SHA256 of the exact body under the shared key, sent within OFFLINE_HOOK_MAX_SKEW_SECONDS.
  // Answers the error itself and returns null when the request is not one.
  function signedEvent(request, response) {
    if (!config.enabled) { response.status(404).end(); return null; }
    const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const given = Buffer.from(String(request.get('x-hm-signature') ?? ''), 'utf8');
    const expected = Buffer.from(signOfflineHook(config.secret, raw), 'utf8');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) { response.status(401).json({ error: 'Bad signature.' }); return null; }
    let event;
    try { event = JSON.parse(raw.toString('utf8')); } catch { response.status(400).json({ error: 'Invalid body.' }); return null; }
    if (!event || typeof event !== 'object' || !Number.isInteger(event.ts)) { response.status(400).json({ error: 'Invalid body.' }); return null; }
    if (Math.abs(Math.floor(now() / 1000) - event.ts) > OFFLINE_HOOK_MAX_SKEW_SECONDS) { response.status(400).json({ error: 'Stale request.' }); return null; }
    return event;
  }

  // mod_hm's verdict cache (hm_clear_verdicts): emptied after a block or membership change. Several changes in a
  // moment become one call; a failure only means the old verdicts live out their 30 s.
  let forgetTimer = null;
  function forgetVerdictsSoon() {
    if (!config.enabled || forgetTimer) return;
    forgetTimer = setTimeout(() => {
      forgetTimer = null;
      fetchImpl(`${config.apiUrl}/hm_clear_verdicts`, {
        method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: '{}',
        signal: AbortSignal.timeout(ADMIN_TIMEOUT_MS),
      }).then((response) => { if (!response.ok) console.error('XMPP verdicts not cleared: HTTP', response.status); })
        .catch((error) => console.error('XMPP verdicts not cleared:', error.name));
    }, FORGET_DEBOUNCE_MS);
    forgetTimer.unref?.();
  }

  return {
    config,
    transportFor,
    forgetVerdictsSoon,
    /** A device's XMPP address for device lists, only for users moved over (null otherwise). */
    addressFor(userId, localpart) {
      return localpart && transportFor(userId) === 'xmpp' ? `${localpart}@${config.host}` : null;
    },
    ensureAccount,
    reconcile,
    /** Runs a reconcile without waiting on it (after sign-outs). */
    reconcileSoon() {
      if (config.enabled) reconcile().catch(() => {});
    },
    /** POST /api/v1/xmpp/token: this device's address, a short-lived sign-in token and where to connect. */
    register(app, requireSession) {
      // Which path this user's app should use. Cheap and side-effect free: the app asks before connecting anywhere.
      app.get('/api/v1/xmpp/transport', requireSession, (request, response) => {
        response.set('Cache-Control', 'no-store');
        response.json({ enabled: config.enabled, transport: transportFor(request.session.user_id) });
      });

      app.post('/api/v1/xmpp/token', requireSession, async (request, response) => {
        if (!config.enabled) return response.status(503).json({ error: 'Messaging over XMPP is not enabled on this server.', enabled: false });
        const { user_id: userId, device_id: deviceId } = request.session;
        if (!userId || !deviceId) return response.status(400).json({ error: 'This session has no device.' });
        // Not moved over yet: no account, so nobody can reach this device over XMPP while it listens elsewhere.
        if (transportFor(userId) !== 'xmpp') return response.status(409).json({ error: 'This account still uses the current messaging path.', transport: 'legacy' });
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
        response.json({ enabled: true, transport: 'xmpp', jid, token, expiresAt, websocket: config.websocketUrl });
      });

      // ejabberd stored a message for a device that is offline (mod_hm, offline_message_hook): wake that phone with
      // the usual encrypted push so it connects and collects it. The body is {"to": localpart, "from": localpart of the
      // sending device or "", "ts": seconds}; nothing about the message itself is sent.
      app.post('/api/v1/xmpp/offline', express.raw({ type: () => true, limit: '2kb' }), async (request, response) => {
        const event = signedEvent(request, response);
        if (!event) return;
        if (typeof event.to !== 'string' || !DEVICE.test(event.to)) return response.status(400).json({ error: 'Invalid body.' });
        const device = await accountByLocalpart.get(event.to);
        if (!device) return response.status(202).json({ pushed: 0 });
        const at = now();
        if (at - (lastWake.get(event.to) ?? 0) < WAKE_COALESCE_MS) return response.status(202).json({ pushed: 0, coalesced: true });
        lastWake.set(event.to, at);
        if (lastWake.size > 10_000) for (const [key, value] of lastWake) if (at - value >= WAKE_COALESCE_MS) lastWake.delete(key);
        const sender = typeof event.from === 'string' && DEVICE.test(event.from) ? await accountByLocalpart.get(event.from) : null;
        let pushed = 0;
        const groupId = typeof event.group === 'string' && event.group.length > 0 && event.group.length <= 128 ? event.group : null;
        try { pushed = await wake(device.userId, device.deviceId, { fromUserId: sender?.userId ?? null, groupId }); } catch (error) { log.warn?.('xmpp: wake-up push failed', error?.message); }
        response.status(202).json({ pushed });
      });

      // The VPS health check (deploy/ejabberd/ops/hm-health.sh, every 5 minutes) reports a problem there:
      // {"kind": one of OPS_ALERT_KINDS, "text": short description, "ts": seconds}, signed like the hooks. Sent on to the
      // operations webhook (ALERT_WEBHOOK_URL), at most once per kind per 15 minutes.
      app.post('/api/v1/xmpp/ops-alert', express.raw({ type: () => true, limit: '4kb' }), async (request, response) => {
        const event = signedEvent(request, response);
        if (!event) return;
        if (!OPS_ALERT_KINDS.has(event.kind) || typeof event.text !== 'string' || !event.text.trim()) return response.status(400).json({ error: 'Invalid body.' });
        const sent = await alert(`vps-${event.kind}`, `VPS: ${event.text.trim().slice(0, 300)}`).catch(() => false);
        response.status(202).json({ sent: Boolean(sent) });
      });

      // mod_hm asks before relaying anything from one device to others: {"from": localpart, "to": [localparts],
      // "group": bool, "ts": seconds} -> {"verdicts": {localpart: "allow" | "deny" | "drop"}}. The rules are this
      // server's (index.mjs xmppVerdict); a device unknown here is never allowed. ejabberd caches the answers briefly.
      app.post('/api/v1/xmpp/allow', express.raw({ type: () => true, limit: '64kb' }), async (request, response) => {
        const event = signedEvent(request, response);
        if (!event) return;
        const targets = Array.isArray(event.to) ? event.to : null;
        if (typeof event.from !== 'string' || !DEVICE.test(event.from) || !targets || targets.length === 0 || targets.length > 1024
          || !targets.every((to) => typeof to === 'string' && DEVICE.test(to))) return response.status(400).json({ error: 'Invalid body.' });
        const groupId = typeof event.groupId === 'string' && event.groupId.length > 0 && event.groupId.length <= 128 ? event.groupId : null;
        const found = await accountByLocalpart.get(event.from);
        // A sender or target not moved over (or moved back) is refused: their app uses the current path.
        const sender = found && transportFor(found.userId) === 'xmpp' ? found : null;
        const verdicts = {};
        const byUser = new Map();
        // A group message (fan-out with a group id): the sender must be allowed to post there with the group's current
        // members hash — the checks a group post gets on this server — and each target must be a member.
        const groupOk = groupId && sender ? await groupPost({ groupId, senderUserId: sender.userId, membersHash: typeof event.membersHash === 'string' ? event.membersHash : '' }) : false;
        for (const to of new Set(targets)) {
          const target = sender ? await accountByLocalpart.get(to) : null;
          if (!target || transportFor(target.userId) !== 'xmpp') { verdicts[to] = 'deny'; continue; }
          if (groupId) {
            if (!byUser.has(target.userId)) byUser.set(target.userId, groupOk && await groupMember(groupId, target.userId) ? 'allow' : 'deny');
            verdicts[to] = byUser.get(target.userId);
            continue;
          }
          if (!byUser.has(target.userId)) byUser.set(target.userId, await verdict(sender.userId, target.userId, { group: event.group === true }));
          verdicts[to] = byUser.get(target.userId);
        }
        response.json({ verdicts });
      });
    },
  };
}
