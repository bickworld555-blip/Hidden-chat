// Firebase Cloud Messaging (HTTP v1) for Android: wakes a phone whose app is closed or in the background when a
// message or call arrives, the way WhatsApp's GcmListenerService is woken. No socket stays open on the phone.
//
// Payloads are wake-ups with ids only (pushBody), encrypted between this server and the device (AES-256-GCM with a
// key the device made and registered): Google relays them but cannot read who wrote; no push carries a name or text.
// Nothing beside the ciphertext is in the clear either: the data is { enc, iv } (the type is inside), and collapse keys
// are per-device HMACs (deviceCollapseKey), so Firebase cannot tell a call from a message or link a push to a chat.
import { createCipheriv, createHmac, createSign, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
// How long Firebase keeps a push for a phone that is offline: its maximum, 4 weeks (like WhatsApp, a phone that comes
// back after days still gets what it missed). Only ringing and its end are short (their callers pass ttlSeconds).
// It was 60 s: a phone offline for longer lost every notification and showed nothing when it reconnected.
export const PUSH_TTL_SECONDS = 28 * 24 * 60 * 60;
// A wake-up with a few ids is under 300 bytes; FCM's limit is 4 KB.
const MAX_PLAINTEXT_BYTES = 512;

/**
 * The Firebase service account the server sends with: FCM_SERVICE_ACCOUNT (the JSON itself) or
 * FCM_SERVICE_ACCOUNT_FILE (a path to it). Returns null when neither is set (push stays off).
 */
export function loadServiceAccount(env = process.env) {
  let raw = env.FCM_SERVICE_ACCOUNT?.trim();
  if (!raw && env.FCM_SERVICE_ACCOUNT_FILE) raw = readFileSync(env.FCM_SERVICE_ACCOUNT_FILE, 'utf8');
  if (!raw) return null;
  const account = JSON.parse(raw);
  for (const field of ['project_id', 'client_email', 'private_key']) {
    if (typeof account[field] !== 'string' || !account[field]) throw new Error(`The Firebase service account is missing ${field}.`);
  }
  return account;
}

// What a push may say: a wake-up and the ids the phone needs to find the chat. No names, no avatars, no text, no
// emoji. The phone shows the names it keeps locally (handed over by the app, RelaySession) and opens the content
// itself, as WhatsApp's wake-up pushes leave everything to the app. Every body is built here, and nowhere else.
const id = (value) => (typeof value === 'string' && value ? value : undefined);
const compact = (body) => Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));

/**
 * The push id (`pid`): one event, one id, however many times or ways it reaches the phone (a retried push, the same
 * wake-up over Firebase and over the always-connected socket). The phone handles each id once (PushDedup.java) and the
 * server sends each id to a phone once within PUSH_TUNING.dedupWindowMs. Derived from the event's own id where there
 * is one (so both paths agree), random otherwise. It is inside the encrypted body, like everything else.
 */
export function pushId(prefix, eventId) {
  const own = id(eventId);
  return `${prefix}:${own ? own.slice(0, 80) : randomBytes(9).toString('base64url')}`;
}

// Sealed previews by device id: only well-formed base64 of a plausible size (an FCM payload is at most 4 KB).
export const MAX_PREVIEW_CHARS = 1400;
export function previews(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const kept = {};
  for (const [deviceId, sealed] of Object.entries(value).slice(0, 20)) {
    if (typeof deviceId === 'string' && deviceId.length <= 80 && typeof sealed === 'string' && sealed.length <= MAX_PREVIEW_CHARS && /^[A-Za-z0-9+/]+={0,2}$/.test(sealed)) kept[deviceId] = sealed;
  }
  return Object.keys(kept).length ? kept : undefined;
}

/** The body one phone receives: its own sealed preview as `pv` (if any), never the others'. */
export function bodyForDevice(body, deviceId) {
  if (!body || !body.pvs) return body;
  const { pvs, ...rest } = body;
  const own = deviceId ? pvs[deviceId] : undefined;
  return own ? { ...rest, pv: own } : rest;
}

export const pushBody = Object.freeze({
  // `pvs`: { deviceId: sealed preview } from the sender (src/e2e/preview.js); each phone gets only its own, as `pv`.
  message: ({ id: messageId, from, pvs }) => compact({ t: 'msg', pid: pushId('m', messageId), id: id(messageId), from: id(from), pvs: previews(pvs) }),
  groupMessage: ({ id: messageId, groupId, from }) => compact({ t: 'gmsg', pid: pushId('g', messageId), id: id(messageId), groupId: id(groupId), from: id(from) }),
  // Each reaction is its own event (a second emoji on the same message notifies again).
  reaction: ({ id: messageId, from }) => compact({ t: 'react', pid: pushId('r'), id: id(messageId), from: id(from) }),
  call: ({ callId, from, mode }) => compact({ t: 'call', pid: pushId('c', callId), callId: id(callId), from: id(from), mode: mode === 'video' ? 'video' : 'voice' }),
  // reason 'declined': the callee declined it on another device (the phone stops ringing without a missed call).
  callEnd: ({ callId, reason }) => compact({ t: 'call_end', pid: pushId('e', callId), callId: id(callId), reason: reason === 'declined' ? 'declined' : undefined }),
  // A call this phone never rang for (it was offline): shown as a missed call when it reconnects.
  missedCall: ({ callId, from, mode }) => compact({ t: 'missed', pid: pushId('x', callId), callId: id(callId), from: id(from), mode: mode === 'video' ? 'video' : 'voice' }),
  // `messageId`: the message that caused it (the same pid over Firebase and the socket); `cfg`: pushCfg(PUSH_TUNING).
  wake: ({ from, groupId, messageId, cfg, pvs } = {}) => compact({ t: 'xwake', pid: pushId('w', messageId), id: id(messageId), from: id(from), groupId: id(groupId), cfg: cfg && typeof cfg === 'object' ? cfg : undefined, pvs: previews(pvs) }),
});

