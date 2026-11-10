// End-to-end encryption foundation (WhatsApp/Signal style), ready for a real protocol to be plugged in.
//
// What exists now:
//   • An identity key pair per device (ECDH P-256 via Web Crypto). The private key is created non-extractable and
//     kept in IndexedDB; only the public key leaves the device (PUT /api/v1/me/identity-key).
//   • A key directory: fetch a contact's public key (GET /api/v1/users/:id/identity-key), cached.
//   • A safety number (like WhatsApp's security code) from both public keys, the same on both phones.
//   • A message-cipher slot: messages pass through the registered cipher. The default changes nothing; a real
//     cipher (e.g. a double ratchet keyed from these identities) registers itself with setMessageCipher().
//   • Envelope formats reserved: "e2e1:<base64>" for messages, "emedia:" for encrypted attachments (mediaCrypto.js).
//   • Calls: the DTLS fingerprints of a call's SDP are what an identity signature will cover, so a relay or server
//     cannot sit in the middle of a call unnoticed.
import { get, set } from 'idb-keyval';
import { apiFetch } from './api.js';

export const IDENTITY_ALGORITHM = 'ECDH-P256';
export const E2E_MESSAGE_PREFIX = 'e2e1:';
const IDENTITY_STORE_KEY = 'hm:identity-key-v1';

const toBase64 = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer)));
const fromBase64 = (text) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

/** This device's identity: { privateKey (CryptoKey, not extractable), publicKey (base64 SPKI) }, made once. */
export async function getIdentity({ storage = { get, set }, subtle = globalThis.crypto?.subtle } = {}) {
  const stored = await storage.get(IDENTITY_STORE_KEY).catch(() => null);
  if (stored?.privateKey && stored?.publicKey) return stored;
  if (!subtle) throw new Error('This device cannot create encryption keys (Web Crypto unavailable).');
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const identity = { privateKey: pair.privateKey, publicKey: toBase64(await subtle.exportKey('spki', pair.publicKey)), createdAt: Date.now() };
  await storage.set(IDENTITY_STORE_KEY, identity);
  return identity;
}

/** Publishes this device's public key for the signed-in account (idempotent). */
export async function publishIdentity(sessionToken, { identity, fetchImpl = apiFetch } = {}) {
  if (!sessionToken) return false;
  const { publicKey } = identity ?? await getIdentity();
  const response = await fetchImpl('/api/v1/me/identity-key', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey, algorithm: IDENTITY_ALGORITHM }),
  });
  return response.ok;
}

/** A contact's public key directory with a small cache; `invalidate(userId)` after an identity:changed event. */
export function createKeyDirectory({ fetchImpl = apiFetch } = {}) {
  const cache = new Map();
  return {
    async keyFor(userId, sessionToken) {
      if (cache.has(userId)) return cache.get(userId);
      const response = await fetchImpl(`/api/v1/users/${encodeURIComponent(userId)}/identity-key`, { headers: { Authorization: `Bearer ${sessionToken}` } });
      const entry = response.ok ? await response.json() : null;
      cache.set(userId, entry);
      return entry;
    },
    invalidate(userId) {
      cache.delete(userId);
    },
  };
}

/**
 * Safety number for two public keys: 60 digits in 12 groups of 5, identical on both phones (keys are sorted), like
 * WhatsApp's security code. Comparing it in person proves no one replaced either key.
 */
export async function safetyNumber(publicKeyA, publicKeyB, subtle = globalThis.crypto?.subtle) {
  const [first, second] = [publicKeyA, publicKeyB].sort();
  let digest = new Uint8Array([...fromBase64(first), ...fromBase64(second)]);
  // Iterated so that guessing a colliding key is expensive.
  for (let round = 0; round < 1024; round += 1) digest = new Uint8Array(await subtle.digest('SHA-256', digest));
  const groups = [];
  for (let index = 0; index < 12; index += 1) {
    const value = ((digest[(index * 2) % 32] << 16) | (digest[(index * 2 + 1) % 32] << 8) | digest[(index * 2 + 5) % 32]) % 100000;
    groups.push(String(value).padStart(5, '0'));
  }
  return groups.join(' ');
}

/** The app's shared directory of contacts' public keys. */
export const keyDirectory = createKeyDirectory();

// --- Message cipher slot ---------------------------------------------------------------------------------
// A cipher has { id, encrypt(peerId, text) → content, decrypt(peerId, content) → text }; both may be async.
export const PLAINTEXT_CIPHER = Object.freeze({
  id: 'none',
  encrypt: async (_peerId, text) => text,
  decrypt: async (_peerId, content) => content,
});
let activeCipher = PLAINTEXT_CIPHER;

export function setMessageCipher(cipher) {
  if (!cipher || typeof cipher.encrypt !== 'function' || typeof cipher.decrypt !== 'function') throw new Error('A cipher needs encrypt() and decrypt().');
  activeCipher = cipher;
}

export function getMessageCipher() {
  return activeCipher;
}

export function isEncryptedContent(content) {
  return typeof content === 'string' && content.startsWith(E2E_MESSAGE_PREFIX);
}

/** Outgoing text through the active cipher (unchanged with the default). */
export function sealOutgoing(peerId, text) {
  return Promise.resolve(activeCipher.encrypt(peerId, text));
}

/** Incoming content through the active cipher; plain content always passes unchanged. */
export async function openIncoming(peerId, content) {
  if (!isEncryptedContent(content)) return content;
  return activeCipher.decrypt(peerId, content);
}

// --- Calls ----------------------------------------------------------------------------------------------
/** The DTLS fingerprints in an SDP, sorted: what an identity signature over a call offer/answer will cover. */
export function callFingerprints(sdp) {
  return [...String(sdp ?? '').matchAll(/^a=fingerprint:(\S+) ([0-9A-Fa-f:]+)\s*$/gm)]
    .map(([, hash, value]) => `${hash.toLowerCase()} ${value.toUpperCase()}`)
    .sort();
}
