// Settings registry, WhatsApp-style privacy categories enforced by the server, and encrypted local storage
// (envelope encryption with the data key protected by the Android Keystore or a non-extractable Web Crypto key).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createChatServer } from './index.mjs';
import { createSecureStorage, isSecureRecord } from '../src/secureStorage.js';
import { DEVICE_SETTINGS_KEY, SETTINGS, SETTINGS_VERSION, createSettings, migrateDeviceRecord, validSetting } from '../src/settings.js';
import { audienceAllows, parsePrivacyPatch, presenceFor, visibleStatus } from './presence.mjs';

const PASSWORD = 'Correct-Horse-Battery-42!';
const root = new URL('../', import.meta.url);
const source = (path) => readFile(new URL(path, root), 'utf8');
let service;
let directory;
let baseUrl;
let counter = 0;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-settings-'));
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), pushSender: null });
  baseUrl = `http://127.0.0.1:${(await service.listen()).port}`;
});
after(async () => {
  await service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function api(path, { session, method = 'GET', body, raw } = {}) {
  const response = await fetch(baseUrl + path, { method, headers: { ...(session ? { Authorization: `Bearer ${session.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: response.status, body: parsed };
}
async function register(prefix) {
  counter += 1;
  const { status, body } = await api('/api/v1/auth/register', { method: 'POST', body: { username: `${prefix}${counter}`, dob: '1990-04-12', password: PASSWORD } });
  assert.equal(status, 201);
  return body;
}
function connect(session) {
  const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/ws', [`relay.auth.${session.token}`, 'relay.v1']);
  socket.events = [];
  socket.on('message', (raw) => socket.events.push(JSON.parse(raw.toString())));
  return new Promise((resolve, reject) => { socket.once('open', () => resolve(socket)); socket.once('error', reject); });
}
function until(check, label, timeout = 4000) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    (function poll() {
      const value = check();
      if (value) return resolve(value);
      if (Date.now() > deadline) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(poll, 20);
    })();
  });
}
const memoryStorage = () => {
  const map = new Map();
  return { map, get: async (key) => map.get(key), set: async (key, value) => { map.set(key, value); }, del: async (key) => { map.delete(key); } };
};
// A stand-in for the Android Keystore: seals with a key the storage never sees.
const fakeKeystore = () => {
  const key = randomBytes(32);
  return {
    seal: async (text) => { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()]); return 'ks1:' + Buffer.concat([iv, data]).toString('base64'); },
    open: async (sealed) => { const all = Buffer.from(sealed.slice(4), 'base64'); const decipher = createDecipheriv('aes-256-gcm', key, all.subarray(0, 12)); decipher.setAuthTag(all.subarray(all.length - 16)); return Buffer.concat([decipher.update(all.subarray(12, all.length - 16)), decipher.final()]).toString('utf8'); },
  };
};

test('encrypted local storage: nothing readable at rest, records bound to their name, old records upgraded', async () => {
  const storage = memoryStorage();
  const secure = createSecureStorage({ storage });
  const account = { token: 'secret-session-token-123', user: { id: 'u1', name: 'Ava' } };
  await secure.set('relay:accounts', account);
  const atRest = storage.map.get('relay:accounts');
  assert.ok(isSecureRecord(atRest));
  assert.ok(!JSON.stringify(atRest).includes('secret-session-token'), 'the token is not on disk in the clear');
  assert.deepEqual(await secure.get('relay:accounts'), account);
  const dataKey = storage.map.get('hm:data-key-v1');
  assert.equal(dataKey.extractable, false, 'the browser data key cannot be read out by scripts');

  // A record copied under another name does not decrypt (bound by additional data); tampering is refused.
  storage.map.set('relay:session', atRest);
  assert.equal(await secure.get('relay:session'), undefined);
  storage.map.set('relay:accounts', { ...atRest, data: atRest.data.slice(0, -4) + 'AAAA' });
  assert.equal(await secure.get('relay:accounts'), undefined);

  // Written before encryption: read once, then stored encrypted.
  storage.map.set('relay:messages:u1', { u2: [{ id: 'm1', content: 'hello' }] });
  assert.deepEqual(await secure.get('relay:messages:u1'), { u2: [{ id: 'm1', content: 'hello' }] });
  assert.ok(isSecureRecord(storage.map.get('relay:messages:u1')), 'upgraded on first read');
  assert.equal(await secure.get('missing'), undefined);
});

test('in the Android app the data key exists on disk only sealed by the Keystore', async () => {
  const storage = memoryStorage();
  const keystore = fakeKeystore();
  const secure = createSecureStorage({ storage, platform: keystore });
  await secure.set('relay:outbox:u1', [{ id: 'x', content: 'queued' }]);
  const sealed = storage.map.get('hm:data-key-sealed-v1');
  assert.ok(typeof sealed === 'string' && sealed.startsWith('ks1:'));
  assert.equal(storage.map.get('hm:data-key-v1'), undefined, 'no unsealed key is stored');
  // A fresh start (new process) opens the same key through the Keystore and reads the record.
  const reopened = createSecureStorage({ storage, platform: keystore });
  assert.deepEqual(await reopened.get('relay:outbox:u1'), [{ id: 'x', content: 'queued' }]);
  // Copied to another phone (a different Keystore): the records cannot be read there.
  const elsewhere = createSecureStorage({ storage, platform: fakeKeystore() });
  assert.equal(await elsewhere.get('relay:outbox:u1'), undefined);
});

test('settings registry: declared once, validated, versioned with migrations, account settings roll back', async () => {
  assert.equal(validSetting('privacy.lastSeen', 'nobody'), 'nobody');
  assert.equal(validSetting('privacy.lastSeen', 'friends'), 'everyone', 'an unknown value falls back to the default');
  assert.equal(validSetting('privacy.readReceipts', 'yes'), true);
  assert.throws(() => validSetting('nope', 1), /Unknown setting/);
  assert.deepEqual(migrateDeviceRecord(null, (key) => (key === 'hm:noise-cancellation' ? 'off' : null)), { version: SETTINGS_VERSION, values: { 'calls.noiseCancellation': false } });

  const local = new Map([['hm:noise-cancellation', 'off']]);
  const storage = { getItem: (key) => local.get(key) ?? null, setItem: (key, value) => local.set(key, value), removeItem: (key) => local.delete(key) };
  let serverState = { lastSeen: 'everyone', online: 'same_as_last_seen', profilePhoto: 'everyone', readReceipts: true };
  let refuse = false;
  const remote = {
    load: async () => ({ ...serverState }),
    save: async (patch) => { if (refuse) throw new Error('offline'); serverState = { ...serverState, ...patch }; return { ...serverState }; },
  };
  const settings = createSettings({ storage, remote });
  assert.equal(settings.get('calls.noiseCancellation'), false, 'migrated from the old key');
  assert.equal(JSON.parse(local.get(DEVICE_SETTINGS_KEY)).version, SETTINGS_VERSION);
  await settings.set('calls.noiseCancellation', true);
  assert.equal(JSON.parse(local.get(DEVICE_SETTINGS_KEY)).values['calls.noiseCancellation'], true);
  await assert.rejects(settings.set('calls.noiseCancellation', 'loud'), /Invalid value/);

  await settings.loadAccount();
  assert.equal(settings.snapshot().accountLoaded, true);
  let notified = 0;
  settings.subscribe(() => { notified += 1; });
  await settings.set('privacy.profilePhoto', 'contacts');
  assert.equal(serverState.profilePhoto, 'contacts');
  assert.ok(notified >= 1);
  refuse = true;
  const pending = settings.set('privacy.readReceipts', false);
  assert.equal(settings.get('privacy.readReceipts'), false, 'shows at once');
  await assert.rejects(pending, /offline/);
  assert.equal(settings.get('privacy.readReceipts'), true, 'rolled back when the server refuses');
  settings.clearAccount();
  assert.equal(settings.get('privacy.profilePhoto'), SETTINGS['privacy.profilePhoto'].default);
});

test('privacy rules: audiences, online vs last seen, blue ticks need both sides', () => {
  assert.equal(audienceAllows({ ownerId: 'a', viewerId: 'b', audience: 'nobody' }), false);
  assert.equal(audienceAllows({ ownerId: 'a', viewerId: 'a', audience: 'nobody' }), true, 'always visible to yourself');
  assert.equal(audienceAllows({ ownerId: 'a', viewerId: 'b', audience: 'contacts', ownerContactIds: new Set(['b']) }), true);
  assert.deepEqual(presenceFor({ online: true, lastSeenAt: 5, visible: false, onlineVisible: true }), { status: 'online', lastSeenAt: null });
  assert.deepEqual(presenceFor({ online: false, lastSeenAt: 5, visible: false, onlineVisible: true }), { status: 'hidden', lastSeenAt: null });
  assert.deepEqual(presenceFor({ online: true, lastSeenAt: 5, visible: true, onlineVisible: false }), { status: 'offline', lastSeenAt: 5 });
  assert.equal(visibleStatus('read', { senderReceipts: true, receiverReceipts: false }), 'delivered');
  assert.equal(visibleStatus('read', { senderReceipts: false, receiverReceipts: true }), 'delivered');
  assert.equal(visibleStatus('read'), 'read');
  assert.equal(visibleStatus('delivered', { senderReceipts: false }), 'delivered');
  assert.deepEqual(parsePrivacyPatch({ online: 'everyone', readReceipts: false }), { patch: { online: 'everyone', readReceipts: false } });
  assert.match(parsePrivacyPatch({ readReceipts: 'no' }).error, /on or off/);
  assert.match(parsePrivacyPatch({}).error, /Nothing/);
});

test('server: privacy settings API, online visible to everyone, profile photo audience, read receipts', async () => {
  const owner = await register('privo');
  const friend = await register('privf');
  const stranger = await register('privs');
  await api('/api/v1/contacts', { session: owner, method: 'POST', body: { userId: friend.user.id } });
  await api('/api/v1/contacts', { session: friend, method: 'POST', body: { userId: owner.user.id } });
  await api('/api/v1/contacts', { session: stranger, method: 'POST', body: { userId: owner.user.id } });

  assert.deepEqual((await api('/api/v1/me/privacy', { session: owner })).body, { lastSeen: 'everyone', online: 'same_as_last_seen', profilePhoto: 'everyone', readReceipts: true, about: 'everyone', silenceUnknownCallers: false, defaultTimer: 0, discoverableByUsername: true });
  assert.equal((await api('/api/v1/me/privacy', { session: owner, method: 'PUT', body: { online: 'sometimes' } })).status, 400);
  const updated = await api('/api/v1/me/privacy', { session: owner, method: 'PUT', body: { lastSeen: 'nobody', online: 'everyone' } });
  assert.deepEqual(updated.body, { lastSeen: 'nobody', online: 'everyone', profilePhoto: 'everyone', readReceipts: true, about: 'everyone', silenceUnknownCallers: false, defaultTimer: 0, discoverableByUsername: true });

  // Online "Everyone" with last seen "Nobody": others see the owner online, never a last seen time.
  const watcher = await connect(stranger);
  const ownerSocket = await connect(owner);
  const latest = () => watcher.events.filter((event) => event.type === 'presence:update' && event.userId === owner.user.id).at(-1);
  await until(() => latest()?.status === 'online', 'stranger sees online');
  ownerSocket.close();
  await until(() => latest()?.status === 'hidden', 'offline hides the last seen time');
  assert.equal(latest().lastSeenAt, null);
  watcher.close();

  // Profile photo for "My contacts": the saved friend sees it, the stranger does not.
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  const uploaded = await fetch(`${baseUrl}/api/v1/me/avatar`, { method: 'PUT', headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'image/png' }, body: Buffer.concat([png, Buffer.alloc(64)]) });
  assert.ok(uploaded.ok, `avatar upload: ${uploaded.status}`);
  {
    await api('/api/v1/me/privacy', { session: owner, method: 'PUT', body: { profilePhoto: 'contacts' } });
    assert.equal((await api(`/api/v1/users/${owner.user.id}/avatar`, { session: friend })).status, 200);
    assert.equal((await api(`/api/v1/users/${owner.user.id}/avatar`, { session: stranger })).status, 404);
    await api('/api/v1/me/privacy', { session: owner, method: 'PUT', body: { profilePhoto: 'nobody' } });
    assert.equal((await api(`/api/v1/users/${owner.user.id}/avatar`, { session: friend })).status, 404);
    assert.equal((await api(`/api/v1/users/${owner.user.id}/avatar`, { session: owner })).status, 200, 'you always see your own');
  }

  // Read receipts off on the reader's side: the sender gets no blue tick, now or in history.
  await api('/api/v1/me/privacy', { session: friend, method: 'PUT', body: { readReceipts: false } });
  const sender = await connect(owner);
  const reader = await connect(friend);
  await until(() => reader.events.some((event) => event.type === 'connection:ready'), 'ready');
  sender.send(JSON.stringify({ type: 'message:send', message: { id: 'rr-1', receiverId: friend.user.id, content: 'hi' } }));
  await until(() => reader.events.some((event) => event.type === 'message:new' && event.message.id === 'rr-1'), 'delivered');
  reader.send(JSON.stringify({ type: 'message:read', messageId: 'rr-1' }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(!sender.events.some((event) => event.type === 'message:status' && event.messageId === 'rr-1' && event.status === 'read'), 'no blue tick event');
  const history = (await api(`/api/v1/messages?peerId=${friend.user.id}`, { session: owner })).body;
  assert.notEqual(history.find((message) => message.id === 'rr-1').status, 'read', 'no blue tick in history');
  const readerHistory = (await api(`/api/v1/messages?peerId=${owner.user.id}`, { session: friend })).body;
  assert.equal(readerHistory.find((message) => message.id === 'rr-1').status, 'read', 'the reader still knows they read it');

  // Turned back on: blue ticks flow again.
  await api('/api/v1/me/privacy', { session: friend, method: 'PUT', body: { readReceipts: true } });
  sender.send(JSON.stringify({ type: 'message:send', message: { id: 'rr-2', receiverId: friend.user.id, content: 'again' } }));
  await until(() => reader.events.some((event) => event.type === 'message:new' && event.message.id === 'rr-2'), 'delivered 2');
  reader.send(JSON.stringify({ type: 'message:read', messageId: 'rr-2' }));
  await until(() => sender.events.some((event) => event.type === 'message:status' && event.messageId === 'rr-2' && event.status === 'read'), 'blue tick');
  sender.close();
  reader.close();
});

test('Android: secrets sealed by the Keystore; the web app opens its data key through it', async () => {
  const java = (file) => source(`android/app/src/main/java/io/github/bickworld555/hiddenchat/${file}`);
  const store = await java('SecureStore.java');
  assert.ok(store.includes('KeyStore.getInstance(KEYSTORE)') && store.includes('"AndroidKeyStore"'));
  assert.ok(store.includes('Cipher.getInstance("AES/GCM/NoPadding")') && store.includes('.setKeySize(256)'));
  const session = await java('RelaySession.java');
  assert.ok(session.includes('.putString("token", SecureStore.sealOrKeep(token))'), 'the session token is sealed');
  assert.ok(session.includes('if (!SecureStore.isSealed(stored))'), 'old plain tokens are sealed on read');
  const push = await java('PushRegistration.java');
  assert.ok(push.includes('SecureStore.sealOrKeep(key)'), 'the push payload key is sealed');
  const plugin = await java('HiddenNativePlugin.java');
  assert.ok(plugin.includes('public void sealSecret(PluginCall call)') && plugin.includes('public void openSecret(PluginCall call)'));
  const store2 = await source('src/store.js');
  assert.ok(store2.includes("import { secureDel as del, secureGet as get, secureSet as set, secureStorage } from './secureStorage.js';"), 'outbox and calls are encrypted');
  assert.ok(store2.includes('createMessageDb({ seal: (name, value) => secureStorage().seal(name, value), open: (name, record) => secureStorage().open(name, record) })'), 'every message row is sealed with the same Keystore-protected key');
  const accounts = await source('src/accounts.js');
  assert.ok(accounts.includes("from './secureStorage.js'"), 'session tokens are encrypted');
});
