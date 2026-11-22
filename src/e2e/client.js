// The app's end-to-end encryption: one place that seals what this device sends and opens what it receives.
//
//   startE2e(session)          after sign-in: loads this device's keys, publishes them (and refills prekeys)
//   sealDirect(peerId, text)   → "e2e2:…" for every device of the contact and this account's other devices
//   sendGroupContent(...)      seals for the group's devices (Sender Keys) and posts, re-sealing if devices changed
//   openContent(content, ctx)  → { content } plaintext, or { content: '', e2eError } when this device cannot read it
//
// Plaintext this device has seen (sent or decrypted) is remembered by the hash of its ciphertext, encrypted at rest
// (src/secureStorage.js): every copy of a message the server sends again (history, sync, pins, stars) opens
// without touching the ratchet, which can decrypt each message only once.
import { createStore, del as idbDel, get as idbGet, set as idbSet } from 'idb-keyval';
import { apiFetch } from '../api.js';
import { secureGet, secureSet } from '../secureStorage.js';
import { companionOnly } from '../companion.js';
import { createAccountKey, linkClaimMac, listedDevices, MAX_LISTED_DEVICES, pinDecision, signDeviceList, verifyDeviceList } from './deviceList.js';
import { dh as agreeDh, equalBytes, fromBase64 as decodeBase64 } from './primitives.js';
import { createProtocol } from './protocol.js';
import { createBridgeProtocol } from './bridgeProtocol.js';
import { nativeCrypto, nativeRegister } from '../native.js';
import { sealPreview, validPreviewKey } from './preview.js';
import { resolveSecurityCode } from './securityCode.js';
import { buildEnvelope, ENVELOPE_PREFIX, isEnvelope, parseEnvelope, routingFor, withRoutedMedia } from './envelope.js';
import { sha256Hex } from './primitives.js';
import { sanitizePreview } from '../linkPreviewParse.js';
import { cleanDuration, cleanPoster, cleanThumb } from '../mediaThumb.js';
import { cleanDisappear, expiryOf } from './lifecycle.js';