/** A device key as registered by the app: 32 random bytes, base64. */
export function validDeviceKey(value) {
  if (typeof value !== 'string' || value.length > 64) return false;
  try {
    return Buffer.from(value, 'base64').length === 32;
  } catch {
    return false;
  }
}

/**
 * The collapse key Firebase sees for one device: an HMAC of the server's logical key ("call:<id>", "wake") under the
 * device's push key. Firebase can still tell two pushes to the same phone apart or together, but not which chat, group,
 * person or call they belong to, and the same call gets unrelated keys on different phones.
 */
export function deviceCollapseKey(deviceKey, logicalKey) {
  return `k${createHmac('sha256', Buffer.from(deviceKey, 'base64')).update(`collapse:${logicalKey}`).digest('base64url').slice(0, 22)}`;
}

/**
 * Collapse keys the server uses. Firebase keeps at most 4 collapse keys per offline phone, and one wake-up makes the
 * phone fetch everything that waits, so every message wake-up shares one key; a call keeps its own (its "ended"
 * push replaces its ring for a phone that was offline).
 */
export const collapseKeys = Object.freeze({
  wake: 'wake',
  call: (callId) => `call:${callId}`,
});

/** Encrypts a push body for one device: { enc: base64(ciphertext || tag), iv: base64(12 bytes) }. */
export function encryptForDevice(deviceKey, body) {
  const plaintext = Buffer.from(JSON.stringify(body), 'utf8');
  // Bodies are ids only (pushBody); anything bigger is a payload that has no business in a push.
  if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new Error('Push body too large: a push carries ids only.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(deviceKey, 'base64'), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { enc: ciphertext.toString('base64'), iv: iv.toString('base64') };
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

/**
 * Sends FCM data messages with the service account. `send` resolves to { ok } or { ok: false, invalidToken }
 * (the token no longer belongs to an installed app and must be forgotten) or { ok: false, error }.
 */
export function createPushSender({ serviceAccount, fetchImpl = fetch, now = () => Date.now() }) {
  if (!serviceAccount) return null;
  const tokenUri = serviceAccount.token_uri || DEFAULT_TOKEN_URI;
  const endpoint = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(serviceAccount.project_id)}/messages:send`;
  let cached = null;
  let pending = null;

  async function accessToken() {
    if (cached && cached.expiresAt - 60_000 > now()) return cached.token;
    if (pending) return pending;
    pending = (async () => {
      const issuedAt = Math.floor(now() / 1000);
      const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
      const claims = base64url(JSON.stringify({ iss: serviceAccount.client_email, scope: FCM_SCOPE, aud: tokenUri, iat: issuedAt, exp: issuedAt + 3600 }));
      const signer = createSign('RSA-SHA256');
      signer.update(`${header}.${claims}`);
      const assertion = `${header}.${claims}.${signer.sign(serviceAccount.private_key).toString('base64url')}`;
      const response = await fetchImpl(tokenUri, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Firebase sign-in failed (${response.status}).`);
      const result = await response.json();
      cached = { token: result.access_token, expiresAt: now() + Number(result.expires_in ?? 3600) * 1000 };
      return cached.token;
    })().finally(() => { pending = null; });
    return pending;
  }

  async function send(token, data, { ttlSeconds = PUSH_TTL_SECONDS, collapseKey, priority = 'HIGH' } = {}) {
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token,
            data,
            // High priority wakes the phone from Doze at once (messages and calls the user is waiting for); the server
            // picks it per push type (server/pushConfig.mjs fcmPriority).
            android: { priority: priority === 'NORMAL' ? 'NORMAL' : 'HIGH', ttl: `${ttlSeconds}s`, ...(collapseKey ? { collapse_key: collapseKey } : {}) },
          },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return { ok: true };
      const detail = await response.json().catch(() => ({}));
      const code = detail?.error?.details?.find?.((item) => item?.errorCode)?.errorCode ?? detail?.error?.status;
      // Only "this app is no longer installed / registered" forgets a token; other errors may be ours or temporary.
      if (response.status === 404 || code === 'UNREGISTERED') return { ok: false, invalidToken: true };
      if (response.status === 401) cached = null;
      return { ok: false, error: `${response.status} ${code ?? ''}`.trim() };
    } catch (error) {
      return { ok: false, error: error.name === 'TimeoutError' ? 'timeout' : error.message };
    }
  }

  return { send };
}

/**
 * Push ids sent to each phone recently (token + pid -> until when): a retry or a second path for the same event (a
 * late push after DELIVERY_PUSH_MS, a pending-message wake-up) is sent to a phone once per `windowMs`. `seen` records
 * and answers whether it was already sent; `forget` lets a push that failed be retried.
 */
export function createRecentPushes(windowMs, now = () => Date.now()) {
  const until = new Map();
  const keyOf = (token, pid) => `${token}|${pid}`;
  return {
    seen(token, pid) {
      if (!pid) return false;
      const at = now();
      // Insertion order is expiry order (one window for all): drop the expired from the front.
      for (const [key, expires] of until) { if (expires > at) break; until.delete(key); }
      const key = keyOf(token, pid);
      if ((until.get(key) ?? 0) > at) return true;
      until.set(key, at + windowMs);
      return false;
    },
    forget(token, pid) {
      if (pid) until.delete(keyOf(token, pid));
    },
    get size() { return until.size; },
  };
}
