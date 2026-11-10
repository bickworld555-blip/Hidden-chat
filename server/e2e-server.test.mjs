// End-to-end encryption through the real server: devices publish keys, claim each other's bundles over HTTP,
// send sealed direct and group messages over the real socket and routes, and the server stores and relays only
// ciphertext while enforcing that every device is addressed.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';
import { createChatServer } from './index.mjs';
import { createProtocol } from '../src/e2e/protocol.js';
import { buildEnvelope, parseEnvelope, routingFor, withRoutedMedia } from '../src/e2e/envelope.js';
import { sha256Hex } from '../src/e2e/primitives.js';

const PASSWORD = 'correct horse battery staple';
let directory;
let service;
let baseUrl;
let counter = 0;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-e2e-'));
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), pushSender: null });
  baseUrl = `http://127.0.0.1:${(await service.listen()).port}`;
});
after(async () => {
  await service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function api(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function connect(token) {
  const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/ws', [`relay.auth.${token}`, 'relay.v1']);
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

function memoryStorage() {
  const map = new Map();
  return { get: async (key) => map.get(key), set: async (key, value) => { map.set(key, value); }, del: async (key) => { map.delete(key); } };
}

// A device: a session (its own device id) plus its own protocol state, publishing keys like the app does.
async function device(session) {
  const protocol = createProtocol({ storage: memoryStorage() });
  const status = (await api('/api/v1/e2e/keys', { token: session.token })).body;
  assert.equal(status.published, false);
  const upload = await protocol.prepareUpload({ serverPreKeyCount: 0 });
  const put = await api('/api/v1/e2e/keys', { token: session.token, method: 'PUT', body: upload });
  assert.equal(put.status, 200);
  assert.deepEqual([put.body.published, put.body.preKeys], [true, 100]);
  const claimBundles = async (userId, deviceIds) => (await api(`/api/v1/e2e/users/${userId}/bundles`, { token: session.token, method: 'POST', body: { deviceIds } })).body.bundles;
  return { ...session, userId: session.user.id, protocol, claimBundles, me: { userId: session.user.id, deviceId: session.deviceId } };
}

async function account(prefix) {
  counter += 1;
  const username = `${prefix}${counter}`;
  const registered = (await api('/api/v1/auth/register', { method: 'POST', body: { username, dob: '1990-04-12', password: PASSWORD } })).body;
  return { username, first: registered };
}

const login = async (username) => (await api('/api/v1/auth/login', { method: 'POST', body: { identity: username, password: PASSWORD } })).body;

async function devicesOf(viewer, userId) {
  return (await api(`/api/v1/e2e/users/${userId}/devices`, { token: viewer.token })).body.devices;
}

async function sealDirect(from, peerId, content) {
  const targets = { [peerId]: await devicesOf(from, peerId) };
  const mine = (await devicesOf(from, from.userId)).filter((item) => item.deviceId !== from.deviceId);
  if (mine.length) targets[from.userId] = mine;
  const d = await from.protocol.encryptForDevices(targets, JSON.stringify({ c: content }), { claimBundles: from.claimBundles });
  return buildEnvelope(routingFor(content), { sd: from.deviceId, d });
}

async function openDirect(at, senderId, envelope) {
  const parsed = parseEnvelope(envelope);
  const plaintext = await at.protocol.decryptFromDevice(senderId, parsed.body.sd, parsed.body.d?.[at.userId]?.[at.deviceId]);
  return withRoutedMedia(JSON.parse(plaintext).c, parsed.route);
}

test('direct messages: sealed per device over the socket, server holds only ciphertext, stale device lists are refused', async () => {
  const alice = await account('e2ea');
  const bob = await account('e2eb');
  await api('/api/v1/contacts', { token: alice.first.token, method: 'POST', body: { userId: bob.first.user.id } });
  const a1 = await device(alice.first);
  const a2 = await device(await login(alice.username));
  const b1 = await device(bob.first);
  assert.deepEqual((await devicesOf(b1, a1.userId)).map((item) => item.deviceId).sort(), [a1.deviceId, a2.deviceId].sort());

  const [s1, s2, s3] = await Promise.all([connect(a1.token), connect(a2.token), connect(b1.token)]);
  await until(() => [s1, s2, s3].every((socket) => socket.events.some((event) => event.type === 'connection:ready')), 'ready');

  const secret = 'meet at the old bridge at nine';
  const envelope = await sealDirect(a1, b1.userId, secret);
  assert.ok(!envelope.includes(secret) && !envelope.includes('bridge'));
  s1.send(JSON.stringify({ type: 'message:send', message: { id: 'e2e-m1', receiverId: b1.userId, content: envelope } }));
  const received = await until(() => s3.events.find((event) => event.type === 'message:new' && event.message.id === 'e2e-m1'), 'Bob receives');
  assert.equal(await openDirect(b1, a1.userId, received.message.content), secret);
  const mirrored = await until(() => s2.events.find((event) => event.message?.id === 'e2e-m1'), 'Alice’s other device receives');
  assert.equal(await openDirect(a2, a1.userId, mirrored.message.content), secret, 'the sender’s other device reads its own sent message');

  const history = (await api(`/api/v1/messages?peerId=${a1.userId}`, { token: b1.token })).body;
  const stored = history.find((message) => message.id === 'e2e-m1');
  assert.ok(stored.content.startsWith('e2e2:text|') && !stored.content.includes(secret), 'history is ciphertext');

  // Bob replies; Alice's first device reads it (the session works both ways).
  const reply = await sealDirect(b1, a1.userId, 'see you there');
  s3.send(JSON.stringify({ type: 'message:send', message: { id: 'e2e-m2', receiverId: a1.userId, content: reply } }));
  const back = await until(() => s1.events.find((event) => event.type === 'message:new' && event.message.id === 'e2e-m2'), 'Alice receives');
  assert.equal(await openDirect(a1, b1.userId, back.message.content), 'see you there');

  // A message that leaves out a device (Alice's second) is refused with the current list, and nothing is stored.
  const partial = await a1.protocol.encryptForDevices({ [b1.userId]: await devicesOf(a1, b1.userId) }, JSON.stringify({ c: 'x' }), { claimBundles: a1.claimBundles });
  s1.send(JSON.stringify({ type: 'message:send', message: { id: 'e2e-m3', receiverId: b1.userId, content: buildEnvelope('text', { sd: a1.deviceId, d: partial }) } }));
  const rejected = await until(() => s1.events.find((event) => event.type === 'message:rejected' && event.messageId === 'e2e-m3'), 'refused');
  assert.equal(rejected.code, 'e2e-devices');
  assert.deepEqual(rejected.devices[a1.userId].map((item) => item.deviceId), [a2.deviceId]);
  assert.equal((await api(`/api/v1/messages?peerId=${b1.userId}`, { token: a1.token })).body.some((message) => message.id === 'e2e-m3'), false);
  // An envelope claiming to come from another device is refused too.
  s1.send(JSON.stringify({ type: 'message:send', message: { id: 'e2e-m4', receiverId: b1.userId, content: buildEnvelope('text', { sd: a2.deviceId, d: partial }) } }));
  await until(() => s1.events.find((event) => event.type === 'message:rejected' && event.messageId === 'e2e-m4'), 'wrong device refused');

  // Edits are sealed like new messages and carry the sender, so every device can open them.
  const edit = await sealDirect(a1, b1.userId, 'meet at the new bridge at ten');
  const put = await api('/api/v1/messages/e2e-m1', { token: a1.token, method: 'PUT', body: { content: edit } });
  assert.equal(put.status, 200);
  const edited = await until(() => s3.events.find((event) => event.type === 'message:edited' && event.messageId === 'e2e-m1'), 'edit relayed');
  assert.equal(edited.senderId, a1.userId);
  assert.equal(await openDirect(b1, a1.userId, edited.content), 'meet at the new bridge at ten');
  const notText = await sealDirect(a1, b1.userId, 'location:{"lat":1,"lng":2}');
  assert.equal((await api('/api/v1/messages/e2e-m1', { token: a1.token, method: 'PUT', body: { content: notText } })).status, 400, 'only text stays editable');

  // Signing a device out removes its keys: it is no longer addressed.
  await api('/api/v1/auth/logout', { token: a2.token, method: 'POST' });
  assert.deepEqual((await devicesOf(b1, a1.userId)).map((item) => item.deviceId), [a1.deviceId]);
  for (const socket of [s1, s2, s3]) socket.close();
});

test('key directory: validates uploads, hands out each one-time prekey once, replaces a reset identity', async () => {
  const carol = await account('e2ec');
  const dave = await account('e2ed');
  const c1 = await device(carol.first);
  assert.equal((await api('/api/v1/e2e/keys', { token: c1.token, method: 'PUT', body: { identity: { dh: 'x', sig: 'y' } } })).status, 400);
  const claim = () => api(`/api/v1/e2e/users/${c1.userId}/bundles`, { token: dave.first.token, method: 'POST', body: { deviceIds: [c1.deviceId] } });
  const first = (await claim()).body.bundles[0];
  const second = (await claim()).body.bundles[0];
  assert.ok(first.preKey && second.preKey && first.preKey.id !== second.preKey.id, 'each one-time prekey once');
  assert.equal((await api('/api/v1/e2e/keys', { token: c1.token })).body.preKeys, 98);
  assert.equal((await api(`/api/v1/e2e/users/${c1.userId}/bundles`, { token: dave.first.token, method: 'POST', body: { deviceIds: [] } })).status, 400);
  // The device's local keys were wiped (app data cleared): its new identity replaces the old one and its prekeys.
  const fresh = createProtocol({ storage: memoryStorage() });
  const upload = await fresh.prepareUpload({ serverPreKeyCount: 0 });
  assert.equal((await api('/api/v1/e2e/keys', { token: c1.token, method: 'PUT', body: upload })).status, 200);
  const listed = await devicesOf({ token: dave.first.token }, c1.userId);
  assert.deepEqual(listed[0].identity, upload.identity);
});

test('group messages: one Sender Key ciphertext for all, key distributions per device, device-set changes are refused', async () => {
  const erin = await account('e2ee');
  const frank = await account('e2ef');
  const e1 = await device(erin.first);
  const f1 = await device(frank.first);
  const group = (await api('/api/v1/groups', { token: e1.token, method: 'POST', body: { name: 'Sealed', memberIds: [f1.userId] } })).body;
  const groupDevices = async (viewer) => (await api(`/api/v1/e2e/groups/${group.id}/devices`, { token: viewer.token })).body;
  const listing = await groupDevices(e1);
  assert.deepEqual(listing.members.sort(), [e1.userId, f1.userId].sort());
  const memberDevices = Object.fromEntries(Object.entries(listing.devices).map(([userId, list]) => [userId, list.map((item) => item.deviceId)]));
  const seal = async (content, members = memberDevices) => {
    const sealed = await e1.protocol.encryptGroup(group.id, e1.me, members, JSON.stringify({ c: content }), { claimBundles: e1.claimBundles, digest: (text) => sha256Hex(text) });
    return { envelope: buildEnvelope(routingFor(content), { sd: e1.deviceId, ...sealed.body }), keyId: sealed.keyId };
  };

  const first = await seal('group secret one');
  const posted = await api(`/api/v1/groups/${group.id}/messages`, { token: e1.token, method: 'POST', body: { content: first.envelope } });
  assert.equal(posted.status, 201);
  assert.ok(!posted.body.content.includes('group secret'));
  await e1.protocol.confirmGroupSend(group.id, first.keyId);
  const second = await seal('group secret two');
  assert.equal(parseEnvelope(second.envelope).body.x, undefined, 'after the key is delivered, one ciphertext for everyone');
  assert.equal((await api(`/api/v1/groups/${group.id}/messages`, { token: e1.token, method: 'POST', body: { content: second.envelope } })).status, 201);

  const history = (await api(`/api/v1/groups/${group.id}/messages`, { token: f1.token })).body;
  const read = [];
  for (const message of history) {
    const parsed = parseEnvelope(message.content);
    read.push(JSON.parse(await f1.protocol.decryptGroup(group.id, f1.me, message.senderId, parsed.body.sd, parsed.body)).c);
  }
  assert.deepEqual(read, ['group secret one', 'group secret two']);

  // Frank adds a device: Erin's next message, still keyed to the old device set, is refused with the new list.
  const f2 = await device(await login(frank.username));
  const stale = await seal('who is new?');
  const refused = await api(`/api/v1/groups/${group.id}/messages`, { token: e1.token, method: 'POST', body: { content: stale.envelope } });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'e2e-devices');
  assert.deepEqual(refused.body.devices[f1.userId].map((item) => item.deviceId).sort(), [f1.deviceId, f2.deviceId].sort());
  const updated = Object.fromEntries(Object.entries(refused.body.devices).map(([userId, list]) => [userId, list.map((item) => item.deviceId)]));
  const rotated = await seal('welcome, new device', updated);
  assert.ok(parseEnvelope(rotated.envelope).body.x[f1.userId][f2.deviceId], 'the new device gets the new sender key');
  assert.equal((await api(`/api/v1/groups/${group.id}/messages`, { token: e1.token, method: 'POST', body: { content: rotated.envelope } })).status, 201);
  const latest = (await api(`/api/v1/groups/${group.id}/messages`, { token: f2.token })).body.at(-1);
  const parsed = parseEnvelope(latest.content);
  assert.equal(JSON.parse(await f2.protocol.decryptGroup(group.id, f2.me, e1.userId, parsed.body.sd, parsed.body)).c, 'welcome, new device');
});

test('encrypted attachments: routing names the upload, forwards are re-pointed to the copy', async () => {
  const gina = await account('e2eg');
  const hal = await account('e2eh');
  const g1 = await device(gina.first);
  const h1 = await device(hal.first);
  const upload = await fetch(`${baseUrl}/api/v1/media?receiverId=${h1.userId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${g1.token}`, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'encrypted.bin' },
    body: new Uint8Array([1, 2, 3, 4]),
  }).then((response) => response.json());
  const content = `emedia:${upload.id}:eyJ2IjoxfQ:holiday.jpg`;
  const envelope = await sealDirect(g1, h1.userId, content);
  assert.ok(envelope.startsWith(`e2e2:media:${upload.id}|`) && !envelope.includes('holiday'), 'the server sees which upload, not its name');
  const socket = await connect(g1.token);
  await until(() => socket.events.some((event) => event.type === 'connection:ready'), 'ready');
  socket.send(JSON.stringify({ type: 'message:send', message: { id: 'e2e-media-1', receiverId: h1.userId, content: envelope } }));
  await until(() => socket.events.some((event) => event.type === 'message:ack' && event.message.id === 'e2e-media-1'), 'stored');
  // Hal forwards it back to Gina: the server copies the upload and re-points the routing to the copy.
  const forward = await sealDirect(h1, g1.userId, content);
  const hs = await connect(h1.token);
  await until(() => hs.events.some((event) => event.type === 'connection:ready'), 'ready');
  hs.send(JSON.stringify({ type: 'message:send', message: { id: 'e2e-media-2', receiverId: g1.userId, content: forward, forwarded: true } }));
  const forwarded = await until(() => socket.events.find((event) => event.type === 'message:new' && event.message.id === 'e2e-media-2'), 'forward arrives');
  const copyId = parseEnvelope(forwarded.message.content).route.mediaId;
  assert.notEqual(copyId, upload.id, 'a forward gets its own copy');
  assert.equal(await openDirect(g1, h1.userId, forwarded.message.content), `emedia:${copyId}:eyJ2IjoxfQ:holiday.jpg`, 'the opened message points at the copy');
  socket.close();
  hs.close();
});
