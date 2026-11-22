// Notification previews (src/e2e/preview.js): sealed by the sender for one phone's preview key, carried by the server
// into that phone's push only, and opened on the phone without the app's message keys.
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';
import { createChatServer } from './index.mjs';
import { createProtocol } from '../src/e2e/protocol.js';
import { buildEnvelope, routingFor } from '../src/e2e/envelope.js';
import { generateDhPair, toBase64 } from '../src/e2e/primitives.js';
import { PREVIEW_MAX_CHARS, openPreview, previewText, sealPreview, validPreviewKey } from '../src/e2e/preview.js';
import { bodyForDevice, previews, pushBody } from './push.mjs';

const memory = () => { const map = new Map(); return { get: async (k) => map.get(k), set: async (k, v) => { map.set(k, v); }, del: async (k) => { map.delete(k); } }; };

// What PreviewKey.java does, with Node's own primitives (not the code under test): ECDH on P-256, HKDF-SHA-256 with
// salt = ephemeral ‖ recipient public keys and info "hm-preview-v1", AES-256-GCM with the sender's id as associated data.
function openLikeThePhone(sealedBase64, ecdh, senderId) {
  const sealed = Buffer.from(sealedBase64, 'base64');
  const ephemeral = sealed.subarray(0, 65);
  const iv = sealed.subarray(65, 77);
  const body = sealed.subarray(77, sealed.length - 16);
  const shared = ecdh.computeSecret(ephemeral);
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephemeral, ecdh.getPublicKey()]), Buffer.from('hm-preview-v1'), 32));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(senderId));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'));
}

test('a sealed preview opens only with the phone\'s key, for the sender it names, untampered', async () => {
  const phone = await generateDhPair();
  const sealed = await sealPreview(toBase64(phone.publicKey), 'Hello *there*, lunch at one?', 'user-a', { now: 1000 });
  assert.deepEqual(await openPreview(sealed, phone, 'user-a'), { text: 'Hello *there*, lunch at one?', at: 1000 });
  assert.equal(await openPreview(sealed, phone, 'user-b'), null, 'another sender\'s id does not open it');
  assert.equal(await openPreview(sealed, await generateDhPair(), 'user-a'), null, 'another phone cannot open it');
  const bytes = Buffer.from(sealed, 'base64');
  bytes[bytes.length - 1] ^= 1;
  assert.equal(await openPreview(bytes.toString('base64'), phone, 'user-a'), null, 'a changed byte is refused');
  assert.notEqual(sealed, await sealPreview(toBase64(phone.publicKey), 'Hello *there*, lunch at one?', 'user-a', { now: 1000 }), 'a fresh ephemeral key every time');
});

test('the sealed form is what the phone\'s own code opens (standard ECDH, HKDF-SHA-256, AES-256-GCM)', async () => {
  const phone = createECDH('prime256v1');
  phone.generateKeys();
  const sealed = await sealPreview(phone.getPublicKey().toString('base64'), 'মেসেজ এসেছে 👋', 'user-a', { now: 42 });
  assert.deepEqual(openLikeThePhone(sealed, phone, 'user-a'), { t: 'মেসেজ এসেছে 👋', at: 42 });
  assert.throws(() => openLikeThePhone(sealed, phone, 'user-b'));
  assert.ok(sealed.length < 1400, 'fits a push');
});

test('previews are one line and at most PREVIEW_MAX_CHARS characters', () => {
  assert.equal(previewText('  two\nlines\t here '), 'two lines here');
  const long = previewText('😀'.repeat(400));
  assert.equal(Array.from(long).length, PREVIEW_MAX_CHARS);
  assert.ok(long.endsWith('…'));
  assert.equal(previewText(null), '');
});

test('a preview key counts only when signed by the device\'s identity key', async () => {
  const device = createProtocol({ storage: memory() });
  const other = createProtocol({ storage: memory() });
  const key = toBase64((await generateDhPair()).publicKey);
  const signature = await device.signPreviewKey(key);
  const identity = await device.publicIdentity();
  assert.equal(await validPreviewKey(identity.sig, { key, signature }), true);
  assert.equal(await validPreviewKey((await other.publicIdentity()).sig, { key, signature }), false, 'another identity');
  assert.equal(await validPreviewKey(identity.sig, { key: toBase64((await generateDhPair()).publicKey), signature }), false, 'a swapped key');
  assert.equal(await validPreviewKey(identity.sig, { key }), false);
  assert.equal(await validPreviewKey(identity.sig, null), false);
});

