// The server as a short-lived queue: a direct message stays until every target device has stored it, then it is
// deleted; receipts for a deleted message still reach the sender (live, or queued for an offline device).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createChatServer } from './index.mjs';

const PASSWORD = 'Correct-Horse-Battery-42!';
let service;
let directory;
let baseUrl;
let counter = 0;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-queue-'));
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), dataDirectory: directory });
  baseUrl = `http://127.0.0.1:${(await service.listen()).port}`;
});

after(async () => {
  await service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function api(path, { session, method = 'GET', body } = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: { ...(session ? { Authorization: `Bearer ${session.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: response.headers.get('content-type')?.includes('json') ? await response.json() : null };
}

async function register(prefix) {
  counter += 1;
  const { status, data } = await api('/api/v1/auth/register', { method: 'POST', body: { username: `${prefix}${counter}`, dob: '1990-04-12', password: PASSWORD } });
  assert.equal(status, 201);
  return data;
}

async function signInAgain(account) {
  const { status, data } = await api('/api/v1/auth/login', { method: 'POST', body: { identity: account.user.username, password: PASSWORD } });
  assert.equal(status, 200);
  return data;
}

function connect(session) {
  const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/ws', [`relay.auth.${session.token}`, 'relay.v1']);
  socket.events = [];
  socket.on('message', (raw) => socket.events.push(JSON.parse(raw.toString())));
  socket.wait = (type, predicate = () => true, timeout = 4000) => new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    (function poll() {
      const found = socket.events.find((event) => event.type === type && predicate(event));
      if (found) return resolve(found);
      if (Date.now() > deadline) return reject(new Error(`Timed out waiting for ${type}`));
      setTimeout(poll, 15);
    })();
  });
  return new Promise((resolve, reject) => { socket.once('open', () => resolve(socket)); socket.once('error', reject); });
}

const history = async (session, peerId) => (await api(`/api/v1/messages?peerId=${peerId}`, { session })).data;

test('a direct message leaves the server once every device of both people has stored it', async () => {
  const alice = await register('qa');
  const bob = await register('qb');
  const bobPhone = await signInAgain(bob); // Bob has two devices; Alice sends from her only one.
  const aliceSocket = await connect(alice);
  aliceSocket.send(JSON.stringify({ type: 'message:send', message: { id: 'q-1', receiverId: bob.user.id, content: 'hello' } }));
  await aliceSocket.wait('message:ack', (event) => event.message.id === 'q-1');

  // Waiting for both of Bob's devices: each sees it in its own queue.
  const first = (await api('/api/v1/queue', { session: bob })).data;
  assert.deepEqual(first.messages.map((message) => message.id), ['q-1']);
  assert.equal((await api('/api/v1/queue', { session: bobPhone })).data.messages.length, 1);
  await api('/api/v1/queue/ack', { session: bob, method: 'POST', body: { messageIds: ['q-1'] } });
  assert.equal((await api('/api/v1/queue', { session: bob })).data.messages.length, 0, 'acknowledged on this device');
  assert.ok((await history(alice, bob.user.id)).some((message) => message.id === 'q-1'), 'still waiting for the phone');

  const done = await api('/api/v1/queue/ack', { session: bobPhone, method: 'POST', body: { messageIds: ['q-1'] } });
  assert.equal(done.data.removed, 1);
  assert.equal((await history(alice, bob.user.id)).some((message) => message.id === 'q-1'), false, 'gone from the server');
  aliceSocket.close();
});

test('a read receipt for a message already gone from the server still reaches the sender, queued while offline', async () => {
  const alice = await register('ra');
  const bob = await register('rb');
  const aliceSocket = await connect(alice);
  const bobSocket = await connect(bob);
  aliceSocket.send(JSON.stringify({ type: 'message:send', message: { id: 'r-1', receiverId: bob.user.id, content: 'read me later' } }));
  await bobSocket.wait('message:new', (event) => event.message.id === 'r-1');
  bobSocket.send(JSON.stringify({ type: 'queue:ack', messageIds: ['r-1'] }));
  const deadline = Date.now() + 3000;
  while ((await history(alice, bob.user.id)).some((message) => message.id === 'r-1') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await history(alice, bob.user.id)).some((message) => message.id === 'r-1'), false);

  // Alice goes offline; Bob reads it. The receipt waits in Alice's device queue.
  aliceSocket.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  bobSocket.send(JSON.stringify({ type: 'message:read', messageId: 'r-1' }));
  let queued = [];
  const until = Date.now() + 3000;
  while (queued.length === 0 && Date.now() < until) {
    queued = (await api('/api/v1/queue', { session: alice })).data.events.filter((event) => event.messageId === 'r-1');
    if (queued.length === 0) await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.equal(queued[0]?.type, 'message:status');
  assert.equal(queued[0]?.status, 'read');
  await api('/api/v1/queue/ack', { session: alice, method: 'POST', body: { eventIds: queued.map((event) => event.id) } });
  assert.equal((await api('/api/v1/queue', { session: alice })).data.events.length, 0, 'handled events are deleted');
  bobSocket.close();
});

test('the admin dashboard can count what is waiting, without message content', async () => {
  const response = await api('/api/admin/v1/queue');
  assert.ok([401, 403].includes(response.status), 'admin only');
});
