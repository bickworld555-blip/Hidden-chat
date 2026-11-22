// End-to-end encryption, server side: the key directory and the fan-out rules.
//
// The server never sees message text. It stores each device's public keys (identity, signed prekey, one-time
// prekeys), hands a contact's prekey bundles to whoever starts a session (each one-time prekey exactly once),
// and checks that every encrypted message is addressed to all of the devices that should receive it: the
// recipient's devices and the sender's other devices (direct), or the group's whole device set (groups). A sender
// with an outdated device list is told the current one and re-encrypts. A device is a signed-in session
// (sessions.device_id); signing out removes its keys.
import { createHash } from 'node:crypto';
import { verifyDeviceList } from '../src/e2e/deviceList.js';
import { validPreviewKey } from '../src/e2e/preview.js';
import express from 'express';
import { addressesOf, MAX_DIRECT_ENVELOPE, MAX_GROUP_ENVELOPE, parseEnvelope } from '../src/e2e/envelope.js';

export const MAX_PREKEYS_PER_UPLOAD = 100;
export const MAX_PREKEYS_PER_DEVICE = 200;
export const MAX_DEVICES_PER_CLAIM = 16;
const KEY = /^[A-Za-z0-9+/]{87}=$/; // 65-byte P-256 point
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/; // 64-byte ECDSA P-256 (IEEE P1363) signature
const DEVICE_ID = /^[A-Za-z0-9_-]{1,80}$/;

export const digestHex = (text) => createHash('sha256').update(text).digest('hex');
export const membersHashOf = (addresses) => digestHex([...addresses].sort().join('\n')).slice(0, 32);

