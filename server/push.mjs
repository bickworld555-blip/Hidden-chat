// Firebase Cloud Messaging (HTTP v1) for Android: wakes a phone whose app is closed or in the background when a
// message or call arrives, the way WhatsApp's GcmListenerService is woken. No socket stays open on the phone.
//
// Payloads are wake-ups with ids only (pushBody), encrypted between this server and the device (AES-256-GCM with a
// key the device made and registered): Google relays them but cannot read who wrote; no push carries a name or text.
import { createCipheriv, createSign, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
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
export const pushBody = Object.freeze({
  message: ({ id: messageId, from }) => compact({ t: 'msg', id: id(messageId), from: id(from) }),
  groupMessage: ({ id: messageId, groupId, from }) => compact({ t: 'gmsg', id: id(messageId), groupId: id(groupId), from: id(from) }),
  reaction: ({ id: messageId, from }) => compact({ t: 'react', id: id(messageId), from: id(from) }),
  call: ({ callId, from, mode }) => compact({ t: 'call', callId: id(callId), from: id(from), mode: mode === 'video' ? 'video' : 'voice' }),
  callEnd: ({ callId }) => compact({ t: 'call_end', callId: id(callId) }),
  wake: ({ from, groupId } = {}) => compact({ t: 'xwake', from: id(from), groupId: id(groupId) }),
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

  async function send(token, data, { ttlSeconds = 60, collapseKey } = {}) {
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token,
            data,
            // High priority wakes the phone from Doze at once (messages and calls the user is waiting for).
            android: { priority: 'HIGH', ttl: `${ttlSeconds}s`, ...(collapseKey ? { collapse_key: collapseKey } : {}) },
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
