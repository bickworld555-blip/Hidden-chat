// "Waiting for this message. It is end-to-end encrypted." is no longer final: the device that cannot open a message
// asks the device that sealed it (e2e:retry), which seals it again for that device alone, with a fresh session when the
// old one is unusable (message:reseal). Protocol round trips with simulated devices, the request/answer rules, and the
// server relay.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createProtocol } from '../src/e2e/protocol.js';
import { createChatServer } from './index.mjs';

function memoryStorage() {
  const map = new Map();
  return { map, get: async (key) => map.get(key), set: async (key, value) => { map.set(key, value); }, del: async (key) => { map.delete(key); } };
}
function directory() {
  const devices = new Map();
  return {
    async publish(userId, deviceId, upload) {
      const key = `${userId}/${deviceId}`;
      const existing = devices.get(key);
      const current = existing && existing.identity.dh === upload.identity.dh ? existing : { preKeys: [] };
      devices.set(key, { identity: upload.identity, signedPreKey: upload.signedPreKey, preKeys: [...current.preKeys, ...upload.preKeys] });
    },
    claimBundles: async (userId, deviceIds) => deviceIds.map((deviceId) => {
      const entry = devices.get(`${userId}/${deviceId}`);
      if (!entry) return null;
      const preKey = entry.preKeys.shift();
      return { deviceId, identity: entry.identity, signedPreKey: entry.signedPreKey, ...(preKey ? { preKey } : {}) };
    }).filter(Boolean),
  };
}
async function device(dir, userId, deviceId) {
  const storage = memoryStorage();
  const protocol = createProtocol({ storage });
  await dir.publish(userId, deviceId, await protocol.prepareUpload({ serverPreKeyCount: 0 }));
  return { userId, deviceId, protocol, storage };
}
const send = (from, to, text, dir) => from.protocol.encryptForDevices({ [to.userId]: [{ deviceId: to.deviceId }] }, text, { claimBundles: dir.claimBundles })
  .then((map) => map[to.userId][to.deviceId]);
const open = (at, from, entry) => at.protocol.decryptFromDevice(from.userId, from.deviceId, entry);

test('a receiver whose session was lost cannot read the next message; a fresh session from the sender fixes it', async () => {
  const dir = directory();
  const alice = await device(dir, 'alice', 'a1');
  const bob = await device(dir, 'bob', 'b1');
  assert.equal(await open(bob, alice, await send(alice, bob, 'one', dir)), 'one');
  assert.equal(await open(alice, bob, await send(bob, alice, 'two', dir)), 'two');
  // Bob's phone loses its session state (a cleared app, a failed write): Alice's next message cannot be opened.
  for (const key of [...bob.storage.map.keys()]) if (key.startsWith('session:') || key.startsWith('sessions:')) bob.storage.map.delete(key);
  const lost = await send(alice, bob, 'three', dir);
  await assert.rejects(open(bob, alice, lost), (error) => ['no-session', 'decrypt-failed'].includes(error.code));
  // Bob asks; Alice forgets her session with Bob's device and seals the same text again: a new key agreement.
  await alice.protocol.forgetSession('bob', 'b1');
  const resealed = await send(alice, bob, 'three', dir);
  assert.ok(resealed.p, 'the copy starts a fresh session');
  assert.equal(await open(bob, alice, resealed), 'three');
  // And the conversation carries on both ways.
  assert.equal(await open(alice, bob, await send(bob, alice, 'four', dir)), 'four');
  assert.equal(await open(bob, alice, await send(alice, bob, 'five', dir)), 'five');
});

test('a message sealed for another device (a reinstall) is sealed again for the new one', async () => {
  const dir = directory();
  const alice = await device(dir, 'alice', 'a1');
  const oldPhone = await device(dir, 'bob', 'old');
  const original = await send(alice, oldPhone, 'before the reinstall', dir);
  const newPhone = await device(dir, 'bob', 'new');
  await assert.rejects(open(newPhone, alice, undefined), (error) => error.code === 'not-addressed');
  assert.equal(await open(newPhone, alice, await send(alice, newPhone, 'before the reinstall', dir)), 'before the reinstall');
  void original;
});