// What travels inside the encryption: { c: content, lp?: link preview made by the sender, r?: the id of the message
// it replies to, fw?: 1 when forwarded }. Replies and forwards are not visible to the server (like Signal).
// A reply to a status carries a small quote of it: { kind: 'text' | 'image' | 'video', text }.
const cleanStatusReply = (value) => (value && typeof value === 'object' && ['text', 'image', 'video', 'file'].includes(value.kind)
  ? {
    kind: value.kind,
    text: typeof value.text === 'string' ? value.text.slice(0, 200) : '',
    ...(value.reaction === true ? { reaction: true } : {}),
    // A text status's background colour, for the little tile on the quote card.
    ...(typeof value.bg === 'string' && /^#[0-9a-f]{6}$/i.test(value.bg) ? { bg: value.bg } : {}),
  } : null);
// A photo's, video's or document's caption (as on WhatsApp: in the same bubble), at most CAPTION_MAX characters.
export const CAPTION_MAX = 1024;
export const cleanCaption = (value) => (typeof value === 'string' ? value.trim().slice(0, CAPTION_MAX) : '');
// Photos and videos sent together (as on WhatsApp) show as one album: { id, i (position), n (count) }.
export const cleanAlbum = (value) => (value && typeof value.id === 'string' && /^[A-Za-z0-9_-]{6,40}$/.test(value.id)
  && Number.isInteger(value.n) && value.n >= 2 && value.n <= 30 && Number.isInteger(value.i) && value.i >= 0 && value.i < value.n
  ? { id: value.id, i: value.i, n: value.n } : null);
// The disappearing timer (seconds) travels inside the encryption too: a message sent over XMPP never passes the server
// that used to enforce it, so each device expires its own copy (src/e2e/lifecycle.js).
export const innerOf = (content, extra = {}) => {
  const linkPreview = sanitizePreview(extra.linkPreview);
  const statusReply = cleanStatusReply(extra.statusReply);
  const replyToId = typeof extra.replyToId === 'string' && extra.replyToId.length < 120 ? extra.replyToId : null;
  const caption = cleanCaption(extra.caption);
  const album = cleanAlbum(extra.album);
  const thumb = cleanThumb(extra.thumb);
  const poster = cleanPoster(extra.poster);
  const duration = cleanDuration(extra.duration);
  const disappear = cleanDisappear(extra.disappearSeconds);
  return { ...(disappear ? { ex: disappear } : {}), ...(thumb ? { th: thumb } : {}), ...(poster ? { pv: poster } : {}), ...(duration ? { du: duration } : {}), c: content, ...(linkPreview ? { lp: linkPreview } : {}), ...(statusReply ? { sr: statusReply } : {}), ...(replyToId ? { r: replyToId } : {}), ...(extra.forwarded ? { fw: 1 } : {}), ...(caption ? { cp: caption } : {}), ...(album ? { al: album } : {}) };
};

/**
 * The reader for innerOf's payload, the one place a decrypted payload is parsed: everything the sender put inside the
 * encryption that this app understands (text, link preview, status reply, the quoted message's id, forwarded), checked,
 * and nothing else. Null when it carries no text.
 */
export const innerFrom = (value) => {
  if (typeof value?.c !== 'string') return null;
  const linkPreview = value.lp ? sanitizePreview(value.lp) : null;
  const statusReply = value.sr ? cleanStatusReply(value.sr) : null;
  return {
    c: value.c,
    ...(linkPreview ? { lp: linkPreview } : {}),
    ...(statusReply ? { sr: statusReply } : {}),
    ...(typeof value.r === 'string' && value.r.length > 0 && value.r.length < 120 ? { r: value.r } : {}),
    ...(value.fw === 1 ? { fw: 1 } : {}),
    ...(cleanCaption(value.cp) ? { cp: cleanCaption(value.cp) } : {}),
    ...(cleanAlbum(value.al) ? { al: cleanAlbum(value.al) } : {}),
    ...(cleanThumb(value.th) ? { th: cleanThumb(value.th) } : {}),
    ...(cleanPoster(value.pv) ? { pv: cleanPoster(value.pv) } : {}),
    ...(cleanDuration(value.du) ? { du: cleanDuration(value.du) } : {}),
    ...(cleanDisappear(value.ex) ? { ex: cleanDisappear(value.ex) } : {}),
  };
};

export const DEVICE_LIST_TTL_MS = 5 * 60 * 1000;
// The longest a cached list is used while a fresh one loads (devicesOf); past it, the send waits for the fetch.
export const DEVICE_LIST_STALE_MS = 60 * 60 * 1000;
export const GROUP_DEVICE_TTL_MS = 60 * 1000;
export const KEY_REFRESH_MS = 6 * 60 * 60 * 1000;
const PLAIN_MEMORY_LIMIT = 4000;
const SEAL_ATTEMPTS = 3;

let current = null;
const deviceLists = new Map();
const groupLists = new Map();
const plainMemory = new Map();
const opening = new Map();
const listeners = new Set();

/** IndexedDB key storage for one device (structured clone keeps CryptoKeys non-extractable). */
export function browserKeyStorage(deviceId) {
  const store = createStore('hm-e2e', 'keys');
  const prefix = `${deviceId}:`;
  return {
    get: (key) => idbGet(prefix + key, store),
    set: (key, value) => idbSet(prefix + key, value, store),
    del: (key) => idbDel(prefix + key, store),
  };
}

function notify(event) {
  for (const listener of listeners) {
    try { listener(event); } catch { /* a listener's failure must not stop the others */ }
  }
}

/**
 * Events: { type: 'identity-changed', userId, deviceId } (a contact's security code changed; deviceId null when their
 * account key changed), { type: 'device-list-excluded' } (another phone set up this account: this device no longer
 * receives until it is linked again).
 */
export function onE2eEvent(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function request(path, { method = 'GET', body } = {}) {
  const session = current;
  if (!session) throw new Error('Not signed in.');
  const response = await session.fetchImpl(path, {
    method,
    headers: { Authorization: `Bearer ${session.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error || 'Request failed.');
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function publishKeys() {
  const session = current;
  const status = await request('/api/v1/e2e/keys');
  const upload = await session.protocol.prepareUpload({ serverPreKeyCount: status.published ? status.preKeys : 0 });
  if (current !== session) return;
  if (!status.published || upload.preKeys.length || status.signedPreKeyId !== upload.signedPreKey.id) {
    await request('/api/v1/e2e/keys', { method: 'PUT', body: upload });
  }
  deviceLists.delete(session.userId);
}

/**
 * Starts encryption for a signed-in device: { token, userId, deviceId }. Safe to call again (same device: no-op).
 * Resolves once this device's keys are published (rejects if that failed; sending still works for contacts).
 */
// `records` keeps pins and pending link approvals (encrypted store); `linkStore` the pending link claim of a device
// linked by QR (written by src/linking.js); `canHoldAccountKey`: phones create and rotate the account key, linked
// browsers and desktops never do. All three are injectable for tests.
export function startE2e({ token, userId, deviceId, storage, useNativeCore = false, fetchImpl = apiFetch, api, records = { get: secureGet, set: secureSet }, linkStore = { get: (key) => idbGet(key), del: (key) => idbDel(key) }, canHoldAccountKey = !companionOnly() } = {}) {
  if (!token || !userId || !deviceId) return Promise.resolve(false);
  if (current?.deviceId === deviceId && current.userId === userId) {
    current.token = token;
    return current.ready;
  }
  stopE2e();
  const session = {
    token,
    userId,
    deviceId,
    fetchImpl,
    api,
    records,
    linkStore,
    canHoldAccountKey,
    // The native app runs every operation in the native core over the bridge (one identity/ratchet per device);
    // otherwise the web protocol with its own key storage.
    protocol: useNativeCore
      ? createBridgeProtocol((method, args) => nativeCrypto(method, args))
      : createProtocol({
        storage: storage ?? browserKeyStorage(deviceId),
        api,
        onIdentityChange: (changedUser, changedDevice) => notify({ type: 'identity-changed', userId: changedUser, deviceId: changedDevice }),
      }),
  };
  current = session;
  if (useNativeCore) {
    // Native owns key publishing and the single account key's device list (NativeRegistration): no duplicate web
    // publishing or device-list signing. The refresh tops up prekeys; the list is published once per install.
    session.ready = Promise.resolve(nativeRegister()).then(() => true);
    session.ready.catch(() => {});
    session.listSync = session.ready;
    session.timer = setInterval(() => { Promise.resolve(nativeRegister()).catch(() => {}); }, KEY_REFRESH_MS);
  } else {
    session.ready = publishKeys().then(() => true);
    session.ready.catch(() => {});
    // The signed device list follows the keys; a failure there never stops sending.
    session.listSync = session.ready.then(() => syncDeviceList()).catch(() => 'failed');
    session.timer = setInterval(() => { publishKeys().then(() => syncDeviceList()).catch(() => {}); }, KEY_REFRESH_MS);
  }
  return session.ready;
}

/**
 * The background page (src/background/main.js): this device's keys opened for reading incoming messages only. No key
 * publishing, no device-list sync, no timers, no writes to the encrypted records (`records` is the page's memory),
 * so nothing but the ratchet state (IndexedDB, under the "hm-e2e" lock) changes. Identity changes it meets are
 * handed to `onIdentityChange` so the app can show them later. With `token` and `records` (the app's records, read
 * only: src/secureStorage.js backgroundSecureStorage) it can also send what the app left in its outbox (P6), to the
 * devices the account's pinned signed lists allow, exactly as the app would.
 */
export function openE2eForBackground({ userId, deviceId, token = null, records = null, onIdentityChange = () => {} } = {}) {
  if (!userId || !deviceId) return false;
  stopE2e();
  const memory = new Map();
  current = {
    token, userId, deviceId, fetchImpl: apiFetch, api: undefined,
    records: records ?? { get: async (key) => memory.get(key), set: async (key, value) => { memory.set(key, value); } },
    linkStore: { get: async () => undefined, del: async () => {} },
    canHoldAccountKey: false,
    protocol: createProtocol({ storage: browserKeyStorage(deviceId), onIdentityChange: (changedUser, changedDevice) => onIdentityChange({ userId: changedUser, deviceId: changedDevice }) }),
    ready: Promise.resolve(true),
  };
  return true;
}

/** An end-to-end event that happened while the app was closed (kept by the background page): to the usual listeners. */
export function replayE2eEvent(event) {
  if (event?.type === 'identity-changed' && typeof event.userId === 'string') notify({ type: 'identity-changed', userId: event.userId, deviceId: event.deviceId ?? null });
}

export function stopE2e() {
  if (current?.timer) clearInterval(current.timer);
  if (current?.listTimer) clearInterval(current.listTimer);
  current = null;
  deviceLists.clear();
  groupLists.clear();
  plainMemory.clear();
  opening.clear();
}

export const e2eActive = () => Boolean(current);
/** What the start-up device-list sync found ('created', 'holder', 'member', 'rotated', 'claimed', 'waiting', 'excluded', 'failed'). */
export const deviceListStatus = () => current?.listSync ?? Promise.resolve('stopped');
/** This device's id in the end-to-end layer (null before it starts). */
export const e2eDeviceId = () => current?.deviceId ?? null;

// --- Device lists ---------------------------------------------------------------------------------------

// A list older than DEVICE_LIST_TTL_MS (but younger than DEVICE_LIST_STALE_MS) is still used for this send while a
// fresh one loads in the background, so a message after a quiet spell does not wait two HTTPS round trips first. It is
// safe: the server accepts a message only if it is sealed for exactly the current devices (server/e2e.mjs
// checkDirectEnvelope) and otherwise answers e2e-devices, after which it is sealed again with a fresh list
// (messaging.js handleRejected). Older lists are fetched before sending, as before.
async function devicesOf(userId, { fresh = false } = {}) {
  const cached = deviceLists.get(userId);
  const age = cached ? Date.now() - cached.at : Infinity;
  if (!fresh && age < DEVICE_LIST_TTL_MS) return cached.devices;
  if (!fresh && age < DEVICE_LIST_STALE_MS) {
    refreshDevices(userId).catch(() => {});
    return cached.devices;
  }
  return refreshDevices(userId);
}

// One fetch per person at a time (a send and a pre-warm asking together share it).
const listRefreshes = new Map();
function refreshDevices(userId) {
  const running = listRefreshes.get(userId);
  if (running) return running;
  const job = (async () => {
    const { devices, signedList } = await request(`/api/v1/e2e/users/${encodeURIComponent(userId)}/devices`);
    const trusted = await trustedDevices(userId, devices, signedList);
    // `listed`: how many the server named, before this device's own checks (the Encryption screen tells them apart).
    deviceLists.set(userId, { at: Date.now(), devices: trusted, listed: Array.isArray(devices) ? devices.length : 0 });
    return trusted;
  })().finally(() => listRefreshes.delete(userId));
  listRefreshes.set(userId, job);
  return job;
}

/**
 * Warms what the first message to `peerId` needs, before Send: the encryption session, and both people's device
 * lists (fetched again once they are past half their lifetime). Failures are ignored: sending fetches again.
 */
export function prewarmDirect(peerId) {
  const session = current;
  if (!session || !peerId) return;
  const warm = (userId) => {
    const cached = deviceLists.get(userId);
    return cached && Date.now() - cached.at < DEVICE_LIST_TTL_MS / 2 ? cached.devices : refreshDevices(userId);
  };
  session.ready.then(() => Promise.all([warm(peerId), warm(session.userId)])).catch(() => {});
}

// --- Signed device lists (src/e2e/deviceList.js) ----------------------------------------------------------------

const pinKey = (userId) => `hm:device-list-pin:${current?.userId}:${userId}`;
const pendingLinksKey = () => `hm:pending-links:${current?.userId}`;
const LINK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The devices to encrypt to: only those the account's signed list names, once the account has one. The account key
 * is pinned on first sight; an older list under the pinned key, or no list after one was seen, gives no devices (the
 * message waits, as for a contact without keys). A new account key is accepted and reported as a security code change.
 */
async function trustedDevices(userId, devices, signedList) {
  const session = current;
  const pin = await session.records.get(pinKey(userId)).catch(() => null);
  if (!signedList) return pin ? [] : devices;
  let verified;
  try { verified = await verifyDeviceList(signedList, userId, session.api); } catch { return []; }
  const decision = pinDecision(pin, verified);
  if (decision === 'rollback') return [];
  if (decision !== 'same' || verified.counter > pin.counter) await session.records.set(pinKey(userId), { accountKey: verified.accountKey, counter: verified.counter }).catch(() => {});
  if (decision === 'changed' && userId !== session.userId) notify({ type: 'identity-changed', userId, deviceId: null });
  return listedDevices(devices, verified);
}

async function putDeviceList(accountKey, counter, devices, { create = false } = {}) {
  const session = current;
  const signed = await signDeviceList(accountKey, { userId: session.userId, counter, devices }, session.api);
  try {
    await request(`/api/v1/e2e/device-list${create ? '?create=1' : ''}`, { method: 'PUT', body: signed });
    deviceLists.delete(session.userId);
    return true;
  } catch (error) {
    if (error.status === 409) return false;
    throw error;
  }
}

/** Holds a new account key and stores a first list signed by it; the key is forgotten again if the list is refused. */
async function establishAccountKey(devices, { create }) {
  const storage = current.protocol.storage;
  const key = await createAccountKey(current.api);
  await storage.set('account-key', key);
  if (await putDeviceList(key, 1, devices, { create })) {
    await storage.del('list-join-pending');
    return true;
  }
  if ((await storage.get('account-key'))?.publicKey === key.publicKey) await storage.del('account-key');
  return false;
}

/**
 * Keeps this device's place in the account's signed list. Resolves what it found or did:
 *   'created'  first list of the account (every device the server lists today is named: trust on first use);
 *   'holder'   this device holds the account key (and adds devices it linked whose claims check out);
 *   'member'   named in the list held by another device;
 *   'rotated'  a fresh sign-in on a new phone: a new account key naming only this device (contacts see a code change);
 *   'claimed'  a device linked by QR asked the phone that linked it to add it;
 *   'waiting'  a linked device on an account that has no list yet (its phone runs an older app);
 *   'excluded' another phone took over the account; this one no longer receives until linked again.
 */
export function syncDeviceList() {
  const session = current;
  if (!session) return Promise.resolve('stopped');
  // One at a time per device (start-up, the timers and a link approval can overlap).
  const run = (session.listQueue ?? Promise.resolve()).then(() => (current === session ? syncDeviceListNow() : 'stopped'));
  session.listQueue = run.catch(() => {});
  return run;
}

async function syncDeviceListNow() {
  const session = current;
  const storage = session.protocol.storage;
  const { devices, signedList } = await request(`/api/v1/e2e/users/${encodeURIComponent(session.userId)}/devices`);
  const me = { deviceId: session.deviceId, identity: await session.protocol.publicIdentity() };
  if (!signedList) {
    if (!session.canHoldAccountKey) return 'waiting';
    return (await establishAccountKey([...devices.filter((device) => device.deviceId !== me.deviceId), me], { create: true })) ? 'created' : 'raced';
  }
  let verified = null;
  try { verified = await verifyDeviceList(signedList, session.userId, session.api); } catch { verified = null; }
  const held = await storage.get('account-key');
  if (verified && held?.publicKey === verified.accountKey) {
    await storage.del('list-join-pending');
    await acceptLinkClaims(verified, held);
    return 'holder';
  }
  if (held) await storage.del('account-key');
  const listed = verified?.devices.get(me.deviceId);
  if (listed && listed.dh === me.identity.dh && listed.sig === me.identity.sig) {
    await storage.del('list-join-pending');
    await session.linkStore.del('hm:link-claim').catch(() => {});
    if (session.listTimer) { clearInterval(session.listTimer); session.listTimer = null; }
    return 'member';
  }
  if (session.canHoldAccountKey && await storage.get('list-join-pending')) {
    return (await establishAccountKey([me], { create: false })) ? 'rotated' : 'failed';
  }
  if (!session.canHoldAccountKey) {
    const sent = await sendLinkClaim(me, devices);
    // Until the phone adds it, look again every 15 s for a few minutes (the phone checks claims as often).
    if (sent && !session.listTimer) {
      let left = 16;
      session.listTimer = setInterval(() => { if (--left <= 0) { clearInterval(session.listTimer); session.listTimer = null; } syncDeviceList().catch(() => {}); }, 15_000);
    }
    return sent ? 'claimed' : 'waiting';
  }
  notify({ type: 'device-list-excluded' });
  return 'excluded';
}

async function sendLinkClaim(me, devices) {
  const session = current;
  const pending = await session.linkStore.get('hm:link-claim').catch(() => null);
  if (!pending?.privateKey || pending.userId !== session.userId) return false;
  const approver = devices.find((device) => device.deviceId === pending.approver);
  if (!approver) return false;
  const shared = await agreeDh(pending.privateKey, decodeBase64(approver.identity.dh), session.api);
  const mac = await linkClaimMac(shared, { userId: session.userId, deviceId: me.deviceId, identity: me.identity }, session.api);
  await request('/api/v1/e2e/link-claims', { method: 'POST', body: { linkKey: pending.publicKey, mac, approver: approver.deviceId } });
  return true;
}

/** Phone side: the link key of a device just linked (from the QR, or the code the person confirmed). */
export async function rememberLinkApproval(linkKey) {
  const session = current;
  if (!session || typeof linkKey !== 'string') return;
  const list = ((await session.records.get(pendingLinksKey()).catch(() => null)) ?? []).filter((item) => Date.now() - item.at < LINK_WINDOW_MS);
  await session.records.set(pendingLinksKey(), [...list, { key: linkKey, at: Date.now() }]);
  // The new device claims within a minute or two: look for it every 15 s for a few minutes.
  let left = 16;
  if (session.listTimer) clearInterval(session.listTimer);
  session.listTimer = setInterval(() => { if (--left <= 0 || current !== session) { clearInterval(session.listTimer); session.listTimer = null; } syncDeviceList().catch(() => {}); }, 15_000);
}

async function acceptLinkClaims(verified, held) {
  const session = current;
  const { claims = [] } = await request('/api/v1/e2e/link-claims');
  if (!claims.length) return;
  const pending = ((await session.records.get(pendingLinksKey()).catch(() => null)) ?? []).filter((item) => Date.now() - item.at < LINK_WINDOW_MS);
  const added = [];
  for (const claim of claims) {
    const link = claim.approver === session.deviceId ? pending.find((item) => item.key === claim.linkKey) : null;
    if (!link || verified.devices.has(claim.deviceId)) continue;
    const shared = await session.protocol.identityAgreement(decodeBase64(claim.linkKey));
    const expected = await linkClaimMac(shared, { userId: session.userId, deviceId: claim.deviceId, identity: claim.identity }, session.api);
    if (equalBytes(decodeBase64(expected), decodeBase64(claim.mac))) added.push(claim);
  }
  if (!added.length) return;
  const devices = [...verified.devices].map(([deviceId, identity]) => ({ deviceId, identity }));
  for (const claim of added) devices.push({ deviceId: claim.deviceId, identity: claim.identity });
  // At most MAX_LISTED_DEVICES: the oldest entries other than this device go first.
  while (devices.length > MAX_LISTED_DEVICES) devices.splice(devices.findIndex((device) => device.deviceId !== session.deviceId), 1);
  if (!(await putDeviceList(held, verified.counter + 1, devices))) return;
  for (const claim of added) await request(`/api/v1/e2e/link-claims/${encodeURIComponent(claim.deviceId)}`, { method: 'DELETE' }).catch(() => {});
  await session.records.set(pendingLinksKey(), pending.filter((item) => !added.some((claim) => claim.linkKey === item.key))).catch(() => {});
}

/**
 * Where a direct message to `peerId` goes over XMPP (src/xmpp/session.js): every device of the contact and this
 * account's other devices, by their XMPP addresses from the device lists. `complete` is false when any of them has none
 * (not moved over yet): the message then goes through the server, which reaches every device.
 */
export async function xmppTargetsFor(peerId, { peerOnly = false } = {}) {
  const session = current;
  if (!session) return { targets: [], complete: false, sender: null };
  // To oneself: this account's other devices only (call log sync), never this device or a device twice.
  const self = peerId === session.userId;
  const [peer, mine] = await Promise.all([self ? [] : devicesOf(peerId), peerOnly && !self ? [] : devicesOf(session.userId)]);
  const devices = [...peer, ...mine.filter((device) => device.deviceId !== session.deviceId)];
  const targets = devices.map((device) => device.xmpp).filter(Boolean);
  return { targets, complete: devices.length > 0 && targets.length === devices.length, sender: { userId: session.userId, deviceId: session.deviceId } };
}

/**
 * Where a group message goes over XMPP: every member device except this one, by XMPP address (src/xmpp/session.js
 * sendGroup). complete is false when any member device has none; the group then stays on the server path.
 */
export async function xmppGroupTargetsFor(groupId) {
  const session = current;
  if (!session) return { targets: [], complete: false, sender: null };
  const { devices } = await groupDevicesOf(groupId);
  const all = Object.values(devices ?? {}).flat().filter((device) => !(device.deviceId === session.deviceId && devices[session.userId]?.includes(device)));
  const targets = all.map((device) => device.xmpp).filter(Boolean);
  return { targets, complete: all.length > 0 && targets.length === all.length, sender: { userId: session.userId, deviceId: session.deviceId } };
}

/** Whose device an XMPP address is, from the device lists this device has seen (null when unknown). */
export function userForXmppAddress(address) {
  const bare = String(address ?? '').split('/')[0];
  if (!bare) return null;
  for (const [userId, { devices }] of deviceLists) if (devices?.some((device) => device.xmpp === bare)) return userId;
  return null;
}

/**
 * The server refused a message because its device lists changed ({ [userId]: … }): those lists are fetched again,
 * and checked against the signed lists, on the next seal. What the refusal itself carries is not trusted.
 */
export function forgetDeviceLists(devices) {
  for (const userId of Object.keys(devices ?? {})) deviceLists.delete(userId);
}

async function groupDevicesOf(groupId, { fresh = false } = {}) {
  const cached = groupLists.get(groupId);
  if (!fresh && cached && Date.now() - cached.at < GROUP_DEVICE_TTL_MS) return cached;
  const data = await request(`/api/v1/e2e/groups/${encodeURIComponent(groupId)}/devices`);
  const devices = {};
  for (const [userId, list] of Object.entries(data.devices ?? {})) {
    const trusted = await trustedDevices(userId, list, data.signedLists?.[userId]);
    if (trusted.length) devices[userId] = trusted;
  }
  const entry = { at: Date.now(), members: data.members ?? [], devices };
  groupLists.set(groupId, entry);
  return entry;
}

const claimBundles = async (userId, deviceIds) => (await request(`/api/v1/e2e/users/${encodeURIComponent(userId)}/bundles`, { method: 'POST', body: { deviceIds } })).bundles ?? [];

// --- Plaintext memory -------------------------------------------------------------------------------------

const bodyOf = (envelope) => envelope.slice(envelope.indexOf('|') + 1);
const plainKey = (hash) => `hm:plain:${current?.deviceId}:${hash}`;

// Remembered as the inner payload { c, lp? } (older entries were the content string alone).
async function remember(hash, inner) {
  plainMemory.set(hash, inner);
  while (plainMemory.size > PLAIN_MEMORY_LIMIT) plainMemory.delete(plainMemory.keys().next().value);
  await secureSet(plainKey(hash), inner).catch(() => {});
}

async function recall(hash) {
  if (plainMemory.has(hash)) return plainMemory.get(hash);
  const stored = await secureGet(plainKey(hash)).catch(() => null);
  const inner = typeof stored === 'string' ? { c: stored } : innerFrom(stored);
  if (!inner) return null;
  plainMemory.set(hash, inner);
  return inner;
}

// The opened form callers get: { content, linkPreview?, statusReply?, replyTo?, forwarded? } with the routed attachment
// id; `inner` comes from innerFrom (checked there).
export const openedFrom = (inner, route) => ({
  content: withRoutedMedia(inner.c, route),
  e2e: true,
  ...(inner.lp ? { linkPreview: inner.lp } : {}),
  ...(inner.sr ? { statusReply: inner.sr } : {}),
  ...(inner.r ? { replyTo: { id: inner.r } } : {}),
  ...(inner.fw === 1 ? { forwarded: true } : {}),
  ...(inner.cp ? { caption: inner.cp } : {}),
  ...(inner.al ? { album: inner.al } : {}),
  ...(inner.th ? { thumb: inner.th } : {}),
  ...(inner.pv ? { poster: inner.pv } : {}),
  ...(inner.du ? { duration: inner.du } : {}),
  ...(inner.ex ? { disappearSeconds: inner.ex } : {}),
});

// --- Sealing ------------------------------------------------------------------------------------------

/**
 * Encrypts direct-message content for the contact's devices and this account's other devices. A contact with no
 * device that has keys (an app that has not been opened since encryption arrived) gets the content as it is.
 */
/** Thrown when a group member has no device with keys yet: the group message waits instead of going out readable. */
export class GroupKeysMissing extends Error {
  constructor(missing) { super('Some members haven’t opened an updated app yet.'); this.code = 'group-keys-missing'; this.missing = missing; }
}

/** Thrown when a contact has no device with keys yet (an old app): the message waits instead of going out readable. */
export class PeerKeysMissing extends Error {
  constructor(peerId) { super('This contact has not opened an updated app yet.'); this.code = 'peer-keys-missing'; this.peerId = peerId; }
}

// fresh: ask the server for the contact's devices now (retrying a message that waited for their keys).
// preview: the notification text of this message (already formatted, src/store.js notificationPreview). It is sealed
// for each of the contact's phones that published a preview key (src/e2e/preview.js) and travels as `pv`, so the
// phone can show it from the push itself. Left out for messages that do not notify with their text (reactions).
export async function sealDirect(peerId, content, extra = {}, { fresh = false, preview = '' } = {}) {
  const session = current;
  if (!session || typeof content !== 'string' || isEnvelope(content)) return content;
  await session.ready.catch(() => {});
  const [peer, mine] = await Promise.all([devicesOf(peerId, { fresh }), devicesOf(session.userId)]);
  if (!peer.length) throw new PeerKeysMissing(peerId);
  const targets = { [peerId]: peer };
  const others = mine.filter((device) => device.deviceId !== session.deviceId);
  if (others.length) targets[session.userId] = others;
  const inner = innerOf(content, extra);
  const d = await session.protocol.encryptForDevices(targets, JSON.stringify(inner), { claimBundles });
  const pv = preview ? await previewsFor(session, peer, preview) : null;
  const envelope = buildEnvelope(routingFor(content), { sd: session.deviceId, d, ...(pv ? { pv } : {}) });
  await remember(await sha256Hex(bodyOf(envelope)), inner);
  return envelope;
}

/** { deviceId: sealed preview } for the devices whose preview key is signed by their identity; null when none. */
async function previewsFor(session, devices, text) {
  const sealed = {};
  await Promise.all(devices.map(async (device) => {
    if (!device.preview || !(await validPreviewKey(device.identity?.sig, device.preview, session.api))) return;
    try { sealed[device.deviceId] = await sealPreview(device.preview.key, text, session.userId, { api: session.api }); } catch { /* no preview for this phone */ }
  }));
  return Object.keys(sealed).length ? sealed : null;
}

/**
 * This phone's preview public key (from Android, PreviewKey.java), signed by this device's identity and published,
 * once per key. `previewKey`: base64, or empty where there is none (browsers, the desktop app, older APKs).
 */
export async function publishPreviewKey(previewKey) {
  const session = current;
  if (!session || typeof previewKey !== 'string' || !previewKey) return false;
  await session.ready.catch(() => {});
  const mark = `e2e:preview-key:${session.userId}:${session.deviceId}`;
  // Published for this identity: a new identity (wiped keys) signs and publishes it again.
  const identity = await session.protocol.publicIdentity();
  const published = `${previewKey}|${identity?.sig ?? ''}`;
  if ((await session.records.get(mark).catch(() => null)) === published) return true;
  const signature = await session.protocol.signPreviewKey(previewKey);
  if (current !== session) return false;
  await request('/api/v1/e2e/preview-key', { method: 'PUT', body: { key: previewKey, signature } });
  await session.records.set(mark, published).catch(() => {});
  return true;
}

/** Seals `content` for this account's other devices only (call log sync). Throws when there are none. */
export async function sealToOwnDevices(content) {
  const session = current;
  if (!session || typeof content !== 'string' || isEnvelope(content)) return content;
  await session.ready.catch(() => {});
  const others = (await devicesOf(session.userId)).filter((device) => device.deviceId !== session.deviceId);
  if (!others.length) throw new Error('No other device to sync with.');
  const inner = innerOf(content);
  const d = await session.protocol.encryptForDevices({ [session.userId]: others }, JSON.stringify(inner), { claimBundles });
  return buildEnvelope(routingFor(content), { sd: session.deviceId, d });
}

// Errors after which the sending device starts a fresh session before sealing again: the receiver's state for the
// current one is missing or broken. "not-addressed" only needs sealing for that device.
export const RESET_SESSION_ERRORS = new Set(['no-session', 'decrypt-failed', 'stale-prekey']);

/**
 * Seals `content` again for ONE device of `userId` (a retry request: that device could not open the original).
 * A fresh session first when its error says the old one is unusable. Resolves the envelope, or null when that device
 * is not (or no longer) in the user's device list.
 */
export async function resealForDevice(userId, deviceId, content, extra = {}, { error = null } = {}) {
  const session = current;
  if (!session || typeof content !== 'string' || !content || isEnvelope(content)) return null;
  await session.ready.catch(() => {});
  const device = (await devicesOf(userId, { fresh: true })).find((item) => item.deviceId === deviceId);
  if (!device) return null;
  if (RESET_SESSION_ERRORS.has(error)) await session.protocol.forgetSession(userId, deviceId);
  const inner = innerOf(content, extra);
  const d = await session.protocol.encryptForDevices({ [userId]: [device] }, JSON.stringify(inner), { claimBundles });
  return buildEnvelope(routingFor(content), { sd: session.deviceId, d });
}

/** The device that sealed an envelope (its "sd"), or null. */
export const sealingDevice = (content) => (isEnvelope(content) ? parseEnvelope(content)?.body?.sd ?? null : null);

/**
 * Seals content for a group and hands it to `send(content)` (the POST or PUT). If the server says the group's
 * devices changed, the lists are refreshed and it is sealed again. While a member has no device with keys
 * yet, nothing is sent: GroupKeysMissing is thrown and the message waits (src/groupPending.js).
 */
export async function sendGroupContent(groupId, content, send, extra = {}) {
  const session = current;
  // Strict end-to-end encryption: content is never sent readable. Without a running session, or while a member
  // has no device with keys, this throws GroupKeysMissing and the caller keeps the message waiting (groupPending.js).
  if (typeof content !== 'string') return send(content);
  if (!session) throw new GroupKeysMissing([]);
  await session.ready.catch(() => {});
  let fresh = false;
  for (let attempt = 0; attempt < SEAL_ATTEMPTS; attempt += 1) {
    const { members, devices } = await groupDevicesOf(groupId, { fresh });
    const meListed = devices[session.userId]?.some((device) => device.deviceId === session.deviceId);
    const missing = members.filter((userId) => !devices[userId]?.length);
    if (!meListed && !fresh) { fresh = true; continue; }
    if (!meListed || missing.length) throw new GroupKeysMissing(missing);
    const memberDevices = Object.fromEntries(Object.entries(devices).map(([userId, list]) => [userId, list.map((device) => device.deviceId)]));
    const inner = innerOf(content, extra);
    const sealed = await session.protocol.encryptGroup(groupId, { userId: session.userId, deviceId: session.deviceId }, memberDevices, JSON.stringify(inner), {
      claimBundles,
      digest: (text) => sha256Hex(text),
    });
    const envelope = buildEnvelope(routingFor(content), { sd: session.deviceId, ...sealed.body });
    await remember(await sha256Hex(bodyOf(envelope)), inner);
    try {
      const result = await send(envelope);
      await session.protocol.confirmGroupSend(groupId, sealed.keyId);
      return result;
    } catch (error) {
      const data = error?.data ?? error?.body;
      if (error?.status !== 409 || !data?.devices) throw error;
      // Fetched again (and checked against the signed lists); the refusal's own copy is not trusted.
      groupLists.delete(groupId);
      if (data.code === 'e2e-keys') await publishKeys().catch(() => {});
      fresh = true;
    }
  }
  throw new Error('The group’s devices keep changing. Try again.');
}

/** Seals and sends a direct edit or other direct HTTP write; re-seals once if the device list changed. */
export async function sendDirectContent(peerId, content, send) {
  for (let attempt = 0; attempt < SEAL_ATTEMPTS; attempt += 1) {
    const sealed = await sealDirect(peerId, content);
    try {
      return await send(sealed);
    } catch (error) {
      const data = error?.data ?? error?.body;
      if (error?.status !== 409 || !data?.devices) throw error;
      forgetDeviceLists(data.devices);
    }
  }
  throw new Error('This contact’s devices keep changing. Try again.');
}

// --- Opening ------------------------------------------------------------------------------------------

/**
 * Opens received content. ctx: { senderId } for direct messages, { senderId, groupId } for groups. Resolves
 * { content, e2e: true } when it was end-to-end encrypted, { content } when it was not, and
 * { content: '', e2eError } when this device cannot read it ("Waiting for this message").
 */
export async function openContent(content, { senderId, groupId = null } = {}) {
  if (!isEnvelope(content)) return { content };
  const parsed = parseEnvelope(content);
  if (!parsed) return { content: '', e2eError: 'invalid' };
  const hash = await sha256Hex(bodyOf(content));
  const known = await recall(hash);
  if (known !== null) return openedFrom(known, parsed.route);
  const session = current;
  if (!session) return { content: '', e2eError: 'locked' };
  if (opening.has(hash)) return opening.get(hash);
  const task = (async () => {
    try {
      const me = { userId: session.userId, deviceId: session.deviceId };
      const plaintext = groupId
        ? await session.protocol.decryptGroup(groupId, me, senderId, parsed.body.sd, parsed.body)
        : await session.protocol.decryptFromDevice(senderId, parsed.body.sd, parsed.body.d?.[session.userId]?.[session.deviceId]);
      const inner = innerFrom(JSON.parse(plaintext));
      if (!inner) return { content: '', e2eError: 'invalid' };
      if (current === session) await remember(hash, inner);
      return openedFrom(inner, parsed.route);
    } catch (error) {
      return { content: '', e2eError: error?.code || 'decrypt-failed' };
    } finally {
      opening.delete(hash);
    }
  })();
  opening.set(hash, task);
  return task;
}

/**
 * What the native background fetch decrypted while the app was closed (NativeRelayFetch): each `entries` item is a
 * JSON string `{ event, inner }` — the raw server event and the decrypted inner payload. Seeds the remembered-plaintext
 * cache from `inner` so the app opens the event without decrypting again (the native ratchet already advanced), then
 * applies it through `handle`. Used instead of importInbox on the native path.
 */
export async function importNativeInbox(entries, handle) {
  let applied = 0;
  for (const text of entries) {
    let entry;
    try { entry = JSON.parse(text); } catch { continue; }
    try {
      const content = entry?.event?.message?.content;
      if (typeof content === 'string' && isEnvelope(content) && typeof entry.inner === 'string') {
        const inner = innerFrom(JSON.parse(entry.inner));
        if (inner && current) await remember(await sha256Hex(bodyOf(content)), inner);
      }
      await handle(entry.event);
      applied += 1;
    } catch (error) {
      console.error('Native inbox entry failed:', error);
    }
  }
  return applied;
}

/**
 * A direct message as the store keeps it: plaintext content and an `e2e` / `e2eError` flag. `known` (the copy the
 * store already holds) wins over a failed decryption, so a readable message never turns into "waiting".
 */
export async function openDirectMessage(message, known = null) {
  if (!message || typeof message.content !== 'string' || !isEnvelope(message.content)) return message;
  const opened = await openContent(message.content, { senderId: message.senderId });
  if (opened.e2eError && known && !known.e2eError && typeof known.content === 'string') {
    const { content: _content, ...rest } = message;
    return { ...rest, e2e: true };
  }
  const { e2eError: _stale, sealedBy: _sealedBy, ...base } = message;
  return {
    ...base, content: opened.content,
    // Which device sealed a copy this device cannot open: the retry request asks that device to seal it again.
    ...(opened.e2eError && sealingDevice(message.content) ? { sealedBy: sealingDevice(message.content) } : {}), ...(opened.e2e ? { e2e: true } : {}), ...(opened.linkPreview ? { linkPreview: opened.linkPreview } : {}),
    ...(opened.statusReply ? { statusReply: opened.statusReply } : {}), ...(opened.e2eError ? { e2eError: opened.e2eError } : {}),
    // Reply and forward travel inside the encryption; a copy the server still describes (older apps) keeps its own.
    ...(opened.replyTo && !base.replyTo ? { replyTo: opened.replyTo } : {}), ...(opened.forwarded ? { forwarded: true } : {}),
    ...(opened.caption ? { caption: opened.caption } : {}), ...(opened.album ? { album: opened.album } : {}), ...(opened.thumb ? { thumb: opened.thumb } : {}), ...(opened.poster ? { poster: opened.poster } : {}), ...(opened.duration ? { duration: opened.duration } : {}),
    // The server's own timer wins when it set one; otherwise the sender's, from inside the encryption.
    ...(!base.expiresAt && expiryOf(base.timestamp, opened.disappearSeconds) ? { expiresAt: new Date(expiryOf(base.timestamp, opened.disappearSeconds)).toISOString() } : {}),
  };
}

/** Opens a list in order (ratchets and sender keys advance message by message). */
export async function openDirectMessages(messages, knownById = () => null) {
  const out = [];
  for (const message of messages ?? []) out.push(await openDirectMessage(message, knownById(message?.id)));
  return out;
}

export async function openGroupMessage(groupId, message) {
  if (!message || typeof message.content !== 'string' || !isEnvelope(message.content)) return message;
  const opened = await openContent(message.content, { senderId: message.senderId, groupId });
  const expires = !message.expiresAt ? expiryOf(message.createdAt, opened.disappearSeconds) : null;
  return { ...message, content: opened.content, ...(opened.e2e ? { e2e: true } : {}), ...(opened.linkPreview ? { linkPreview: opened.linkPreview } : {}), ...(opened.caption ? { caption: opened.caption } : {}), ...(opened.album ? { album: opened.album } : {}), ...(opened.thumb ? { thumb: opened.thumb } : {}), ...(opened.poster ? { poster: opened.poster } : {}), ...(opened.duration ? { duration: opened.duration } : {}), ...(opened.e2eError ? { e2eError: opened.e2eError } : {}), ...(expires ? { expiresAt: expires } : {}) };
}

export async function openGroupMessages(groupId, messages) {
  const ordered = [...(messages ?? [])];
  const out = [];
  for (const message of ordered) out.push(await openGroupMessage(groupId, message));
  return out;
}

// --- Verification -------------------------------------------------------------------------------------

/**
 * The Encryption screen's state for a chat (src/e2e/securityCode.js): the code, or exactly why there is none. Both
 * device lists are fetched fresh; a failed fetch is "offline", never "the contact has no keys".
 */
export async function securityCodeState(peerId) {
  const session = current;
  if (session) await session.ready.catch(() => {});
  return resolveSecurityCode({
    hasSession: Boolean(session) && current === session,
    ownId: session?.userId,
    peerId,
    report: async (userId) => {
      const devices = await refreshDevices(userId);
      return { devices, listed: deviceLists.get(userId)?.listed ?? devices.length };
    },
    safetyNumber: (mine, theirs) => session.protocol.safetyNumber(mine, theirs),
  });
}

/** The safety number with a contact: over every device identity of both accounts (60 digits, like WhatsApp). */
export async function safetyNumberWith(peerId) {
  const session = current;
  if (!session) return '';
  const [mine, theirs] = await Promise.all([devicesOf(session.userId, { fresh: true }), devicesOf(peerId, { fresh: true })]);
  if (!mine.length || !theirs.length) return '';
  return session.protocol.safetyNumber(mine.map((device) => device.identity), theirs.map((device) => device.identity));
}

/**
 * A group's encryption state: { encrypted, missing: [userId] } (members without a device with keys mean the group
 * is sent without end-to-end encryption until they update).
 */
// fresh: ask the server now (and refresh the cached list used for sending), for decisions such as a group call key.
export async function groupEncryption(groupId, { fresh = false } = {}) {
  if (!current) return { encrypted: false, missing: [] };
  const { members, devices } = await groupDevicesOf(groupId, { fresh }).catch(() => ({ members: [], devices: {} }));
  const missing = members.filter((userId) => !devices[userId]?.length);
  return { encrypted: members.length > 0 && missing.length === 0, missing };
}

/**
 * Seals a status for everyone who may see it (every device of the audience and this account's other devices).
 * Resolves the content as it is when someone in the audience has no device with keys yet (they could not read it).
 */
export async function sealStatus(content) {
  const session = current;
  if (!session || typeof content !== 'string') return content;
  await session.ready.catch(() => {});
  const { members, devices } = await request('/api/v1/e2e/status-audience');
  if (!devices[session.userId]?.some((device) => device.deviceId === session.deviceId)) return content;
  if (members.some((userId) => !devices[userId]?.length)) return content;
  const targets = {};
  for (const [userId, list] of Object.entries(devices)) {
    const others = userId === session.userId ? list.filter((device) => device.deviceId !== session.deviceId) : list;
    if (others.length) targets[userId] = others;
  }
  const inner = innerOf(content);
  const d = Object.keys(targets).length ? await session.protocol.encryptForDevices(targets, JSON.stringify(inner), { claimBundles }) : {};
  const envelope = buildEnvelope(routingFor(content), { sd: session.deviceId, d });
  await remember(await sha256Hex(bodyOf(envelope)), inner);
  return envelope;
}

/** Whether a contact can receive end-to-end encrypted messages (has a device with keys). */
export async function contactEncrypted(peerId, { fresh = false } = {}) {
  if (!current) return false;
  return (await devicesOf(peerId, { fresh }).catch(() => [])).length > 0;
}

export { ENVELOPE_PREFIX, isEnvelope };
