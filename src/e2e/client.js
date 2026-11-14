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
import { createProtocol } from './protocol.js';
import { buildEnvelope, ENVELOPE_PREFIX, isEnvelope, parseEnvelope, routingFor, withRoutedMedia } from './envelope.js';
import { sha256Hex } from './primitives.js';
import { sanitizePreview } from '../linkPreviewParse.js';
import { cleanDuration, cleanPoster, cleanThumb } from '../mediaThumb.js';

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
export const innerOf = (content, extra = {}) => {
  const linkPreview = sanitizePreview(extra.linkPreview);
  const statusReply = cleanStatusReply(extra.statusReply);
  const replyToId = typeof extra.replyToId === 'string' && extra.replyToId.length < 120 ? extra.replyToId : null;
  const caption = cleanCaption(extra.caption);
  const album = cleanAlbum(extra.album);
  const thumb = cleanThumb(extra.thumb);
  const poster = cleanPoster(extra.poster);
  const duration = cleanDuration(extra.duration);
  return { ...(thumb ? { th: thumb } : {}), ...(poster ? { pv: poster } : {}), ...(duration ? { du: duration } : {}), c: content, ...(linkPreview ? { lp: linkPreview } : {}), ...(statusReply ? { sr: statusReply } : {}), ...(replyToId ? { r: replyToId } : {}), ...(extra.forwarded ? { fw: 1 } : {}), ...(caption ? { cp: caption } : {}), ...(album ? { al: album } : {}) };
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
  };
};

export const DEVICE_LIST_TTL_MS = 5 * 60 * 1000;
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

/** Events: { type: 'identity-changed', userId, deviceId } (a contact's security code changed). */
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
export function startE2e({ token, userId, deviceId, storage, fetchImpl = apiFetch, api } = {}) {
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
    protocol: createProtocol({
      storage: storage ?? browserKeyStorage(deviceId),
      api,
      onIdentityChange: (changedUser, changedDevice) => notify({ type: 'identity-changed', userId: changedUser, deviceId: changedDevice }),
    }),
  };
  current = session;
  session.ready = publishKeys().then(() => true);
  session.ready.catch(() => {});
  session.timer = setInterval(() => { publishKeys().catch(() => {}); }, KEY_REFRESH_MS);
  return session.ready;
}

export function stopE2e() {
  if (current?.timer) clearInterval(current.timer);
  current = null;
  deviceLists.clear();
  groupLists.clear();
  plainMemory.clear();
  opening.clear();
}

export const e2eActive = () => Boolean(current);

// --- Device lists ---------------------------------------------------------------------------------------

async function devicesOf(userId, { fresh = false } = {}) {
  const cached = deviceLists.get(userId);
  if (!fresh && cached && Date.now() - cached.at < DEVICE_LIST_TTL_MS) return cached.devices;
  const { devices } = await request(`/api/v1/e2e/users/${encodeURIComponent(userId)}/devices`);
  deviceLists.set(userId, { at: Date.now(), devices });
  return devices;
}

/**
 * Where a direct message to `peerId` goes over XMPP (src/xmpp/session.js): every device of the contact and this
 * account's other devices, by their XMPP addresses from the device lists. `complete` is false when any of them has none
 * (not moved over yet): the message then goes through the server, which reaches every device.
 */
export async function xmppTargetsFor(peerId) {
  const session = current;
  if (!session) return { targets: [], complete: false, sender: null };
  const [peer, mine] = await Promise.all([devicesOf(peerId), devicesOf(session.userId)]);
  const devices = [...peer, ...mine.filter((device) => device.deviceId !== session.deviceId)];
  const targets = devices.map((device) => device.xmpp).filter(Boolean);
  return { targets, complete: devices.length > 0 && targets.length === devices.length, sender: { userId: session.userId, deviceId: session.deviceId } };
}

/** The server's current list after it refused a message as out of date ({ [userId]: [{ deviceId, identity }] }). */
export function applyDeviceLists(devices) {
  for (const [userId, list] of Object.entries(devices ?? {})) {
    if (Array.isArray(list)) deviceLists.set(userId, { at: Date.now(), devices: list });
  }
}

async function groupDevicesOf(groupId, { fresh = false } = {}) {
  const cached = groupLists.get(groupId);
  if (!fresh && cached && Date.now() - cached.at < GROUP_DEVICE_TTL_MS) return cached;
  const data = await request(`/api/v1/e2e/groups/${encodeURIComponent(groupId)}/devices`);
  const entry = { at: Date.now(), members: data.members ?? [], devices: data.devices ?? {} };
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
export async function sealDirect(peerId, content, extra = {}, { fresh = false } = {}) {
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
  const envelope = buildEnvelope(routingFor(content), { sd: session.deviceId, d });
  await remember(await sha256Hex(bodyOf(envelope)), inner);
  return envelope;
}

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
      groupLists.set(groupId, { at: Date.now(), members: data.members ?? [], devices: data.devices });
      if (data.code === 'e2e-keys') await publishKeys().catch(() => {});
      fresh = data.code === 'e2e-keys';
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
      applyDeviceLists(data.devices);
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
  const { e2eError: _stale, ...base } = message;
  return {
    ...base, content: opened.content, ...(opened.e2e ? { e2e: true } : {}), ...(opened.linkPreview ? { linkPreview: opened.linkPreview } : {}),
    ...(opened.statusReply ? { statusReply: opened.statusReply } : {}), ...(opened.e2eError ? { e2eError: opened.e2eError } : {}),
    // Reply and forward travel inside the encryption; a copy the server still describes (older apps) keeps its own.
    ...(opened.replyTo && !base.replyTo ? { replyTo: opened.replyTo } : {}), ...(opened.forwarded ? { forwarded: true } : {}),
    ...(opened.caption ? { caption: opened.caption } : {}), ...(opened.album ? { album: opened.album } : {}), ...(opened.thumb ? { thumb: opened.thumb } : {}), ...(opened.poster ? { poster: opened.poster } : {}), ...(opened.duration ? { duration: opened.duration } : {}),
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
  return { ...message, content: opened.content, ...(opened.e2e ? { e2e: true } : {}), ...(opened.linkPreview ? { linkPreview: opened.linkPreview } : {}), ...(opened.caption ? { caption: opened.caption } : {}), ...(opened.album ? { album: opened.album } : {}), ...(opened.thumb ? { thumb: opened.thumb } : {}), ...(opened.poster ? { poster: opened.poster } : {}), ...(opened.duration ? { duration: opened.duration } : {}), ...(opened.e2eError ? { e2eError: opened.e2eError } : {}) };
}

export async function openGroupMessages(groupId, messages) {
  const ordered = [...(messages ?? [])];
  const out = [];
  for (const message of ordered) out.push(await openGroupMessage(groupId, message));
  return out;
}

// --- Verification -------------------------------------------------------------------------------------

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
export async function contactEncrypted(peerId) {
  if (!current) return false;
  return (await devicesOf(peerId).catch(() => [])).length > 0;
}

export { ENVELOPE_PREFIX, isEnvelope };