test('forgetting a session keeps it for anything still in flight from that device', async () => {
  const dir = directory();
  const alice = await device(dir, 'alice', 'a1');
  const bob = await device(dir, 'bob', 'b1');
  await open(bob, alice, await send(alice, bob, 'hi', dir));
  const late = await send(bob, alice, 'sent before the reset', dir);
  await alice.protocol.forgetSession('bob', 'b1');
  assert.equal(await open(alice, bob, late), 'sent before the reset', 'the previous session still opens it');
});

// --- The request and the answer ------------------------------------------------------------------------------------

test('requests: only for a message that names its sealing device; a few tries, spaced, and a limit a minute', async () => {
  const { requestResend, RETRY_PER_MINUTE, RETRY_SPACING_MS, RETRY_TRIES } = await import('../src/e2e/messaging.js');
  const sent = [];
  const client = { send: (event) => { sent.push(event); return true; } };
  const waiting = (id, extra = {}) => ({ id, senderId: 'peer', receiverId: 'me', e2eError: 'decrypt-failed', sealedBy: 'p1', ...extra });
  let now = 1_000_000_000;
  assert.equal(requestResend(client, waiting('m1'), { me: 'me', now }), true);
  assert.deepEqual(sent[0], { type: 'e2e:retry', messageId: 'm1', userId: 'peer', senderDeviceId: 'p1', error: 'decrypt-failed', peerId: null });
  assert.equal(requestResend(client, waiting('m1'), { me: 'me', now: now + 1000 }), false, 'not again at once');
  for (let i = 1; i < RETRY_TRIES; i += 1) assert.equal(requestResend(client, waiting('m1'), { me: 'me', now: (now += RETRY_SPACING_MS + 61_000) }), true);
  assert.equal(requestResend(client, waiting('m1'), { me: 'me', now: (now += RETRY_SPACING_MS + 61_000) }), false, 'then it stops');
  assert.equal(requestResend(client, waiting('m2', { sealedBy: undefined }), { me: 'me', now }), false, 'unknown sealing device');
  assert.equal(requestResend(client, { id: 'm3', senderId: 'peer', content: 'fine' }, { me: 'me', now }), false, 'readable');
  now += 120_000;
  let accepted = 0;
  for (let i = 0; i < RETRY_PER_MINUTE + 10; i += 1) if (requestResend(client, waiting(`burst-${i}`), { me: 'me', now })) accepted += 1;
  assert.equal(accepted, RETRY_PER_MINUTE);
  // My own message from my other device: the request goes to my account, naming the chat.
  sent.length = 0;
  requestResend(client, waiting('mine', { senderId: 'me', receiverId: 'peer' }), { me: 'me', now: now + 61_000 });
  assert.deepEqual([sent[0].userId, sent[0].peerId], ['me', 'peer']);
});

test('answers: only the sealing device, only its own sent and readable message, only to its recipient; a few times', async () => {
  const source = readFileSync(new URL('../src/e2e/messaging.js', import.meta.url), 'utf8');
  assert.ok(source.includes('if (deviceId && event.senderDeviceId && event.senderDeviceId !== deviceId) return false;'), 'another of my devices sealed it');
  assert.ok(source.includes('if (!message || message.senderId !== me || message.e2eError || message.deleted'), 'my own, readable, not deleted');
  assert.ok(source.includes('if (event.fromUserId !== message.receiverId && event.fromUserId !== me) return false;'), 'only the recipient or my own devices');
  assert.ok(source.includes('if (times >= RETRY_TRIES) return false;'));
  const client = readFileSync(new URL('../src/e2e/client.js', import.meta.url), 'utf8');
  assert.ok(client.includes("export const RESET_SESSION_ERRORS = new Set(['no-session', 'decrypt-failed', 'stale-prekey']);"));
  assert.ok(client.includes('if (RESET_SESSION_ERRORS.has(error)) await session.protocol.forgetSession(userId, deviceId);'));
  assert.ok(client.includes('...(opened.e2eError && sealingDevice(message.content) ? { sealedBy: sealingDevice(message.content) } : {}),'), 'an unreadable copy remembers who sealed it');
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.ok(app.includes('if (event.message.e2eError) requestResend(realtime, event.message);'), 'asked as soon as it arrives');
  assert.ok(app.includes("if (event.type === 'message:resealed') { applyResealed(event).catch(() => {}); return; }"));
  assert.ok(app.includes('setTimeout(askForWaiting, 5000);'), 'and for history after each connect');
});

