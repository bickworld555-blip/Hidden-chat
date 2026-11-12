// Linking a browser to your phone with a QR code (server/linking.mjs), and moving recent chats to it end to end.
//
// The QR holds "hmlink:1:<id>:<secret>:<browser public key>". The phone approves, then encrypts the chat history
// to that key (ECDH P-256 → HKDF → AES-256-GCM) so the server only relays ciphertext, in parts: the newest
// messages of every chat first, then older ones (historyParts). With the typed code the key reaches the phone
// through the server, so both screens show its security code (keyFingerprint) and history is sent only after
// the person confirms they match. The browser's private key never leaves the page and is forgotten afterwards.
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
  return { ...created, publicKey, privateKey: pair.privateKey, qr: `${QR_PREFIX}${created.id}:${created.secret}:${publicKey}` };
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

/** A key's security code: 20 digits in groups of five, from SHA-256 of the raw public key (about 66 bits). */
export async function keyFingerprint(publicKeyB64, { subtle = globalThis.crypto.subtle } = {}) {
  const digest = new Uint8Array(await subtle.digest('SHA-256', fromBase64(publicKeyB64)));
  const groups = [];
  for (let index = 0; index < 4; index += 1) {
    const chunk = digest.slice(index * 5, index * 5 + 5).reduce((value, byte) => value * 256 + byte, 0);
    groups.push(String(chunk % 100000).padStart(5, '0'));
  }
  return groups.join(' ');
}

export const FIRST_PART_PER_CHAT = 200;
export const MESSAGES_PER_PART = 2000;
const PART_BYTES = 8 * 1024 * 1024;

/**
 * Phone side: the history to send, in parts. Part 0 is the snapshot with the newest FIRST_PART_PER_CHAT messages
 * of every chat (the new device is usable at once); then older messages, newest first, MESSAGES_PER_PART at a
 * time (fewer when big messages would pass PART_BYTES). Every part is a valid chats snapshot (src/backup.js).
 */
export function historyParts(data, { firstPerChat = FIRST_PART_PER_CHAT, perPart = MESSAGES_PER_PART, maxBytes = PART_BYTES } = {}) {
  const all = data?.messages ?? {};
  const parts = [{ ...data, messages: recentSnapshot(all, firstPerChat) }];
  const older = Object.entries(all).map(([chat, list]) => [chat, (list ?? []).slice(0, Math.max(0, (list ?? []).length - firstPerChat))]);
  const base = { kind: 'chats', createdAt: data?.createdAt, account: data?.account, chats: [], callLogs: [], preferences: {}, groups: [] };
  let current = {};
  let count = 0;
  let bytes = 0;
  const flush = () => { if (count) parts.push({ ...base, messages: current }); current = {}; count = 0; bytes = 0; };
  // Walk back in time across chats, one message at a time from each chat's newest remaining end.
  const cursors = older.map(([chat, list]) => ({ chat, list, at: list.length - 1 })).filter((cursor) => cursor.at >= 0);
  while (cursors.length) {
    cursors.sort((a, b) => String(b.list[b.at].timestamp).localeCompare(String(a.list[a.at].timestamp)));
    const cursor = cursors[0];
    const message = cursor.list[cursor.at];
    const size = JSON.stringify(message).length;
    if (count && (count >= perPart || bytes + size > maxBytes)) flush();
    (current[cursor.chat] ??= []).unshift(message);
    count += 1;
    bytes += size;
    cursor.at -= 1;
    if (cursor.at < 0) cursors.shift();
  }
  flush();
  return parts;
}

/** Phone side: the newest messages of each chat, so the first part is small and arrives first. */
export function recentSnapshot(messagesByChat, perChat = 200) {
  return Object.fromEntries(Object.entries(messagesByChat ?? {}).map(([chat, list]) => [chat, (list ?? []).slice(-perChat)]));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Phone side: approve a scanned (or typed) link, then stream the history (buildHistory() = a chats snapshot with
 * every message). The QR path trusts the key from the QR; the typed-code path sends history only when the person
 * confirmed the security codes match (confirmedKey = the key they compared). onProgress(sentParts, totalParts).
 */
export async function approveLink(token, { id, secret, code, publicKey, confirmedKey }, buildHistory, { onProgress } = {}) {
  const approved = await json(await apiFetch(`/api/v1/link/requests/${encodeURIComponent(id)}/approve`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(secret ? { secret } : { code }),
  }));
  // Which key to encrypt to: the QR's own key, or on the code path the key the person verified (and only if the
  // server still reports that same key).
  const key = secret ? publicKey : confirmedKey && confirmedKey === approved.historyKey ? confirmedKey : null;
  if (!key || !buildHistory) return { ...approved, historySent: false };
  const parts = historyParts(await buildHistory());
  for (let index = 0; index < parts.length; index += 1) {
    const sealed = await sealHistory(parts[index], key);
    for (let attempt = 0; ; attempt += 1) {
      const response = await apiFetch(`/api/v1/link/requests/${encodeURIComponent(id)}/history?part=${index}${index === parts.length - 1 ? '&final=1' : ''}`, {
        method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(sealed),
      });
      if (response.ok) break;
      // 429: the new device is still opening earlier parts. Anything else (expired, closed) ends the transfer.
      if (response.status !== 429 || attempt > 240) return { ...approved, historySent: index > 0, partsSent: index, partsTotal: parts.length };
      await sleep(1000);
    }
    onProgress?.(index + 1, parts.length);
  }
  return { ...approved, historySent: true, partsSent: parts.length, partsTotal: parts.length };
}

export async function lookupLink(token, query) {
  return json(await apiFetch('/api/v1/link/lookup', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(query),
  }));
}

// The browser keeps the link (id, secret, private key) until the history arrived after sign-in.
let pendingHistory = null;
export const rememberPendingHistory = (link) => { pendingHistory = link; };

/**
 * Browser side, after sign-in: receive the history part by part and hand each opened part to onPart (merged by
 * the caller). Resolves with the number of parts received. Waits up to about a minute for the first part (the
 * phone may still be confirming security codes) and for each later one.
 */
export async function takePendingHistory(onPart) {
  const link = pendingHistory;
  pendingHistory = null;
  if (!link) return 0;
  let part = 0;
  for (let quiet = 0; quiet < 3;) {
    const response = await apiFetch(`/api/v1/link/requests/${encodeURIComponent(link.id)}/history?secret=${encodeURIComponent(link.secret)}&part=${part}`);
    if (response.status === 204) { quiet += 1; continue; }
    if (response.status !== 200) break;
    const body = await response.json();
    await onPart(await openHistory(body, link.privateKey), part);
    part += 1;
    quiet = 0;
    if (body.final) break;
  }
  return part;
}
