// On-device media encryption, prepared like WhatsApp's media pipeline (mediaKey, file_enc_sha256, direct_path):
// the sender makes a random key per file, encrypts the file before upload, and the key travels inside the
// message, so the media server only ever stores ciphertext.
//
// Not switched on yet (ENCRYPTED_MEDIA_ENABLED): today the server also reads uploads (thumbnails, PDF page counts,
// inline playback by content type), which needs the plain file. Turning this on means sending the descriptor
// with the message (see encodeEncryptedMediaRef) and decrypting on download (decryptMedia) — the formats below
// are versioned so that can happen without breaking older messages.
//
// Format v1: the file is cut into 1 MiB chunks; each chunk is AES-256-GCM with its own nonce (base nonce with the
// chunk index in its last 4 bytes), so large videos are encrypted and decrypted chunk by chunk, never whole in
// memory, and a reordered or truncated file fails to decrypt.

export const ENCRYPTED_MEDIA_ENABLED = false;
export const MEDIA_CRYPTO_VERSION = 1;
export const MEDIA_CHUNK_BYTES = 1024 * 1024;
const TAG_BYTES = 16;
const INFO = new TextEncoder().encode('Hidden Messenger media v1');

function cryptoApi(override) {
  const api = override ?? globalThis.crypto;
  if (!api?.subtle) throw new Error('This device cannot encrypt files (Web Crypto unavailable).');
  return api;
}

const toBase64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromBase64 = (text) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
const hex = (buffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/** A fresh random media key (32 bytes, base64). */
export function generateMediaKey(api) {
  return toBase64(cryptoApi(api).getRandomValues(new Uint8Array(32)));
}

/** HKDF-SHA256(mediaKey) → AES-256-GCM key and a 12-byte base nonce. */
async function deriveKeys(mediaKey, api) {
  const subtle = cryptoApi(api).subtle;
  const material = await subtle.importKey('raw', fromBase64(mediaKey), 'HKDF', false, ['deriveBits']);
  const bits = new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: INFO }, material, 44 * 8));
  const key = await subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { key, nonce: bits.slice(32, 44) };
}

const lastFlag = (index, chunks) => new Uint8Array([index === chunks - 1 ? 1 : 0]);

function chunkNonce(base, index) {
  const nonce = base.slice();
  const view = new DataView(nonce.buffer);
  view.setUint32(8, view.getUint32(8) ^ index);
  return nonce;
}

/**
 * Encrypts a Blob/File chunk by chunk. Resolves { blob, descriptor }: the ciphertext to upload and what the
 * receiver needs to fetch, check and decrypt it ({ v, key, size, chunk, sha256, encSha256, type }).
 */
export async function encryptMedia(file, { mediaKey = generateMediaKey(), api } = {}) {
  const subtle = cryptoApi(api).subtle;
  const { key, nonce } = await deriveKeys(mediaKey, api);
  const chunks = Math.max(1, Math.ceil(file.size / MEDIA_CHUNK_BYTES));
  const parts = [];
  for (let index = 0; index < chunks; index += 1) {
    const plain = new Uint8Array(await file.slice(index * MEDIA_CHUNK_BYTES, (index + 1) * MEDIA_CHUNK_BYTES).arrayBuffer());
    // The last chunk is marked, so a file cut at a chunk boundary does not decrypt as complete.
    parts.push(new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: chunkNonce(nonce, index), additionalData: lastFlag(index, chunks) }, key, plain)));
  }
  const blob = new Blob(parts, { type: 'application/octet-stream' });
  const [sha256, encSha256] = await Promise.all([digestBlob(file, api), digestBlob(blob, api)]);
  return { blob, descriptor: { v: MEDIA_CRYPTO_VERSION, key: mediaKey, size: file.size, chunk: MEDIA_CHUNK_BYTES, sha256, encSha256, type: file.type || '' } };
}

/** Decrypts what encryptMedia produced; rejects a file that was changed, cut short or reordered. */
export async function decryptMedia(blob, descriptor, { api } = {}) {
  if (descriptor?.v !== MEDIA_CRYPTO_VERSION) throw new Error('Unsupported encrypted media version.');
  const subtle = cryptoApi(api).subtle;
  if (await digestBlob(blob, api) !== descriptor.encSha256) throw new Error('The encrypted file does not match its message.');
  const { key, nonce } = await deriveKeys(descriptor.key, api);
  const chunks = Math.max(1, Math.ceil(descriptor.size / descriptor.chunk));
  const parts = [];
  for (let index = 0; index < chunks; index += 1) {
    const start = index * (descriptor.chunk + TAG_BYTES);
    const sealed = new Uint8Array(await blob.slice(start, start + descriptor.chunk + TAG_BYTES).arrayBuffer());
    parts.push(new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: chunkNonce(nonce, index), additionalData: lastFlag(index, chunks) }, key, sealed)));
  }
  const plain = new Blob(parts, { type: descriptor.type || 'application/octet-stream' });
  if (plain.size !== descriptor.size || await digestBlob(plain, api) !== descriptor.sha256) throw new Error('The decrypted file is not the one that was sent.');
  return plain;
}

async function digestBlob(blob, api) {
  // Web Crypto has no streaming hash; the digest reads the whole blob (fine for the sizes encrypted here).
  return hex(await cryptoApi(api).subtle.digest('SHA-256', await blob.arrayBuffer()));
}

/** Message content for an encrypted attachment: "emedia:<mediaId>:<descriptor, base64url JSON>:<filename>". */
export function encodeEncryptedMediaRef(mediaId, descriptor, filename) {
  const packed = btoa(JSON.stringify(descriptor)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `emedia:${mediaId}:${packed}:${filename}`;
}

export function parseEncryptedMediaRef(content) {
  const match = /^emedia:([^:]+):([A-Za-z0-9_-]+):(.*)$/s.exec(typeof content === 'string' ? content : '');
  if (!match) return null;
  try {
    const padded = match[2].replace(/-/g, '+').replace(/_/g, '/');
    const descriptor = JSON.parse(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)));
    return descriptor?.v === MEDIA_CRYPTO_VERSION ? { mediaId: match[1], descriptor, filename: match[3] } : null;
  } catch {
    return null;
  }
}
