// Linking a browser to your phone with a QR code (server/linking.mjs), and moving recent chats to it end to end.
//
// The QR holds "hmlink:1:<id>:<secret>:<browser public key>". The phone approves, then encrypts recent chats to
// that key (ECDH P-256 → HKDF → AES-256-GCM) so the server only relays ciphertext. The browser's private key
// never leaves the page and is forgotten once the history arrived.
import { apiFetch } from './api.js';

const QR_PREFIX = 'hmlink:1:';
const INFO = new TextEncoder().encode('Hidden Messenger linked device history v1');
const toBase64 = (bytes) => {
  const view = new Uint8Array(bytes);
  let text = '';
  for (let offset = 0; offset < view.length; offset += 0x8000) text += String.fromCharCode(...view.subarray(offset, offset + 0x8000));
  return btoa(text);
};
const fromBase64 = (text) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

async function json(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error ?? 'Linking failed.'), { status: response.status });
  return body;
}

/** A short description of this browser for the phone's confirmation ("Chrome on Windows"). */
export function browserName(agent = globalThis.navigator?.userAgent ?? '') {
  const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : 'Web browser';
  const system = /Windows/.test(agent) ? 'Windows' : /Mac OS X/.test(agent) ? 'Mac' : /Android/.test(agent) ? 'Android' : /Linux/.test(agent) ? 'Linux' : '';
  return system ? `${browser} on ${system}` : browser;
}

/** Browser side: a new link request with its QR text. Keep `link` (it holds the private key) until linked. */
export async function startLink({ subtle = globalThis.crypto.subtle } = {}) {
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const publicKey = toBase64(await subtle.exportKey('raw', pair.publicKey));
  const created = await json(await apiFetch('/api/v1/link/requests', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ publicKey, deviceName: browserName() }),
  }));
  return { ...created, privateKey: pair.privateKey, qr: `${QR_PREFIX}${created.id}:${created.secret}:${publicKey}` };
}

/** Browser side: waits until the phone approves; resolves the session, or rejects when the code expired. */
export async function waitForApproval(link, { signal } = {}) {
  for (;;) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const body = await json(await apiFetch(`/api/v1/link/requests/${encodeURIComponent(link.id)}?secret=${encodeURIComponent(link.secret)}`, { signal }));
    if (body.status === 'approved') return body.session;
  }
}

/** Phone side: reads a scanned QR. Null when it is not a Hidden Messenger link code. */
export function parseLinkQr(text) {
  const value = String(text ?? '').trim();
  if (!value.startsWith(QR_PREFIX)) return null;
  const [id, secret, publicKey] = value.slice(QR_PREFIX.length).split(':');
  if (!/^[A-Za-z0-9_-]{16}$/.test(id ?? '') || !/^[A-Za-z0-9_-]{22}$/.test(secret ?? '') || !/^[A-Za-z0-9+/]{87}=$/.test(publicKey ?? '')) return null;
  return { id, secret, publicKey };
}

async function historyKey(privateKey, publicKeyB64, subtle) {
  const publicKey = await subtle.importKey('raw', fromBase64(publicKeyB64), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  const material = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: INFO }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Phone side: encrypts `data` (a chats snapshot, src/backup.js buildBackupData) to the browser's key. */
export async function sealHistory(data, browserPublicKey, { subtle = globalThis.crypto.subtle } = {}) {
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const key = await historyKey(pair.privateKey, browserPublicKey, subtle);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const sealed = await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(data)));
  return { ephemeralKey: toBase64(await subtle.exportKey('raw', pair.publicKey)), iv: toBase64(iv), data: toBase64(sealed) };
}

/** Browser side: opens what sealHistory made with this browser's private key. */
export async function openHistory(sealed, privateKey, { subtle = globalThis.crypto.subtle } = {}) {
  const key = await historyKey(privateKey, sealed.ephemeralKey, subtle);
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(sealed.iv) }, key, fromBase64(sealed.data));
  return JSON.parse(new TextDecoder().decode(plain));
}

/** Phone side: the newest messages of each chat, so the snapshot stays small (and fits the server's limit). */
export function recentSnapshot(messagesByChat, perChat = 200) {
  return Object.fromEntries(Object.entries(messagesByChat ?? {}).map(([chat, list]) => [chat, (list ?? []).slice(-perChat)]));
}

/** Phone side: approve a scanned (or typed) link and, when the browser's key came by QR, send recent chats. */
export async function approveLink(token, { id, secret, code }, buildSnapshot) {
  const approved = await json(await apiFetch(`/api/v1/link/requests/${encodeURIComponent(id)}/approve`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(secret ? { secret } : { code }),
  }));
  if (approved.historyKey && buildSnapshot) {
    const sealed = await sealHistory(buildSnapshot(), approved.historyKey);
    await json(await apiFetch(`/api/v1/link/requests/${encodeURIComponent(id)}/history`, {
      method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(sealed),
    })).catch(() => null);
  }
  return approved;
}

export async function lookupLink(token, query) {
  return json(await apiFetch('/api/v1/link/lookup', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(query),
  }));
}

// The browser keeps the link (id, secret, private key) until the history arrived after sign-in.
let pendingHistory = null;
export const rememberPendingHistory = (link) => { pendingHistory = link; };

/** Browser side, after sign-in: fetch and open the history the phone sent (null when there is none). */
export async function takePendingHistory() {
  const link = pendingHistory;
  pendingHistory = null;
  if (!link) return null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await apiFetch(`/api/v1/link/requests/${encodeURIComponent(link.id)}/history?secret=${encodeURIComponent(link.secret)}`);
    if (response.status === 200) return openHistory(await response.json(), link.privateKey);
    if (response.status !== 204) return null;
  }
  return null;
}
