// One device's end-to-end state: its identity and prekeys, its Double Ratchet sessions with every other device
// (contacts' devices and the account's own other devices), and its group sender keys. No network here: the
// key directory is passed in (src/e2e/client.js talks to the server).
//
// Storage holds structured-clone values (IndexedDB in the app): private keys and chain keys are non-extractable
// CryptoKeys. Every operation runs one at a time (a session must never be used by two operations at once), and
// state is saved only after an operation fully succeeded.
import { fromUtf8, generateDhPair, generateSigningPair, sha256Hex, toBase64, utf8 } from './primitives.js';
import { identityBytes, initInitiator, initResponder, parseIdentity, publicIdentity, ratchetDecrypt, ratchetEncrypt, signPreKey, x3dhInitiate, x3dhRespond } from './ratchet.js';
import { acceptDistribution, createSenderKey, senderKeyDecrypt, senderKeyEncrypt } from './senderKeys.js';
import { membersHash } from './envelope.js';

export const PREKEY_BATCH = 100;
export const PREKEY_LOW_WATER = 25;
export const SIGNED_PREKEY_ROTATION_MS = 7 * 24 * 60 * 60 * 1000;
const KEEP_SIGNED_PREKEYS = 3;
const KEEP_PREVIOUS_SESSIONS = 4;
const KEEP_RECEIVING_SENDER_KEYS = 4;

export const address = (userId, deviceId) => `${userId}/${deviceId}`;
// A published identity ({ dh, sig } base64) in the form sessions remember it.
const presentedIdentity = (identity) => toBase64(identityBytes(parseIdentity(identity)));

export class E2eError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'E2eError';
    this.code = code;
  }
}

