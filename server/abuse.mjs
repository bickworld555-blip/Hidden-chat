// Abuse limits: how fast one account may send messages, and how many accounts one network address may create.
// Generous enough that people never meet them; spam scripts do.
//
// The client's address: behind the hosting proxies the socket address is the proxy's, so the address comes from
// X-Forwarded-For, counted from the right: each trusted proxy appends the address it received from, and anything to
// the left of those entries was written by the client and could be forged. RELAY_TRUST_PROXY_HOPS = the number of
// proxies in front of the app.

import { createHmac } from 'node:crypto';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const DEFAULT_LIMITS = Object.freeze({
  trustProxyHops: 1,
  // Messages, per account (direct and group together).
  messages: [{ limit: 30, windowMs: 10 * SECOND }, { limit: 1000, windowMs: HOUR }],
  // New accounts, per client address.
  signups: [{ limit: 10, windowMs: HOUR }, { limit: 30, windowMs: DAY }],
  // Exact username lookups and invite-link redemptions, per account: plenty for people, too few to list accounts.
  lookups: [{ limit: 60, windowMs: HOUR }, { limit: 300, windowMs: DAY }],
});

const intOr = (value, fallback, { min = 0, max = 1_000_000 } = {}) => {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
};

/**
 * The limits in force: on in production (or with RELAY_ABUSE_LIMITS=1), off elsewhere so tests and development can
 * create accounts freely (RELAY_ABUSE_LIMITS=0 turns them off anywhere).
 */
export function abuseLimitsFromEnv(env = process.env, { production = env.NODE_ENV === 'production' || Boolean(env.DATABASE_URL) } = {}) {
  const on = env.RELAY_ABUSE_LIMITS === '1' || (production && env.RELAY_ABUSE_LIMITS !== '0');
  if (!on) return null;
  return {
    trustProxyHops: intOr(env.RELAY_TRUST_PROXY_HOPS, DEFAULT_LIMITS.trustProxyHops, { max: 5 }),
    messages: [
      { limit: intOr(env.RELAY_MESSAGES_PER_10S, 30, { min: 1 }), windowMs: 10 * SECOND },
      { limit: intOr(env.RELAY_MESSAGES_PER_HOUR, 1000, { min: 1 }), windowMs: HOUR },
    ],
    signups: [
      { limit: intOr(env.RELAY_SIGNUPS_PER_HOUR, 10, { min: 1 }), windowMs: HOUR },
      { limit: intOr(env.RELAY_SIGNUPS_PER_DAY, 30, { min: 1 }), windowMs: DAY },
    ],
    lookups: [
      { limit: intOr(env.RELAY_LOOKUPS_PER_HOUR, 60, { min: 1 }), windowMs: HOUR },
      { limit: intOr(env.RELAY_LOOKUPS_PER_DAY, 300, { min: 1 }), windowMs: DAY },
    ],
  };
}

/** The address entries a request carries: the X-Forwarded-For chain (left to right) and the socket's. */
export function addressChain(request) {
  const header = String(request.get?.('x-forwarded-for') ?? request.headers?.['x-forwarded-for'] ?? '');
  const forwarded = header.split(',').map((part) => part.trim()).filter(Boolean);
  const socket = request.socket?.remoteAddress ?? request.connection?.remoteAddress ?? '';
  return { forwarded, socket };
}

/**
 * The client's address, trusting `hops` proxies: the entry each of them appended counts from the right of the chain
 * (the socket address being the nearest proxy). With no proxies trusted, the socket address. Null when unknown.
 */
export function clientAddress(request, hops) {
  const { forwarded, socket } = addressChain(request);
  if (!hops) return socket || null;
  // Proxies 1..hops: the nearest is the socket; each further one appended to X-Forwarded-For.
  const index = forwarded.length - hops;
  return index >= 0 ? forwarded[index] || null : null;
}

/** SQLite side of the shared counters (Postgres: supabase/migrations/021_rate_limits.sql). */
export function ensureRateLimitSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS rate_limit_hits (
    key TEXT NOT NULL, window_start INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (key, window_start)
  )`);
}

/**
 * Fixed-window counters kept in the database, so every server process and every restart sees the same counts
 * (counters in memory reset on each deploy and are split between processes). Keys are stored as an HMAC under
 * `secret`, never as the address or account id. `hit` resolves to the wait in ms when a limit is exceeded, else 0.
 */
export function createSharedRateLimiter({ db, secret, now = () => Date.now() }) {
  const keyOf = (key) => createHmac('sha256', secret).update(key).digest('hex').slice(0, 40);
  return {
    async hit(key, rules) {
      const at = now();
      const hashed = keyOf(key);
      let wait = 0;
      for (const { limit, windowMs } of rules) {
        const start = Math.floor(at / windowMs) * windowMs;
        const row = await db.prepare(`INSERT INTO rate_limit_hits(key, window_start, count) VALUES (?, ?, 1)
          ON CONFLICT(key, window_start) DO UPDATE SET count = rate_limit_hits.count + 1 RETURNING count`).get(`${hashed}|${windowMs}`, start);
        if (Number(row?.count ?? 0) > limit) wait = Math.max(wait, start + windowMs - at);
      }
      return wait;
    },
    /** Deletes windows that have ended (run with the server's other housekeeping). */
    async sweep(maxWindowMs = 24 * 60 * 60 * 1000) {
      await db.prepare('DELETE FROM rate_limit_hits WHERE window_start < ?').run(now() - maxWindowMs);
    },
  };
}

export const tooManyMessages = (waitMs) => ({
  error: `You're sending messages too fast. Try again in ${Math.max(1, Math.ceil(waitMs / 1000))} seconds.`,
  code: 'rate_limited',
  retryAfterMs: waitMs,
});

export const tooManySignups = (waitMs) => ({
  error: 'Too many new accounts from this network. Try again later.',
  code: 'rate_limited',
  retryAfterMs: waitMs,
});
