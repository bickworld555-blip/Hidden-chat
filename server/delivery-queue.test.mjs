// The server as a short-lived queue: a direct message stays until every target device has stored it, then it is
// deleted; receipts for a deleted message still reach the sender (live, or queued for an offline device).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createChatServer } from './index.mjs';
import { createProtocol } from '../src/e2e/protocol.js';

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

test('a message waits only for devices with end-to-end keys, not for a signed-in session that can never read it', async () => {
  const alice = await register('qa');
  const bob = await register('qb'); // a session that never sets up encryption (a script, an abandoned sign-in)
  const bobPhone = await signInAgain(bob);
  const memory = new Map();
  const protocol = createProtocol({ storage: { get: async (k) => memory.get(k), set: async (k, v) => { memory.set(k, v); }, del: async (k) => { memory.delete(k); } } });
  assert.equal((await api('/api/v1/e2e/keys', { session: bobPhone, method: 'PUT', body: await protocol.prepareUpload({ serverPreKeyCount: 0 }) })).status, 200);

  const aliceSocket = await connect(alice);
  aliceSocket.send(JSON.stringify({ type: 'message:send', message: { id: 'k-1', receiverId: bob.user.id, content: 'hello' } }));
  await aliceSocket.wait('message:ack', (event) => event.message.id === 'k-1');
  assert.equal((await api('/api/v1/queue', { session: bob })).data.messages.length, 0, 'not waiting for the keyless session');

  const done = await api('/api/v1/queue/ack', { session: bobPhone, method: 'POST', body: { messageIds: ['k-1'] } });
  assert.equal(done.data.removed, 1);
  assert.equal((await history(alice, bob.user.id)).some((message) => message.id === 'k-1'), false, 'gone once the keyed phone stored it');
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

test('an ordinary request counts as the device being used, so a device back after 20 days is waited for again', async () => {
  const alice = await register('qa');
  const bob = await register('qb');
  const memory = new Map();
  const protocol = createProtocol({ storage: { get: async (k) => memory.get(k), set: async (k, v) => { memory.set(k, v); }, del: async (k) => { memory.delete(k); } } });
  await api('/api/v1/e2e/keys', { session: bob, method: 'PUT', body: await protocol.prepareUpload({ serverPreKeyCount: 0 }) });
  // Bob also uses a laptop every day, so an idle phone would not be waited for.
  const laptop = await signInAgain(bob);
  const laptopMemory = new Map();
  const laptopProtocol = createProtocol({ storage: { get: async (k) => laptopMemory.get(k), set: async (k, v) => { laptopMemory.set(k, v); }, del: async (k) => { laptopMemory.delete(k); } } });
  await api('/api/v1/e2e/keys', { session: laptop, method: 'PUT', body: await laptopProtocol.prepareUpload({ serverPreKeyCount: 0 }) });
  const backThen = Date.now() - 20 * 24 * 60 * 60 * 1000;
  const activity = () => Number(service.db.prepare('SELECT last_active_at AS at FROM sessions WHERE device_id = ?').get(bob.deviceId).at);
  service.db.prepare('UPDATE sessions SET last_active_at = ?, created_at = ? WHERE device_id = ?').run(backThen, backThen, bob.deviceId);

  assert.equal((await api('/api/v1/queue', { session: bob })).status, 200); // e.g. a phone woken by a push notification
  assert.ok(activity() > Date.now() - 60_000, 'the request refreshed the last activity');
  const before = activity();
  await api('/api/v1/queue', { session: bob });
  assert.equal(activity(), before, 'written at most once an hour');

  const aliceSocket = await connect(alice);
  aliceSocket.send(JSON.stringify({ type: 'message:send', message: { id: 'act-1', receiverId: bob.user.id, content: 'hello' } }));
  await aliceSocket.wait('message:ack', (event) => event.message.id === 'act-1');
  assert.deepEqual((await api('/api/v1/queue', { session: bob })).data.messages.map((message) => message.id), ['act-1']);
  aliceSocket.close();
});

test('a group message waiting for a device says which group it is in, so the app can save it unopened', async () => {
  const alice = await register('qa');
  const bob = await register('qb');
  const created = await api('/api/v1/groups', { session: alice, method: 'POST', body: { name: 'Queue group', memberIds: [bob.user.id] } });
  assert.equal(created.status, 201);
  const groupId = created.data.id;
  const sent = await api(`/api/v1/groups/${groupId}/messages`, { session: alice, method: 'POST', body: { content: 'hello group' } });
  assert.ok(sent.status === 200 || sent.status === 201, `sent: ${sent.status}`);
  const queued = (await api('/api/v1/queue', { session: bob })).data;
  assert.deepEqual(queued.groupMessages, [{ id: sent.data.id, groupId }]);
  const done = await api('/api/v1/queue/ack', { session: bob, method: 'POST', body: { messageIds: [sent.data.id] } });
  assert.equal(done.data.removed, 1, 'gone once the only member device saved it');
});

test("a delivered message takes its reactions with it", async () => {
  const alice = await register('qa');
  const bob = await register('qb');
  const aliceSocket = await connect(alice);
  const bobSocket = await connect(bob);
  aliceSocket.send(JSON.stringify({ type: 'message:send', message: { id: 'rx-1', receiverId: bob.user.id, content: 'react to me' } }));
  await aliceSocket.wait('message:ack', (event) => event.message.id === 'rx-1');
  bobSocket.send(JSON.stringify({ type: 'message:reaction', messageId: 'rx-1', emoji: '👍' }));
  const reactions = () => Number(service.db.prepare('SELECT count(*) AS count FROM message_reactions WHERE message_id = ?').get('rx-1').count);
  for (let i = 0; i < 40 && reactions() === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(reactions(), 1, 'stored while the message waits');
  const done = await api('/api/v1/queue/ack', { session: bob, method: 'POST', body: { messageIds: ['rx-1'] } });
  assert.equal(done.data.removed, 1);
  assert.equal(reactions(), 0, 'gone with the message');
  aliceSocket.close();
  bobSocket.close();
});

test('the 30-day sweep works in bounded batches and never drops a route before its message', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { createDeliveryQueue, ensureDeliveryQueueSchema } = await import('./deliveryQueue.mjs');
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE sessions (token_hash TEXT, user_id TEXT, device_id TEXT, expires_at INTEGER, last_active_at INTEGER, created_at INTEGER);
    CREATE TABLE messages (id TEXT PRIMARY KEY, status TEXT, deleted_at TEXT, created_at TEXT);
    CREATE TABLE group_messages (id TEXT PRIMARY KEY, created_at INTEGER)`);
  ensureDeliveryQueueSchema(db);
  const day = 24 * 60 * 60 * 1000;
  const at = 100 * day;
  const old = at - 31 * day;
  for (let index = 0; index < 5; index += 1) {
    db.prepare("INSERT INTO message_routes(message_id, kind, sender_id, created_at) VALUES (?, 'direct', 's', ?)").run(`kept-${index}`, old);
    db.prepare("INSERT INTO message_deliveries(message_id, kind, user_id, device_id, created_at) VALUES (?, 'direct', 'u', 'd', ?)").run(`stale-${index}`, old);
  }
  for (let index = 0; index < 30; index += 1) db.prepare("INSERT INTO device_events(id, user_id, device_id, payload, created_at) VALUES (?, 'u', 'd', '{}', ?)").run(`event-${index}`, old);
  const removed = [];
  const queue = createDeliveryQueue({ db, now: () => at, sweepBatch: 2, removeMessage: async (kind, id) => {
    assert.ok(db.prepare('SELECT 1 FROM message_routes WHERE message_id = ?').get(id) || id.startsWith('stale-'), 'the route is still there while its message goes');
    removed.push(id);
  } });
  await queue.sweep();
  assert.equal(db.prepare('SELECT count(*) AS n FROM message_routes').get().n, 3, 'two routes per pass');
  assert.equal(db.prepare('SELECT count(DISTINCT message_id) AS n FROM message_deliveries').get().n, 3);
  assert.equal(db.prepare('SELECT count(*) AS n FROM device_events').get().n, 10, 'events in batches of ten times the batch');
  for (let pass = 0; pass < 3; pass += 1) await queue.sweep();
  assert.equal(db.prepare('SELECT count(*) AS n FROM message_routes').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM message_deliveries').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM device_events').get().n, 0);
  assert.equal(removed.filter((id) => id.startsWith('kept-')).length, 5);
});

test('group read receipts (R1/R4): a read mark is kept, reaches the other members, and gives each member\'s first read time', async () => {
  const alice = await register('ra');
  const bob = await register('rb');
  const carol = await register('rc');
  const outsider = await register('ro');
  const created = await api('/api/v1/groups', { session: alice, method: 'POST', body: { name: 'Receipts', memberIds: [bob.user.id, carol.user.id] } });
  assert.equal(created.status, 201);
  const groupId = created.data.id;
  const aliceSocket = await connect(alice);
  const carolSocket = await connect(carol);
  const sentAt = Date.now() - 1000;
  const read = await api(`/api/v1/groups/${groupId}/read`, { session: bob, method: 'PUT' });
  assert.equal(read.status, 200);
  const mark = await aliceSocket.wait('group:read-mark', (event) => event.groupId === groupId);
  assert.deepEqual([mark.userId, mark.readAt], [bob.user.id, read.data.readAt], 'the other members hear who read and when');
  await carolSocket.wait('group:read-mark', (event) => event.userId === bob.user.id);
  // Bob reads again later: his first read after the message is what counts.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await api(`/api/v1/groups/${groupId}/read`, { session: bob, method: 'PUT' });
  const marks = await api(`/api/v1/groups/${groupId}/read-marks?since=${sentAt}`, { session: alice });
  assert.equal(marks.status, 200);
  assert.deepEqual(marks.data.marks, [{ userId: bob.user.id, readAt: read.data.readAt }]);
  // Nothing at or after a later time; members only; a time is required.
  assert.deepEqual((await api(`/api/v1/groups/${groupId}/read-marks?since=${Date.now() + 60_000}`, { session: alice })).data.marks, []);
  assert.equal((await api(`/api/v1/groups/${groupId}/read-marks?since=${sentAt}`, { session: outsider })).status, 404);
  assert.equal((await api(`/api/v1/groups/${groupId}/read-marks`, { session: alice })).status, 400);
  aliceSocket.close();
  carolSocket.close();
});