export function createProtocol({ storage, api, onIdentityChange = null } = {}) {
  let queue = Promise.resolve();
  // Serialises every operation: sessions and prekeys are read, advanced and written back as one step.
  const exclusive = (task) => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };

  async function identity() {
    const stored = await storage.get('identity');
    if (stored) return stored;
    const created = { dh: await generateDhPair(api), sig: await generateSigningPair(api), createdAt: Date.now() };
    await storage.set('identity', created);
    return created;
  }

  async function newSignedPreKey(ownIdentity, id, now) {
    const keyPair = await generateDhPair(api);
    const record = { id, keyPair, signature: await signPreKey(ownIdentity, keyPair.publicKey, api), createdAt: now };
    await storage.set(`spk:${id}`, record);
    return record;
  }

  /**
   * Creates what is missing or due: the identity, a signed prekey (rotated weekly, the last few kept for messages
   * still in flight) and one-time prekeys up to a full batch. `serverPreKeyCount` is how many the server still has.
   * Resolves the upload: { identity, signedPreKey, preKeys } (only what is new besides the identity).
   */
  function prepareUpload({ serverPreKeyCount = 0, now = Date.now() } = {}) {
    return exclusive(async () => {
      const own = await identity();
      const meta = (await storage.get('meta')) ?? { spkIds: [], nextSpkId: 1, nextPreKeyId: 1 };
      let current = meta.spkIds.length ? await storage.get(`spk:${meta.spkIds[meta.spkIds.length - 1]}`) : null;
      if (!current || now - current.createdAt > SIGNED_PREKEY_ROTATION_MS) {
        current = await newSignedPreKey(own, meta.nextSpkId, now);
        meta.spkIds.push(current.id);
        meta.nextSpkId += 1;
        for (const old of meta.spkIds.splice(0, Math.max(0, meta.spkIds.length - KEEP_SIGNED_PREKEYS))) await storage.del(`spk:${old}`);
      }
      const preKeys = [];
      if (serverPreKeyCount < PREKEY_LOW_WATER) {
        for (let count = serverPreKeyCount; count < PREKEY_BATCH; count += 1) {
          const id = meta.nextPreKeyId;
          meta.nextPreKeyId += 1;
          const keyPair = await generateDhPair(api);
          await storage.set(`opk:${id}`, keyPair);
          preKeys.push({ id, key: toBase64(keyPair.publicKey) });
        }
      }
      await storage.set('meta', meta);
      return {
        identity: publicIdentity(own),
        signedPreKey: { id: current.id, key: toBase64(current.keyPair.publicKey), signature: toBase64(current.signature) },
        preKeys,
      };
    });
  }

  // Trust on first use: a device's identity key is pinned the first time it is seen. A different key later means
  // the device's keys were reset (or someone substituted them). With `onIdentityChange` (the app) the new key is
  // accepted and the change reported, like WhatsApp's "security code changed"; without it the key is refused.
  // Remembering happens only after a message decrypted (or was encrypted), so a forged message cannot pin a key.
  async function checkTrusted(userId, deviceId, remote) {
    const key = `known:${address(userId, deviceId)}`;
    const known = await storage.get(key);
    const presented = toBase64(identityBytes(remote));
    if (known === presented) return null;
    if (known && !onIdentityChange) throw new E2eError('identity-mismatch', 'This device’s security key changed. Messages to and from it are blocked.');
    return async () => {
      await storage.set(key, presented);
      if (known) onIdentityChange(userId, deviceId);
    };
  }

  async function loadSessions(target) {
    return (await storage.get(`session:${target}`)) ?? { current: null, previous: [] };
  }

  async function saveSessions(target, record) {
    await storage.set(`session:${target}`, record);
  }

  /**
   * Encrypts `plaintext` (string) for each device in `devices` ({ [userId]: [{ deviceId }] }). Devices without a
   * session get one from their prekey bundle: `claimBundles(userId, deviceIds)` resolves [{ deviceId, identity,
   * signedPreKey, preKey? }]. Resolves { [userId]: { [deviceId]: { p?, h, c } } }.
   */
  async function encryptCore(devices, plaintext, claimBundles) {
    const own = await identity();
    const bytes = utf8(plaintext);
    const out = {};
    const updates = [];
    const trustUpdates = [];
    for (const [userId, list] of Object.entries(devices)) {
      const records = new Map();
      const missing = [];
      for (const { deviceId, identity: listed } of list) {
        let record = await loadSessions(address(userId, deviceId));
        // The directory lists a different identity for this device (its keys were reset): start a new session.
        if (record.current && listed && record.current.remote && record.current.remote !== presentedIdentity(listed)) {
          record = { current: null, previous: [record.current, ...record.previous].slice(0, KEEP_PREVIOUS_SESSIONS) };
        }
        records.set(deviceId, record);
        if (!record.current) missing.push(deviceId);
      }
      if (missing.length) {
        const bundles = await claimBundles(userId, missing);
        for (const deviceId of missing) {
          const bundle = bundles.find((item) => item.deviceId === deviceId);
          if (!bundle) throw new E2eError('no-bundle', 'A device of this contact has no encryption keys yet.');
          const agreed = await x3dhInitiate(own, bundle, api);
          const remember = await checkTrusted(userId, deviceId, agreed.remoteIdentity);
          if (remember) trustUpdates.push(remember);
          const ratchet = await initInitiator(agreed.secret, agreed.remoteSignedPreKey, agreed.ad, api);
          records.get(deviceId).current = { ratchet, pending: agreed.preKeyHeader, baseKey: agreed.preKeyHeader.ek, remote: toBase64(identityBytes(agreed.remoteIdentity)) };
        }
      }
      out[userId] = {};
      for (const { deviceId } of list) {
        const record = records.get(deviceId);
        const sealed = await ratchetEncrypt(record.current.ratchet, bytes, api);
        const next = { ...record, current: { ...record.current, ratchet: sealed.state } };
        updates.push([address(userId, deviceId), next]);
        out[userId][deviceId] = { ...(record.current.pending ? { p: record.current.pending } : {}), h: sealed.header, c: sealed.ciphertext };
      }
    }
    for (const [target, record] of updates) await saveSessions(target, record);
    for (const remember of trustUpdates) await remember();
    return out;
  }
  const encryptForDevices = (devices, plaintext, { claimBundles }) => exclusive(() => encryptCore(devices, plaintext, claimBundles));

  /** Decrypts one device entry { p?, h, c } from userId/deviceId: resolves the plaintext string. */
  async function decryptCore(userId, deviceId, entry) {
    if (!entry || typeof entry !== 'object') throw new E2eError('not-addressed', 'This message was not encrypted for this device.');
    const target = address(userId, deviceId);
    const record = await loadSessions(target);
    const candidates = [];
    if (entry.p) {
      const existing = [record.current, ...record.previous].filter(Boolean).find((session) => session.baseKey === entry.p.ek);
      if (existing) candidates.push(existing);
      else candidates.push(await respondTo(userId, deviceId, entry.p));
    } else {
      candidates.push(...[record.current, ...record.previous].filter(Boolean));
    }
    let lastError = new E2eError('no-session', 'No secure session with this device yet.');
    for (const session of candidates) {
      try {
        const opened = await ratchetDecrypt(session.ratchet, entry.h, entry.c, api);
        // The other side answered: the prekey header is no longer needed on what this device sends.
        const { consumePreKey, remember, ...kept } = session;
        const updated = { ...kept, ratchet: opened.state, pending: entry.p ? session.pending : null };
        const others = [record.current, ...record.previous].filter((item) => item && item !== session && item.baseKey !== session.baseKey);
        await saveSessions(target, { current: updated, previous: others.slice(0, KEEP_PREVIOUS_SESSIONS) });
        if (consumePreKey !== undefined) await storage.del(`opk:${consumePreKey}`);
        if (remember) await remember();
        return fromUtf8(opened.plaintext);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof E2eError ? lastError : new E2eError('decrypt-failed', 'This message could not be decrypted.');
  }
  const decryptFromDevice = (userId, deviceId, entry) => exclusive(() => decryptCore(userId, deviceId, entry));

  async function respondTo(userId, deviceId, header) {
    const own = await identity();
    const signed = await storage.get(`spk:${header.spk}`);
    if (!signed) throw new E2eError('stale-prekey', 'This message used an expired key.');
    const oneTime = header.opk !== undefined ? await storage.get(`opk:${header.opk}`) : null;
    if (header.opk !== undefined && !oneTime) throw new E2eError('stale-prekey', 'This message used a key that was already used.');
    const agreed = await x3dhRespond(own, header, signed.keyPair, oneTime, api);
    const remember = await checkTrusted(userId, deviceId, agreed.remoteIdentity);
    const ratchet = await initResponder(agreed.secret, signed.keyPair, agreed.ad, api);
    return {
      ratchet,
      pending: null,
      baseKey: header.ek,
      remote: toBase64(identityBytes(agreed.remoteIdentity)),
      ...(oneTime ? { consumePreKey: header.opk } : {}),
      ...(remember ? { remember } : {}),
    };
  }

  // --- Groups (Sender Keys) ---

  /**
   * Encrypts a group message. `memberDevices` is { [userId]: [deviceId] } for every member device with keys,
   * this one included. Resolves { body: { mh, g, x? }, keyId }; call confirmGroupSend(groupId, keyId) once the
   * server stored the message, so the distribution stops being attached.
   */
  function encryptGroup(groupId, me, memberDevices, plaintext, { claimBundles, digest }) {
    return exclusive(async () => {
      const all = [];
      for (const [userId, ids] of Object.entries(memberDevices)) for (const deviceId of ids) all.push(address(userId, deviceId));
      const mh = await membersHash(all, digest);
      let own = await storage.get(`sk-own:${groupId}`);
      if (!own || own.state.membersHash !== mh) {
        const created = await createSenderKey(groupId, mh, api);
        own = { state: created.state, distribution: created.distribution };
      }
      let x;
      if (own.distribution) {
        const targets = {};
        for (const [userId, ids] of Object.entries(memberDevices)) {
          const list = ids.filter((deviceId) => !(userId === me.userId && deviceId === me.deviceId)).map((deviceId) => ({ deviceId }));
          if (list.length) targets[userId] = list;
        }
        x = await encryptCore(targets, JSON.stringify(own.distribution), claimBundles);
      }
      const sealed = await senderKeyEncrypt(own.state, address(me.userId, me.deviceId), utf8(plaintext), api);
      await storage.set(`sk-own:${groupId}`, { ...own, state: sealed.state });
      return { body: { mh, g: sealed.message, ...(x ? { x } : {}) }, keyId: own.state.keyId };
    });
  }

  function confirmGroupSend(groupId, keyId) {
    return exclusive(async () => {
      const own = await storage.get(`sk-own:${groupId}`);
      if (own?.distribution && own.state.keyId === keyId) await storage.set(`sk-own:${groupId}`, { state: own.state, distribution: null });
    });
  }

  /** Forgets this device's sender key for a group (after a membership change it starts a fresh one anyway). */
  function resetGroup(groupId) {
    return exclusive(() => storage.del(`sk-own:${groupId}`));
  }

  /** Decrypts a group message body from userId/deviceId for this device (`me`). Resolves the plaintext string. */
  function decryptGroup(groupId, me, userId, deviceId, body) {
    return exclusive(async () => {
      const sender = address(userId, deviceId);
      const key = `sk-in:${groupId}:${sender}`;
      let states = (await storage.get(key)) ?? [];
      const mine = body.x?.[me.userId]?.[me.deviceId];
      if (mine && !states.some((state) => state.keyId === body.g?.kid)) {
        const distribution = JSON.parse(await decryptCore(userId, deviceId, mine));
        if (distribution.kid !== body.g?.kid) throw new E2eError('decrypt-failed', 'The group key does not match its message.');
        states = [await acceptDistribution(distribution, groupId, api), ...states].slice(0, KEEP_RECEIVING_SENDER_KEYS);
        await storage.set(key, states);
      }
      const index = states.findIndex((state) => state.keyId === body.g?.kid);
      if (index < 0) throw new E2eError('no-sender-key', 'Waiting for this message. Ask the sender to open the group so it can be resent securely.');
      const opened = await senderKeyDecrypt(states[index], sender, body.g, api);
      states = states.map((state, position) => (position === index ? opened.state : state));
      await storage.set(key, states);
      return fromUtf8(opened.plaintext);
    });
  }

  /** Safety number for two sets of device identities (each [{ dh, sig }] base64): 60 digits in 12 groups. */
  async function safetyNumber(mineList, theirsList) {
    const flatten = (list) => list.map((item) => `${item.dh}.${item.sig}`).sort().join(',');
    const [first, second] = [flatten(mineList), flatten(theirsList)].sort();
    let digest = utf8(`${first}|${second}`);
    for (let round = 0; round < 1024; round += 1) digest = new Uint8Array(await (api ?? globalThis.crypto).subtle.digest('SHA-256', digest));
    const groups = [];
    for (let index = 0; index < 12; index += 1) {
      const value = ((digest[(index * 2) % 32] << 16) | (digest[(index * 2 + 1) % 32] << 8) | digest[(index * 2 + 5) % 32]) % 100000;
      groups.push(String(value).padStart(5, '0'));
    }
    return groups.join(' ');
  }

  async function publicIdentityNow() {
    return exclusive(async () => publicIdentity(await identity()));
  }

  return {
    prepareUpload,
    encryptForDevices,
    decryptFromDevice,
    encryptGroup,
    confirmGroupSend,
    resetGroup,
    decryptGroup,
    safetyNumber,
    publicIdentity: publicIdentityNow,
    digest: (text) => sha256Hex(text, api),
    parseIdentity,
  };
}
