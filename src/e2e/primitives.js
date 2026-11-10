// Cryptographic primitives for the end-to-end protocol (src/e2e/), on Web Crypto only (no third-party code).
//
// Curve: NIST P-256 for Diffie-Hellman (ECDH) and signatures (ECDSA, SHA-256): supported by every WebView and
// browser the app runs in. Signal's specifications (X3DH, Double Ratchet, Sender Keys) are curve-agnostic; their
// reference curve X25519 is not available in older Android WebViews.
//
// Secrets at rest are non-extractable CryptoKeys (private keys, root and chain keys, skipped message keys): the
// app's scripts can use them but never read their bytes. Only short-lived derivation outputs exist as bytes.

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DH = { name: 'ECDH', namedCurve: 'P-256' };
const SIG = { name: 'ECDSA', namedCurve: 'P-256' };
const SIG_PARAMS = { name: 'ECDSA', hash: 'SHA-256' };
const HMAC = { name: 'HMAC', hash: 'SHA-256' };
export const PUBLIC_KEY_BYTES = 65; // uncompressed P-256 point

export function cryptoApi(override) {
  const api = override ?? globalThis.crypto;
  if (!api?.subtle) throw new Error('This device cannot encrypt messages (Web Crypto unavailable).');
  return api;
}

export const utf8 = (text) => encoder.encode(text);
export const fromUtf8 = (bytes) => decoder.decode(bytes);

export function toBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text = '';
  for (let offset = 0; offset < view.length; offset += 0x8000) text += String.fromCharCode(...view.subarray(offset, offset + 0x8000));
  return btoa(text);
}

export function fromBase64(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error('Invalid base64.');
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

export function concat(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function equalBytes(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left[index] ^ right[index];
  return diff === 0;
}

export function randomBytes(length, api) {
  return cryptoApi(api).getRandomValues(new Uint8Array(length));
}

/** A P-256 point as sent on the wire: 65 bytes, uncompressed. Anything else is refused before use. */
export function checkPublicKey(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== PUBLIC_KEY_BYTES || bytes[0] !== 4) throw new Error('Invalid public key.');
  return bytes;
}

/** { privateKey: CryptoKey (non-extractable), publicKey: Uint8Array(65) } */
export async function generateDhPair(api) {
  const subtle = cryptoApi(api).subtle;
  const pair = await subtle.generateKey(DH, false, ['deriveBits']);
  return { privateKey: pair.privateKey, publicKey: new Uint8Array(await subtle.exportKey('raw', pair.publicKey)) };
}

export async function generateSigningPair(api) {
  const subtle = cryptoApi(api).subtle;
  const pair = await subtle.generateKey(SIG, false, ['sign', 'verify']);
  return { privateKey: pair.privateKey, publicKey: new Uint8Array(await subtle.exportKey('raw', pair.publicKey)) };
}

/** ECDH(private, public) → 32 bytes. */
export async function dh(privateKey, publicKeyBytes, api) {
  const subtle = cryptoApi(api).subtle;
  const publicKey = await subtle.importKey('raw', checkPublicKey(publicKeyBytes), DH, false, []);
  return new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256));
}

export async function sign(privateKey, data, api) {
  return new Uint8Array(await cryptoApi(api).subtle.sign(SIG_PARAMS, privateKey, data));
}

export async function verify(publicKeyBytes, signature, data, api) {
  const subtle = cryptoApi(api).subtle;
  try {
    const key = await subtle.importKey('raw', checkPublicKey(publicKeyBytes), SIG, false, ['verify']);
    return await subtle.verify(SIG_PARAMS, key, signature, data);
  } catch {
    return false;
  }
}

/** HKDF-SHA-256 with a byte salt (RFC 5869). */
export async function hkdf(ikm, salt, info, length, api) {
  const subtle = cryptoApi(api).subtle;
  const material = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: utf8(info) }, material, length * 8));
}

/** A non-extractable HMAC-SHA-256 key from bytes (the bytes are wiped). */
export async function hmacKey(bytes, api) {
  const key = await cryptoApi(api).subtle.importKey('raw', bytes, HMAC, false, ['sign']);
  bytes.fill(0);
  return key;
}

export async function hmac(key, data, api) {
  return new Uint8Array(await cryptoApi(api).subtle.sign('HMAC', key, data));
}

/**
 * HKDF where the salt is a non-extractable HMAC key (the Double Ratchet's root key): extract = HMAC(salt, ikm),
 * then the RFC 5869 expand. Returns `length` bytes (at most 64 here).
 */
export async function hkdfWithKeySalt(saltKey, ikm, info, length, api) {
  const prk = await hmacKey(await hmac(saltKey, ikm, api), api);
  const infoBytes = utf8(info);
  const blocks = [];
  let previous = new Uint8Array(0);
  for (let counter = 1; blocks.length * 32 < length; counter += 1) {
    previous = await hmac(prk, concat(previous, infoBytes, new Uint8Array([counter])), api);
    blocks.push(previous);
  }
  return concat(...blocks).slice(0, length);
}

/** A message key (32 bytes) → a non-extractable AES-256-GCM key and its 12-byte nonce. Wipes the message key. */
export async function messageCipher(messageKey, info, api) {
  const okm = await hkdf(messageKey, new Uint8Array(32), info, 44, api);
  messageKey.fill(0);
  const key = await cryptoApi(api).subtle.importKey('raw', okm.subarray(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const iv = okm.slice(32, 44);
  okm.fill(0);
  return { key, iv };
}

export async function aeadEncrypt({ key, iv }, plaintext, ad, api) {
  return new Uint8Array(await cryptoApi(api).subtle.encrypt({ name: 'AES-GCM', iv, additionalData: ad }, key, plaintext));
}

export async function aeadDecrypt({ key, iv }, ciphertext, ad, api) {
  return new Uint8Array(await cryptoApi(api).subtle.decrypt({ name: 'AES-GCM', iv, additionalData: ad }, key, ciphertext));
}

export async function sha256Hex(data, api) {
  const digest = new Uint8Array(await cryptoApi(api).subtle.digest('SHA-256', typeof data === 'string' ? utf8(data) : data));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