// --- The server relays both, live, to the right device only ------------------------------------------------------

let service;
let directoryPath;
let baseUrl;
let counter = 0;
const PASSWORD = 'Correct-Horse-Battery-42!';
before(async () => {
  directoryPath = mkdtempSync(join(tmpdir(), 'relay-retry-'));
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directoryPath, 'db.sqlite'), pushSender: null });
  baseUrl = `http://127.0.0.1:${(await service.listen()).port}`;
});
after(async () => {
  await service?.close();
  if (directoryPath) rmSync(directoryPath, { recursive: true, force: true });
});
async function api(path, { session, method = 'GET', body } = {}) {
  const response = await fetch(baseUrl + path, { method, headers: { ...(session ? { Authorization: `Bearer ${session.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
async function register(prefix) {
  counter += 1;
  const { status, body } = await api('/api/v1/auth/register', { method: 'POST', body: { username: `${prefix}${counter}`, dob: '1990-04-12', password: PASSWORD } });
  assert.equal(status, 201);
  return body;
}
async function login(user) {
  const { status, body } = await api('/api/v1/auth/login', { method: 'POST', body: { identity: user.user.username, password: PASSWORD } });
  assert.equal(status, 200);
  return body;
}
function connect(session) {
  const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/ws', [`relay.auth.${session.token}`, 'relay.v1']);
  socket.events = [];
  socket.on('message', (raw) => socket.events.push(JSON.parse(raw.toString())));
  return new Promise((resolve, reject) => { socket.once('open', () => resolve(socket)); socket.once('error', reject); });
}
const until = async (check, label) => { for (let i = 0; i < 100; i += 1) { const value = check(); if (value) return value; await new Promise((r) => setTimeout(r, 30)); } throw new Error(`timeout: ${label}`); };

test('server: the request reaches the sender, the copy reaches only the asking device, never across a block', async () => {
  const alice = await register('alice');
  const bobPhone = await register('bob');
  const bobLaptop = await login(bobPhone);
  const [a, phone, laptop] = await Promise.all([connect(alice), connect(bobPhone), connect(bobLaptop)]);
  await new Promise((r) => setTimeout(r, 200));
  phone.send(JSON.stringify({ type: 'e2e:retry', messageId: 'm1', userId: alice.user.id, senderDeviceId: 'a-dev', error: 'decrypt-failed' }));
  const asked = await until(() => a.events.find((event) => event.type === 'e2e:retry'), 'request');
  assert.deepEqual([asked.messageId, asked.fromUserId, asked.senderDeviceId, asked.error], ['m1', bobPhone.user.id, 'a-dev', 'decrypt-failed']);
  assert.equal(typeof asked.fromDeviceId, 'string');
  const envelope = `e2e2:text|${JSON.stringify({ v: 2, sd: 'a-dev', d: {} })}`;
  a.send(JSON.stringify({ type: 'message:reseal', messageId: 'm1', toUserId: bobPhone.user.id, toDeviceId: asked.fromDeviceId, content: envelope }));
  const copy = await until(() => phone.events.find((event) => event.type === 'message:resealed'), 'copy');
  assert.deepEqual([copy.messageId, copy.senderId, copy.content], ['m1', alice.user.id, envelope]);
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(!laptop.events.some((event) => event.type === 'message:resealed'), 'only the device that asked');
  a.send(JSON.stringify({ type: 'message:reseal', messageId: 'm2', toUserId: bobPhone.user.id, toDeviceId: asked.fromDeviceId, content: 'plain text' }));
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(!phone.events.some((event) => event.messageId === 'm2'), 'only ciphertext');
  // Bob blocks Alice: nothing passes either way.
  assert.equal((await api(`/api/v1/blocks/${alice.user.id}`, { session: bobPhone, method: 'PUT' })).status, 204);
  phone.send(JSON.stringify({ type: 'e2e:retry', messageId: 'm3', userId: alice.user.id }));
  a.send(JSON.stringify({ type: 'message:reseal', messageId: 'm4', toUserId: bobPhone.user.id, toDeviceId: asked.fromDeviceId, content: envelope }));
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!a.events.some((event) => event.messageId === 'm3'));
  assert.ok(!phone.events.some((event) => event.messageId === 'm4'));
  for (const socket of [a, phone, laptop]) socket.close();
});
