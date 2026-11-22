// Notification previews: the first words of a direct message, sealed for one phone so its notification can show
// them the moment the push arrives, before the app (and its ratchet keys, which live in the WebView) has started.
//
// Each phone has a preview key pair (P-256) that only its Android code holds (PreviewKey.java, wrapped by the Android
// Keystore). Its public key is published signed by the device's identity key, so the server cannot swap in its own.
// A sender seals the preview to that key (ECIES: an ephemeral ECDH, HKDF-SHA-256, AES-256-GCM); the sealed preview
// travels inside the encrypted envelope and the server copies it into that phone's push. The server never sees the
// text. Unlike the message itself (Double Ratchet), a preview has no forward secrecy: someone who later extracts the
// phone's preview key and kept old pushes could read those previews. The message proper is unaffected.
//
// Sealed form (base64): ephemeral public key (65) ‖ iv (12) ‖ ciphertext+tag. Plaintext: JSON { t: text, at: ms }.
// Associated data: the sender's user id (a preview cannot be replayed as someone else's); `at` lets the phone drop
// an old one replayed later.
import { PUBLIC_KEY_BYTES, checkPublicKey, concat, cryptoApi, dh, fromBase64, generateDhPair, hkdf, randomBytes, toBase64, utf8, verify } from './primitives.js';

export const PREVIEW_MAX_CHARS = 150;
export const PREVIEW_INFO = 'hm-preview-v1';
const STATEMENT = 'hm-preview-key-v1|';
const IV_BYTES = 12;

/** What the identity key signs: this prefix and the preview public key. */
export const previewKeyStatement = (keyBytes) => concat(utf8(STATEMENT), keyBytes);

/** The first PREVIEW_MAX_CHARS characters (whole code points), one line. */
export function previewText(text) {
  if (typeof text !== 'string') return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  const points = Array.from(flat);
  return points.length > PREVIEW_MAX_CHARS ? `${points.slice(0, PREVIEW_MAX_CHARS - 1).join('')}…` : flat;
}

/** Whether a device's published preview key ({ key, signature }, base64) is signed by its identity signing key. */
export async function validPreviewKey(identitySig, preview, api) {
  try {
    if (!preview || typeof preview.key !== 'string' || typeof preview.signature !== 'string') return false;
    const key = checkPublicKey(fromBase64(preview.key));
    return await verify(fromBase64(identitySig), fromBase64(preview.signature), previewKeyStatement(key), api);
  } catch {
    return false;
  }
}

/** Seals `text` for the phone holding `recipientKey` (base64 public key). `senderId`: the sender's user id. */
export async function sealPreview(recipientKey, text, senderId, { api, now = Date.now() } = {}) {
  const subtle = cryptoApi(api).subtle;
  const recipient = checkPublicKey(fromBase64(recipientKey));
  const ephemeral = await generateDhPair(api);
  const shared = await dh(ephemeral.privateKey, recipient, api);
  const keyBytes = await hkdf(shared, concat(ephemeral.publicKey, recipient), PREVIEW_INFO, 32, api);
  const key = await subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const iv = randomBytes(IV_BYTES, api);
  const plain = utf8(JSON.stringify({ t: previewText(text), at: now }));
  const sealed = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(String(senderId)) }, key, plain));
  return toBase64(concat(ephemeral.publicKey, iv, sealed));
}

/**
 * Opens a sealed preview with the recipient's private key (a CryptoKey with deriveBits) and public key bytes. The
 * phone does this in Java; here for tests and for any non-Android recipient. Null when it does not open.
 */
export async function openPreview(sealedBase64, { privateKey, publicKey }, senderId, api) {
  try {
    const subtle = cryptoApi(api).subtle;
    const sealed = fromBase64(sealedBase64);
    const ephemeral = sealed.subarray(0, PUBLIC_KEY_BYTES);
    const iv = sealed.subarray(PUBLIC_KEY_BYTES, PUBLIC_KEY_BYTES + IV_BYTES);
    const shared = await dh(privateKey, ephemeral, api);
    const keyBytes = await hkdf(shared, concat(ephemeral, publicKey), PREVIEW_INFO, 32, api);
    const key = await subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
    const plain = await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: utf8(String(senderId)) }, key, sealed.subarray(PUBLIC_KEY_BYTES + IV_BYTES));
    const value = JSON.parse(new TextDecoder().decode(plain));
    return typeof value?.t === 'string' && Number.isFinite(value.at) ? { text: value.t, at: value.at } : null;
  } catch {
    return null;
  }
}