test('a push body carries each phone only its own sealed preview', () => {
  const pvs = { 'dev-1': 'QUJD', 'dev-2': 'REVG' };
  const body = pushBody.wake({ from: 'a', messageId: 'm1', pvs });
  assert.equal(body.id, 'm1', 'the wake-up names its message (the phone shows the preview under that id)');
  assert.deepEqual(bodyForDevice(body, 'dev-1'), { t: 'xwake', pid: 'w:m1', id: 'm1', from: 'a', pv: 'QUJD' });
  assert.deepEqual(bodyForDevice(body, 'dev-3'), { t: 'xwake', pid: 'w:m1', id: 'm1', from: 'a' }, 'a phone without one gets none');
  assert.deepEqual(bodyForDevice(body, null), { t: 'xwake', pid: 'w:m1', id: 'm1', from: 'a' });
  assert.deepEqual(bodyForDevice(pushBody.message({ id: 'm1', from: 'a' }), 'dev-1'), { t: 'msg', pid: 'm:m1', id: 'm1', from: 'a' });
  assert.equal(previews({ d: 'not base64!' }), undefined);
  assert.equal(previews({ d: 'A'.repeat(1500) }), undefined, 'too large for a push');
  assert.equal(previews('x'), undefined);
});

// --- Through the real server ---
const PASSWORD = 'correct horse battery staple';
const sent = [];
const fakePush = { send: async (token, data) => { sent.push({ token, data }); return { ok: true }; } };
let service;
let directory;
let baseUrl;
let counter = 0;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-preview-'));
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), pushSender: fakePush });
  baseUrl = `http://127.0.0.1:${(await service.listen()).port}`;
});
after(async () => {
  await service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function api(path, { session, method = 'GET', body } = {}) {
  const response = await fetch(baseUrl + path, { method, headers: { 'X-HM-Client': '3', ...(session ? { Authorization: `Bearer ${session.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
async function register(prefix) {
  counter += 1;
  const { status, body } = await api('/api/v1/auth/register', { method: 'POST', body: { username: `${prefix}${counter}`, dob: '1990-04-12', password: PASSWORD } });
  assert.equal(status, 201);
  const protocol = createProtocol({ storage: memory() });
  assert.ok((await api('/api/v1/e2e/keys', { session: body, method: 'PUT', body: await protocol.prepareUpload({ serverPreKeyCount: 0 }) })).status < 300);
  return { ...body, protocol };
}
function decryptPush(key, data) {
  const blob = Buffer.from(data.enc, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64'), Buffer.from(data.iv, 'base64'));
  decipher.setAuthTag(blob.subarray(blob.length - 16));
  return JSON.parse(Buffer.concat([decipher.update(blob.subarray(0, blob.length - 16)), decipher.final()]).toString('utf8'));
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

test('through the server: a phone publishes a signed preview key, the sender seals to it, and only that phone\'s push carries the preview', async () => {
  const a = await register('prva');
  const b = await register('prvb');
  await api('/api/v1/contacts', { session: a, method: 'POST', body: { userId: b.user.id } });
  await api('/api/v1/contacts', { session: b, method: 'POST', body: { userId: a.user.id } });

  // The phone's key pair (PreviewKey.java on a real phone) and its push registration.
  const phone = createECDH('prime256v1');
  phone.generateKeys();
  const previewKey = phone.getPublicKey().toString('base64');
  const pushKey = randomBytes(32).toString('base64');
  const token = `fcm-${randomBytes(12).toString('hex')}`;
  assert.ok((await api('/api/v1/push/devices', { session: b, method: 'POST', body: { token, key: pushKey, platform: 'android' } })).status < 300);

  // Unsigned, or signed by someone else: refused.
  assert.equal((await api('/api/v1/e2e/preview-key', { session: b, method: 'PUT', body: { key: previewKey, signature: 'x' } })).status, 400);
  assert.equal((await api('/api/v1/e2e/preview-key', { session: b, method: 'PUT', body: { key: previewKey, signature: await a.protocol.signPreviewKey(previewKey) } })).status, 400);
  assert.equal((await api('/api/v1/e2e/preview-key', { method: 'PUT', body: { key: previewKey, signature: await b.protocol.signPreviewKey(previewKey) } })).status, 401);
  assert.equal((await api('/api/v1/e2e/preview-key', { session: b, method: 'PUT', body: { key: previewKey, signature: await b.protocol.signPreviewKey(previewKey) } })).status, 204);

  // The sender sees it in the device list and checks the signature itself.
  const devices = (await api(`/api/v1/e2e/users/${b.user.id}/devices`, { session: a })).body.devices;
  assert.equal(devices.length, 1);
  assert.equal(devices[0].preview.key, previewKey);
  assert.equal(await validPreviewKey(devices[0].identity.sig, devices[0].preview), true);
  assert.equal((await api(`/api/v1/e2e/users/${a.user.id}/devices`, { session: b })).body.devices[0].preview, undefined, 'a device without one lists none');

  // A sealed message with a preview for that phone (and a bogus entry for a device that is not the receiver's).
  const claim = async (userId, deviceIds) => (await api(`/api/v1/e2e/users/${userId}/bundles`, { session: a, method: 'POST', body: { deviceIds } })).body.bundles;
  const d = await a.protocol.encryptForDevices({ [b.user.id]: devices }, JSON.stringify({ c: 'the full message' }), { claimBundles: claim });
  const pv = { [devices[0].deviceId]: await sealPreview(previewKey, 'the full message', a.user.id), 'someone-else': 'QUJD' };
  const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/ws', [`relay.auth.${a.token}`, 'relay.v1', 'relay.client.3']);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.send(JSON.stringify({ type: 'message:send', message: { id: 'preview-1', receiverId: b.user.id, content: buildEnvelope(routingFor('the full message'), { sd: a.deviceId, d, pv }) } }));
  const push = await until(() => sent.find((item) => item.token === token && decryptPush(pushKey, item.data).id === 'preview-1'), 'the push');
  const body = decryptPush(pushKey, push.data);
  assert.equal(body.t, 'msg');
  assert.equal(body.pvs, undefined, 'never the whole map');
  assert.deepEqual(openLikeThePhone(body.pv, phone, a.user.id).t, 'the full message');

  // A message without a preview: the push is as before.
  const d2 = await a.protocol.encryptForDevices({ [b.user.id]: devices }, JSON.stringify({ c: 'no preview' }), { claimBundles: claim });
  socket.send(JSON.stringify({ type: 'message:send', message: { id: 'preview-2', receiverId: b.user.id, content: buildEnvelope(routingFor('no preview'), { sd: a.deviceId, d: d2 }) } }));
  const plain = decryptPush(pushKey, (await until(() => sent.find((item) => item.token === token && decryptPush(pushKey, item.data).id === 'preview-2'), 'the second push')).data);
  assert.deepEqual(plain, { t: 'msg', pid: 'm:preview-2', id: 'preview-2', from: a.user.id });
  socket.close();
});

test('the phone shows a sealed preview under the same rules as "New message", and the app\'s later notification for that message is a no-op', () => {
  const java = (name) => readFileSync(new URL(`../android/app/src/main/java/io/github/bickworld555/hiddenchat/${name}.java`, import.meta.url), 'utf8');
  const push = java('PushService');
  const show = push.slice(push.indexOf('static boolean showPreview('));
  assert.match(show, /if \(AppActivity\.isVisible\(\)\) return false;/);
  assert.match(show, /name\.isEmpty\(\) \|\| session\.mutedChats\.contains\(from\) \|\| RelaySession\.lockedChats\(context\)\.contains\(from\)\) return false;/);
  assert.match(show, /String text = PreviewKey\.open\(context, sealed, from\);\s+if \(text == null\) return false;/);
  assert.match(show, /Alerts\.showMessage\([^;]+, name, text, tag, tag, 0, messageId,/, 'under the message id: once per message');
  assert.match(push, /if \(!groupId\.isEmpty\(\) \|\| !showPreview\(context, session, from, body\.optString\("id"\), body\.optString\("pv"\)\)\) announceArriving\(/, 'no preview: "New message" as before');
  const key = java('PreviewKey');
  assert.match(key, /cipher\.updateAAD\(senderId\.getBytes\(StandardCharsets\.UTF_8\)\);/);
  assert.match(key, /Math\.abs\(now - at\) > MAX_AGE_MS\) return null;/, 'an old preview replayed later is not shown');
  assert.match(key, /EncryptedSharedPreferences\.create\(app, PREFS, master,/, 'the private key rests encrypted by the Android Keystore');
  const messaging = readFileSync(new URL('../src/e2e/messaging.js', import.meta.url), 'utf8');
  assert.match(messaging, /preview: plainText\(notificationPreview\(message\.content\)\)/);
  assert.ok(!/sealDirect\(peerId, REACTION_PREFIX \+ emoji,/.test(messaging), 'reactions carry no preview');
});