export function ensureE2eSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS e2e_devices (
    user_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    identity_dh TEXT NOT NULL,
    identity_sig TEXT NOT NULL,
    signed_prekey_id INTEGER NOT NULL,
    signed_prekey TEXT NOT NULL,
    signed_prekey_signature TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, device_id)
  )`);
  // Poll votes sealed end to end (the server cannot count them; devices do).
  db.exec(`CREATE TABLE IF NOT EXISTS poll_sealed_votes (
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    sealed TEXT NOT NULL,
    voted_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id)
  )`);
  // Signed device lists (src/e2e/deviceList.js) and pending link claims (a linked device proving its keys to the phone).
  db.exec(`CREATE TABLE IF NOT EXISTS e2e_device_lists (
    user_id TEXT PRIMARY KEY,
    account_key TEXT NOT NULL,
    counter INTEGER NOT NULL,
    list TEXT NOT NULL,
    signature TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS e2e_link_claims (
    user_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    claim TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, device_id)
  )`);
  // Notification preview keys (src/e2e/preview.js; Postgres: migration 048).
  db.exec(`CREATE TABLE IF NOT EXISTS e2e_preview_keys (
    user_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    public_key TEXT NOT NULL,
    signature TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, device_id)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS e2e_prekeys (
    user_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    key_id INTEGER NOT NULL,
    public_key TEXT NOT NULL,
    PRIMARY KEY (user_id, device_id, key_id)
  )`);
}

/** Validates an upload: { identity: { dh, sig }, signedPreKey: { id, key, signature }, preKeys: [{ id, key }] }. */
export function parseKeyUpload(body) {
  const identity = body?.identity;
  const spk = body?.signedPreKey;
  const preKeys = body?.preKeys ?? [];
  if (!identity || !KEY.test(identity.dh ?? '') || !KEY.test(identity.sig ?? '')) return null;
  if (!spk || !Number.isSafeInteger(spk.id) || spk.id < 1 || !KEY.test(spk.key ?? '') || !SIGNATURE.test(spk.signature ?? '')) return null;
  if (!Array.isArray(preKeys) || preKeys.length > MAX_PREKEYS_PER_UPLOAD) return null;
  if (!preKeys.every((key) => Number.isSafeInteger(key?.id) && key.id >= 1 && KEY.test(key.key ?? ''))) return null;
  return { identity, spk, preKeys };
}

// `xmppAddress(userId, localpart)`: a device's XMPP address (server/xmpp.mjs addressFor) or null. Device lists carry it for
// devices reachable over XMPP, so senders can route while users move over; a device without one is reached through
// this server as before.
//
// Retired devices (devicesOf leaves them out, so nobody seals for them and XMPP routing is not held back by them):
//   - a device not active for DEVICE_IDLE_MS (WhatsApp signs out linked devices after a few weeks; this only stops
//     sending to it, so it comes back the moment it is used again);
//   - on an account moved to XMPP (`onXmpp(userId)`), a device with no XMPP account that has not been active for
//     DEVICE_XMPP_GRACE_MS: every app that runs gets its account at start-up, so it has not run since the move (an
//     old install, a wiped app on the same phone). The grace covers a fresh sign-in before its first token request.
// A device connected right now (`connectedDevices(userId)`: ids with an open socket) is never retired, whatever its
// stored activity says (an older app that never asks for an XMPP account keeps receiving while it is in use).
// A device whose activity is unknown is kept: unknown is not the same as idle.
export const DEVICE_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
export const DEVICE_XMPP_GRACE_MS = 10 * 60 * 1000;

export function isRetiredDevice({ lastActive, hasXmpp, onXmpp, now, connected = false }) {
  if (connected) return false;
  const active = Number(lastActive);
  if (!Number.isFinite(active) || active <= 0) return false;
  if (now - active > DEVICE_IDLE_MS) return true;
  return Boolean(onXmpp && !hasXmpp && now - active > DEVICE_XMPP_GRACE_MS);
}

export function registerE2e({ app, db, requireSession, xmppAddress = () => null, onXmpp = () => false, connectedDevices = () => new Set(), now = () => Date.now() }) {
  const json = express.json({ limit: '64kb' });

  // Devices that can receive end-to-end messages: they published keys and are still signed in.
  const keyDevicesOf = db.prepare(`SELECT d.device_id AS "deviceId", d.identity_dh AS "dh", d.identity_sig AS "sig", x.localpart AS "xmpp", k.public_key AS "previewKey", k.signature AS "previewSignature",
      (SELECT MAX(COALESCE(s.last_active_at, s.created_at)) FROM sessions s WHERE s.user_id = d.user_id AND s.device_id = d.device_id) AS "lastActive"
    FROM e2e_devices d LEFT JOIN xmpp_accounts x ON x.user_id = d.user_id AND x.device_id = d.device_id
      LEFT JOIN e2e_preview_keys k ON k.user_id = d.user_id AND k.device_id = d.device_id
    WHERE d.user_id = ? AND EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = d.user_id AND s.device_id = d.device_id)
    ORDER BY d.device_id`);

  // The account's signed device list ({ list, signature }) or null (an account whose apps predate signed lists).
  const storedList = db.prepare('SELECT account_key AS "accountKey", counter, list, signature FROM e2e_device_lists WHERE user_id = ?');
  async function signedListOf(userId) {
    const row = await storedList.get(userId);
    return row ? { list: row.list, signature: row.signature } : null;
  }
  // Devices the stored list names, with the identity it names (checked when it was stored, so parsing suffices).
  async function listedIdentities(userId) {
    const row = await storedList.get(userId);
    if (!row) return null;
    return new Map(JSON.parse(row.list).d.map((device) => [device.id, `${device.dh}|${device.sig}`]));
  }

  async function devicesOf(userId) {
    const moved = Boolean(onXmpp(userId));
    const at = now();
    const connected = connectedDevices(userId);
    const listed = await listedIdentities(userId);
    return (await keyDevicesOf.all(userId))
      // An account with a signed list: only the devices it names are advertised (or checked for in envelopes).
      .filter((row) => !listed || listed.get(row.deviceId) === `${row.dh}|${row.sig}`)
      .filter((row) => !isRetiredDevice({ lastActive: row.lastActive, hasXmpp: Boolean(row.xmpp), onXmpp: moved, now: at, connected: connected.has(row.deviceId) }))
      .map((row) => {
        const xmpp = xmppAddress(userId, row.xmpp);
        // The phone's notification preview key, signed by this identity (senders check the signature themselves).
        const preview = row.previewKey ? { preview: { key: row.previewKey, signature: row.previewSignature } } : {};
        return { deviceId: row.deviceId, identity: { dh: row.dh, sig: row.sig }, ...(xmpp ? { xmpp } : {}), ...preview };
      });
  }

  async function forgetStaleDevices() {
    await db.prepare(`DELETE FROM e2e_prekeys WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = e2e_prekeys.user_id AND s.device_id = e2e_prekeys.device_id)`).run();
    await db.prepare(`DELETE FROM e2e_devices WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = e2e_devices.user_id AND s.device_id = e2e_devices.device_id)`).run();
  }

  /** Removes one signed-out device's keys at once (sessions.mjs paths call this; stale rows are swept anyway). */
  async function forgetDevice(userId, deviceId) {
    await db.prepare('DELETE FROM e2e_link_claims WHERE user_id = ? AND device_id = ?').run(userId, deviceId);
    await db.prepare('DELETE FROM e2e_prekeys WHERE user_id = ? AND device_id = ?').run(userId, deviceId);
    await db.prepare('DELETE FROM e2e_preview_keys WHERE user_id = ? AND device_id = ?').run(userId, deviceId);
    await db.prepare('DELETE FROM e2e_devices WHERE user_id = ? AND device_id = ?').run(userId, deviceId);
  }

  // A phone publishes its notification preview key, signed by its identity key (src/e2e/preview.js). Refused unless
  // the signature is by the identity this device has published, so a stored key is always one its senders accept.
  app.put('/api/v1/e2e/preview-key', requireSession, json, async (request, response) => {
    const { user_id: userId, device_id: deviceId } = request.session;
    const { key, signature } = request.body ?? {};
    if (!KEY.test(key ?? '') || !SIGNATURE.test(signature ?? '')) return response.status(400).json({ error: 'Invalid preview key.' });
    const device = await db.prepare('SELECT identity_sig AS "sig" FROM e2e_devices WHERE user_id = ? AND device_id = ?').get(userId, deviceId);
    if (!device) return response.status(409).json({ error: 'Publish encryption keys first.' });
    if (!(await validPreviewKey(device.sig, { key, signature }))) return response.status(400).json({ error: 'Invalid preview key signature.' });
    await db.prepare(`INSERT INTO e2e_preview_keys(user_id, device_id, public_key, signature, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (user_id, device_id) DO UPDATE SET public_key = excluded.public_key, signature = excluded.signature, updated_at = excluded.updated_at`).run(userId, deviceId, key, signature, Date.now());
    response.status(204).end();
  });

  app.put('/api/v1/e2e/keys', requireSession, json, async (request, response) => {
    const { user_id: userId, device_id: deviceId } = request.session;
    const upload = parseKeyUpload(request.body);
    if (!upload) return response.status(400).json({ error: 'Invalid encryption keys.' });
    const now = Date.now();
    let existing = await db.prepare('SELECT identity_dh AS "dh", identity_sig AS "sig" FROM e2e_devices WHERE user_id = ? AND device_id = ?').get(userId, deviceId);
    // A new identity for the same device (its local keys were wiped, e.g. the app's data was cleared): the old
    // keys go, and contacts' apps notice the change ("security code changed"), as with WhatsApp.
    if (existing && (existing.dh !== upload.identity.dh || existing.sig !== upload.identity.sig)) {
      await forgetDevice(userId, deviceId);
      existing = null;
    }
    if (existing) {
      await db.prepare(`UPDATE e2e_devices SET signed_prekey_id = ?, signed_prekey = ?, signed_prekey_signature = ?, updated_at = ?
        WHERE user_id = ? AND device_id = ?`).run(upload.spk.id, upload.spk.key, upload.spk.signature, now, userId, deviceId);
    } else {
      await db.prepare(`INSERT INTO e2e_devices(user_id, device_id, identity_dh, identity_sig, signed_prekey_id, signed_prekey, signed_prekey_signature, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(userId, deviceId, upload.identity.dh, upload.identity.sig, upload.spk.id, upload.spk.key, upload.spk.signature, now, now);
    }
    const stored = Number((await db.prepare('SELECT COUNT(*) AS "count" FROM e2e_prekeys WHERE user_id = ? AND device_id = ?').get(userId, deviceId))?.count ?? 0);
    for (const key of upload.preKeys.slice(0, Math.max(0, MAX_PREKEYS_PER_DEVICE - stored))) {
      await db.prepare('INSERT INTO e2e_prekeys(user_id, device_id, key_id, public_key) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING').run(userId, deviceId, key.id, key.key);
    }
    if (!existing) await forgetStaleDevices();
    response.json(await keyStatus(userId, deviceId));
  });

  async function keyStatus(userId, deviceId) {
    const device = await db.prepare('SELECT signed_prekey_id AS "signedPreKeyId" FROM e2e_devices WHERE user_id = ? AND device_id = ?').get(userId, deviceId);
    const count = Number((await db.prepare('SELECT COUNT(*) AS "count" FROM e2e_prekeys WHERE user_id = ? AND device_id = ?').get(userId, deviceId))?.count ?? 0);
    return { published: Boolean(device), signedPreKeyId: device?.signedPreKeyId ?? null, preKeys: count };
  }

  app.get('/api/v1/e2e/keys', requireSession, async (request, response) => {
    response.json(await keyStatus(request.session.user_id, request.session.device_id));
  });

  app.get('/api/v1/e2e/users/:userId/devices', requireSession, async (request, response) => {
    if (!await db.prepare('SELECT 1 FROM users WHERE id = ?').get(request.params.userId)) return response.status(404).json({ error: 'User not found.' });
    const signedList = await signedListOf(request.params.userId);
    response.json({ devices: await devicesOf(request.params.userId), ...(signedList ? { signedList } : {}) });
  });

  // A new signed list from one of the account's devices: signed by the key it names, naming the uploading device with
  // its published identity, and newer than the stored one under the same key. Another key replaces the list (a fresh
  // sign-in on a new phone): contacts' apps show that as a security code change.
  app.put('/api/v1/e2e/device-list', requireSession, json, async (request, response) => {
    const { user_id: userId, device_id: deviceId } = request.session;
    let verified;
    try {
      verified = await verifyDeviceList(request.body, userId);
    } catch (error) {
      return response.status(400).json({ error: error.message });
    }
    const own = await db.prepare('SELECT identity_dh AS "dh", identity_sig AS "sig" FROM e2e_devices WHERE user_id = ? AND device_id = ?').get(userId, deviceId);
    const listedSelf = verified.devices.get(deviceId);
    if (!own || !listedSelf || listedSelf.dh !== own.dh || listedSelf.sig !== own.sig) {
      return response.status(400).json({ error: 'The list must name this device with its published keys.' });
    }
    const stored = await storedList.get(userId);
    if (stored && stored.accountKey === verified.accountKey && verified.counter <= Number(stored.counter)) {
      return response.status(409).json({ error: 'A newer device list is already stored.', code: 'device-list-stale', signedList: { list: stored.list, signature: stored.signature } });
    }
    if (request.query.create === '1' && stored) {
      // First list of an account whose apps are upgrading: only one device may create it; the others are named in it.
      return response.status(409).json({ error: 'The account already has a device list.', code: 'device-list-exists', signedList: { list: stored.list, signature: stored.signature } });
    }
    await db.prepare(`INSERT INTO e2e_device_lists(user_id, account_key, counter, list, signature, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET account_key = excluded.account_key, counter = excluded.counter, list = excluded.list, signature = excluded.signature, updated_at = excluded.updated_at`)
      .run(userId, verified.accountKey, verified.counter, request.body.list, request.body.signature, Date.now());
    response.json({ stored: true, counter: verified.counter });
  });

  // Link claims: a device linked by QR asks the phone that linked it to add it to the signed list. The claim carries
  // an HMAC only that phone can check (src/e2e/deviceList.js linkClaimMac); the server only relays it.
  const CLAIM = /^[A-Za-z0-9+/=]{1,200}$/;
  app.post('/api/v1/e2e/link-claims', requireSession, json, async (request, response) => {
    const { user_id: userId, device_id: deviceId } = request.session;
    const { linkKey, mac, approver } = request.body ?? {};
    const own = await db.prepare('SELECT identity_dh AS "dh", identity_sig AS "sig" FROM e2e_devices WHERE user_id = ? AND device_id = ?').get(userId, deviceId);
    if (!own) return response.status(409).json({ error: 'Publish this device’s keys first.' });
    if (!CLAIM.test(linkKey ?? '') || !CLAIM.test(mac ?? '') || typeof approver !== 'string' || approver.length > 128) return response.status(400).json({ error: 'Invalid link claim.' });
    const claim = JSON.stringify({ deviceId, identity: { dh: own.dh, sig: own.sig }, linkKey, mac, approver });
    await db.prepare(`INSERT INTO e2e_link_claims(user_id, device_id, claim, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, device_id) DO UPDATE SET claim = excluded.claim, created_at = excluded.created_at`).run(userId, deviceId, claim, Date.now());
    response.status(202).json({ claimed: true });
  });
  app.get('/api/v1/e2e/link-claims', requireSession, async (request, response) => {
    const rows = await db.prepare('SELECT claim FROM e2e_link_claims WHERE user_id = ? AND created_at > ? ORDER BY created_at').all(request.session.user_id, Date.now() - 7 * 24 * 60 * 60 * 1000);
    response.json({ claims: rows.map((row) => JSON.parse(row.claim)) });
  });
  app.delete('/api/v1/e2e/link-claims/:deviceId', requireSession, async (request, response) => {
    await db.prepare('DELETE FROM e2e_link_claims WHERE user_id = ? AND device_id = ?').run(request.session.user_id, String(request.params.deviceId));
    response.status(204).end();
  });

  // Prekey bundles for starting sessions; each one-time prekey is given out once (taken atomically).
  app.post('/api/v1/e2e/users/:userId/bundles', requireSession, async (request, response) => {
    const ids = request.body?.deviceIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_DEVICES_PER_CLAIM || !ids.every((id) => typeof id === 'string' && DEVICE_ID.test(id))) {
      return response.status(400).json({ error: 'Choose the devices to start sessions with.' });
    }
    const live = new Map((await devicesOf(request.params.userId)).map((device) => [device.deviceId, device]));
    const bundles = [];
    for (const deviceId of new Set(ids)) {
      if (!live.has(deviceId)) continue;
      const device = await db.prepare(`SELECT signed_prekey_id AS "id", signed_prekey AS "key", signed_prekey_signature AS "signature"
        FROM e2e_devices WHERE user_id = ? AND device_id = ?`).get(request.params.userId, deviceId);
      let preKey = null;
      for (let attempt = 0; attempt < 3 && !preKey; attempt += 1) {
        const candidate = await db.prepare('SELECT key_id AS "id", public_key AS "key" FROM e2e_prekeys WHERE user_id = ? AND device_id = ? ORDER BY key_id LIMIT 1')
          .get(request.params.userId, deviceId);
        if (!candidate) break;
        const taken = await db.prepare('DELETE FROM e2e_prekeys WHERE user_id = ? AND device_id = ? AND key_id = ? RETURNING key_id AS "id"')
          .get(request.params.userId, deviceId, candidate.id);
        if (taken) preKey = { id: Number(candidate.id), key: candidate.key };
      }
      bundles.push({
        deviceId,
        identity: live.get(deviceId).identity,
        signedPreKey: { id: Number(device.id), key: device.key, signature: device.signature },
        ...(preKey ? { preKey } : {}),
      });
    }
    response.json({ bundles });
  });

  // Every member's key devices; `members` lists all members, so a sender can tell who has no device with keys yet.
  async function groupDevices(groupId) {
    const members = (await db.prepare('SELECT user_id AS "userId" FROM group_members WHERE group_id = ? ORDER BY user_id').all(groupId)).map((row) => row.userId);
    const devices = {};
    for (const userId of members) {
      const list = await devicesOf(userId);
      if (list.length) devices[userId] = list;
    }
    return { members, devices };
  }

  app.get('/api/v1/e2e/groups/:groupId/devices', requireSession, async (request, response) => {
    if (!await db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(request.params.groupId, request.session.user_id)) {
      return response.status(404).json({ error: 'Group not found.' });
    }
    const group = await groupDevices(request.params.groupId);
    const signedLists = {};
    for (const userId of group.members) {
      const signed = await signedListOf(userId);
      if (signed) signedLists[userId] = signed;
    }
    response.json({ ...group, signedLists });
  });

  /**
   * Checks an encrypted direct message (or edit): sent by this device, addressed to every key device of the
   * receiver and of the sender (other than the sending device), and nothing else. Resolves null when the content
   * is fine (or not an envelope), else { status, error, code, devices } for the sender to refresh and retry.
   */
  async function checkDirectEnvelope(content, { senderId, senderDeviceId, receiverId }) {
    if (typeof content !== 'string' || !content.startsWith('e2e2:')) return null;
    if (content.length > MAX_DIRECT_ENVELOPE) return { status: 400, error: 'Message is too long.' };
    const parsed = parseEnvelope(content);
    if (!parsed?.body.d) return { status: 400, error: 'Invalid encrypted message.' };
    if (parsed.body.sd !== senderDeviceId) return { status: 400, error: 'Encrypted by another device.' };
    const devices = { [receiverId]: await devicesOf(receiverId) };
    if (senderId !== receiverId) devices[senderId] = (await devicesOf(senderId)).filter((device) => device.deviceId !== senderDeviceId);
    const expected = [];
    for (const [userId, list] of Object.entries(devices)) for (const device of list) expected.push(`${userId}/${device.deviceId}`);
    const presented = addressesOf(parsed.body.d);
    if (expected.sort().join('\n') !== presented.join('\n')) {
      return { status: 409, code: 'e2e-devices', error: 'The device list changed. Encrypt again.', devices };
    }
    return null;
  }

  /** Checks an encrypted group message: the group's device set (hash) and any key distribution must be current. */
  async function checkGroupEnvelope(content, { groupId, senderId, senderDeviceId }) {
    if (typeof content !== 'string' || !content.startsWith('e2e2:')) return null;
    if (content.length > MAX_GROUP_ENVELOPE) return { status: 400, error: 'Message is too long.' };
    const parsed = parseEnvelope(content);
    if (!parsed?.body.g) return { status: 400, error: 'Invalid encrypted message.' };
    if (parsed.body.sd !== senderDeviceId) return { status: 400, error: 'Encrypted by another device.' };
    const { members, devices } = await groupDevices(groupId);
    const all = [];
    for (const [userId, list] of Object.entries(devices)) for (const device of list) all.push(`${userId}/${device.deviceId}`);
    const stale = { status: 409, code: 'e2e-devices', error: 'The group’s devices changed. Encrypt again.', members, devices };
    if (!all.includes(`${senderId}/${senderDeviceId}`)) return { status: 409, code: 'e2e-keys', error: 'Publish this device’s keys first.', members, devices };
    if (parsed.body.mh !== membersHashOf(all)) return stale;
    if (parsed.body.x) {
      const others = all.filter((item) => item !== `${senderId}/${senderDeviceId}`).sort();
      if (others.join('\n') !== addressesOf(parsed.body.x).join('\n')) return stale;
    }
    return null;
  }

  /** The group's current members hash (what checkGroupEnvelope compares a group envelope's mh with). */
  async function groupMembersHash(groupId) {
    const { devices } = await groupDevices(groupId);
    const all = [];
    for (const [userId, list] of Object.entries(devices)) for (const device of list) all.push(`${userId}/${device.deviceId}`);
    return membersHashOf(all);
  }

  return { checkDirectEnvelope, checkGroupEnvelope, groupMembersHash, forgetDevice, forgetStaleDevices, devicesOf, signedListOf };
}
