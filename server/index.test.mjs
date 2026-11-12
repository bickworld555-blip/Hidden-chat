import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { createChatServer, heartbeatIntervalForState, isAllowedAppOrigin } from './index.mjs';
import { mergeMessageStatus } from '../src/messageStatus.js';
import { formatChatListTime, formatMessageDate, formatMessageTime, localDateKey } from '../src/time.js';
import { checkGroupAttachments, checkGroupContract } from './group-contract.mjs';

let service;
let directory;
let baseUrl;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-chat-test-'));
  service = createChatServer({ port: 0, databasePath: join(directory, 'test.sqlite'), dataDirectory: directory });
  const address = await service.listen();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function createSession(username) {
  const response = await fetch(`${baseUrl}/api/v1/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, dob: '1990-04-12', password: 'Correct-Horse-Battery-42!' }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

const jsonApi = async (path, { session, method = 'GET', body } = {}) => {
  const response = await fetch(baseUrl + path, {
    method,
    headers: { ...(session ? { Authorization: 'Bearer ' + session.token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: response.status === 204 ? null : await response.json() };
};

test('group text messages enforce membership, deletion windows and per-member expiration', async () => {
  await checkGroupContract({ api: jsonApi, register: createSession, service });
});

test('group attachments are member-scoped and purged only with their last referencing message', async () => {
  await checkGroupAttachments({ api: jsonApi, register: createSession, service, url: baseUrl, mediaDirectory: join(directory, 'media') });
});

test('an existing SQLite database gains group attachment columns without losing attachments', async () => {
  await service.close();
  const legacyPath = join(directory, 'legacy.sqlite');
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec(`CREATE TABLE media (id TEXT PRIMARY KEY, sender_id TEXT NOT NULL, receiver_id TEXT NOT NULL, filename TEXT NOT NULL,
    content_type TEXT NOT NULL, byte_size INTEGER NOT NULL, disk_name TEXT NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO media VALUES ('old', 'a', 'b', 'old.bin', 'application/octet-stream', 3, 'old.blob', 1);`);
  legacy.close();
  service = createChatServer({ port: 0, databasePath: legacyPath, dataDirectory: directory });
  await service.listen();
  const columns = service.db.prepare('PRAGMA table_info(media)').all();
  assert.equal(columns.find((column) => column.name === 'receiver_id').notnull, 0);
  assert.ok(columns.some((column) => column.name === 'group_id'));
  assert.deepEqual(JSON.parse(JSON.stringify(service.db.prepare('SELECT id, receiver_id AS r, group_id AS g, disk_name AS d FROM media').all())), [{ id: 'old', r: 'b', g: null, d: 'old.blob' }]);
  assert.throws(() => service.db.prepare("INSERT INTO media(id, sender_id, receiver_id, group_id, filename, content_type, byte_size, disk_name, created_at) VALUES ('x', 'a', NULL, NULL, 'f', 't', 1, 'x.blob', 1)").run(), /CHECK/);
});

test('people who only share a group may signal calls and invites to each other', async (t) => {
  const admin = await createSession('call_group_admin');
  const member = await createSession('call_group_member');
  const outsider = await createSession('call_group_outsider');
  await jsonApi('/api/v1/groups', { session: admin, method: 'POST', body: { name: 'Callers', memberIds: [member.user.id] } });
  const adminSocket = await connect(admin.token);
  const memberSocket = await connect(member.token);
  const outsiderSocket = await connect(outsider.token);
  t.after(() => { adminSocket.close(); memberSocket.close(); outsiderSocket.close(); });
  const offer = waitForEvent(memberSocket, 'call:signal', (event) => event.signal.type === 'offer');
  adminSocket.send(JSON.stringify({ type: 'call:signal', targetId: member.user.id, callId: 'group-call', mode: 'video', roomId: 'room-1', signal: { type: 'offer', sdp: 'v=0' } }));
  assert.equal((await offer).from, admin.user.id);
  const refused = waitForEvent(adminSocket, 'error');
  adminSocket.send(JSON.stringify({ type: 'call:signal', targetId: outsider.user.id, callId: 'outsider-call', mode: 'video', signal: { type: 'offer', sdp: 'v=0' } }));
  assert.match((await refused).message, /not a contact/);
  const invite = waitForEvent(memberSocket, 'call:invite');
  adminSocket.send(JSON.stringify({ type: 'call:invite', targetId: member.user.id, roomId: 'room-2', mode: 'audio', participants: [admin.user.id] }));
  assert.equal((await invite).roomId, 'room-2');
});

test('group history returns the latest 500 messages in chronological order', async () => {
  const admin = await createSession('group_history_admin');
  const response = await fetch(`${baseUrl}/api/v1/groups`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + admin.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'History', memberIds: [] }),
  });
  const { id } = await response.json();
  const insert = service.db.prepare('INSERT INTO group_messages(id, group_id, sender_id, created_at, content, expires_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (let index = 0; index < 501; index += 1) insert.run(`history-${index}`, id, admin.user.id, index, `${index}`, null);
  const historyResponse = await fetch(`${baseUrl}/api/v1/groups/${id}/messages`, { headers: { Authorization: 'Bearer ' + admin.token } });
  const history = await historyResponse.json();
  assert.equal(history.length, 500);
  assert.equal(history[0].content, '1');
  assert.equal(history[499].content, '500');
});

function waitForEvent(socket, type, predicate = () => true) {
  const bufferedIndex = socket.eventBuffer.findIndex((event) => event.type === type && predicate(event));
  if (bufferedIndex >= 0) return Promise.resolve(socket.eventBuffer.splice(bufferedIndex, 1)[0]);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 2500);
    const listener = (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type !== type || !predicate(event)) return;
      clearTimeout(timeout);
      socket.off('message', listener);
      const bufferedIndex = socket.eventBuffer.findIndex((item) => item.type === type && predicate(item));
      if (bufferedIndex >= 0) socket.eventBuffer.splice(bufferedIndex, 1);
      resolve(event);
    };
    socket.on('message', listener);
  });
}

async function connect(token) {
  const socketUrl = baseUrl.replace('http:', 'ws:') + '/ws';
  const socket = new WebSocket(socketUrl, [`relay.auth.${token}`, 'relay.v1']);
  socket.eventBuffer = [];
  socket.on('message', (raw) => {
    socket.eventBuffer.push(JSON.parse(raw.toString()));
    if (socket.eventBuffer.length > 100) socket.eventBuffer.shift();
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  assert.equal(socket.protocol, 'relay.v1');
  return socket;
}

test('group message events reach members and reconnecting members see permanent deletion', async (t) => {
  const admin = await createSession('group_events_admin');
  const member = await createSession('group_events_member');
  const outsider = await createSession('group_events_outsider');
  const call = async (path, session, method = 'GET', body) => fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: 'Bearer ' + session.token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const created = await call('/api/v1/groups', admin, 'POST', { name: 'Events', memberIds: [member.user.id] });
  const { id } = await created.json();
  const memberSocket = await connect(member.token);
  const outsiderSocket = await connect(outsider.token);
  t.after(() => { memberSocket.close(); outsiderSocket.close(); });
  const newMessage = waitForEvent(memberSocket, 'group:message');
  const sentResponse = await call(`/api/v1/groups/${id}/messages`, admin, 'POST', { content: 'hello members' });
  const message = await sentResponse.json();
  const delivered = await newMessage;
  assert.equal(delivered.message.id, message.id);
  assert.equal(delivered.groupName, 'Events', 'notifications can be titled with the group');
  assert.equal(delivered.senderName, admin.user.name);
  assert.equal(outsiderSocket.eventBuffer.some((event) => event.type === 'group:message'), false);
  const deleted = waitForEvent(memberSocket, 'group:message-deleted');
  assert.equal((await call(`/api/v1/groups/${id}/messages/${message.id}`, admin, 'DELETE')).status, 204);
  assert.equal((await deleted).messageId, message.id);
  memberSocket.close();
  const history = await call(`/api/v1/groups/${id}/messages`, member);
  assert.deepEqual(await history.json(), []);
});

test('leaving a group notifies both the departing member and remaining members', async (t) => {
  const admin = await createSession('leave_group_admin');
  const member = await createSession('leave_group_member');
  const created = await fetch(`${baseUrl}/api/v1/groups`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + admin.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Leave test', memberIds: [member.user.id] }),
  });
  const { id } = await created.json();
  const adminSocket = await connect(admin.token);
  const memberSocket = await connect(member.token);
  t.after(() => { adminSocket.close(); memberSocket.close(); });
  const adminNotice = waitForEvent(adminSocket, 'group:changed', (event) => event.groupId === id);
  const memberNotice = waitForEvent(memberSocket, 'group:changed', (event) => event.groupId === id);
  const response = await fetch(`${baseUrl}/api/v1/groups/${id}/membership`, {
    method: 'DELETE', headers: { Authorization: 'Bearer ' + member.token },
  });
  assert.equal(response.status, 204);
  await Promise.all([adminNotice, memberNotice]);
  const rejected = await fetch(`${baseUrl}/api/v1/groups/${id}/messages`, { headers: { Authorization: 'Bearer ' + member.token } });
  assert.equal(rejected.status, 404);
});

test('rejects invalid registration data and unauthenticated profile requests', async () => {
  const invalid = await fetch(`${baseUrl}/api/v1/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'external-account', dob: '2999-01-01', password: 'short' }),
  });

  assert.equal(invalid.status, 400);
  const profile = await fetch(`${baseUrl}/api/v1/me`);
  assert.equal(profile.status, 401);
});

test('rejects invalid ports instead of silently using a fallback', () => {
  for (const port of [NaN, -1, 65536, 1.5]) {
    assert.throws(() => createChatServer({ port }), /PORT must be an integer/);
  }
  const original = process.env.PORT;
  try {
    process.env.PORT = 'invalid';
    assert.throws(() => createChatServer(), /PORT must be an integer/);
  } finally {
    if (original === undefined) delete process.env.PORT;
    else process.env.PORT = original;
  }
});

test('Event Pilot lifecycle failures do not break HTTP startup or shutdown', async (t) => {
  await service.close();
  service = createChatServer({ port: 0, dataDirectory: directory });
  const log = t.mock.method(console, 'error', () => {});
  const observed = [];
  service.eventPilot.on('server:listening', async () => { throw new Error('Listener failed'); });
  service.eventPilot.on('server:listening', async (address) => {
    observed.push(address.port);
  });
  service.eventPilot.on('server:stopping', async () => { throw new Error('Cleanup listener failed'); });
  service.eventPilot.on('server:stopping', async () => {
    assert.equal(service.server.listening, false);
    assert.equal(service.db.prepare('SELECT 1 AS value').get().value, 1);
    observed.push('stopping');
  });
  const address = await service.listen();
  assert.deepEqual(observed, [address.port]);
  const health = await fetch(`http://127.0.0.1:${address.port}/api/v1/health`);
  assert.equal(health.status, 200);
  const pilot = service.eventPilot;
  await service.close();
  service = null;
  assert.deepEqual(observed, [address.port, 'stopping']);
  assert.equal(log.mock.callCount(), 2);
  await assert.rejects(pilot.publish('late'), /closed/);
});

test('server shutdown drains pending Event Pilot handlers before closing the database', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  let stopping;
  const stopSignal = new Promise((resolve) => { stopping = resolve; });
  let completed = false;
  service.eventPilot.on('background', async () => {
    await gate;
    assert.equal(service.db.prepare('SELECT 1 AS value').get().value, 1);
    completed = true;
  });
  service.eventPilot.on('server:stopping', () => stopping());
  const publication = service.eventPilot.publish('background');
  const closing = service.close();
  await stopSignal;
  assert.equal(completed, false);
  release();
  await publication;
  await closing;
  service = null;
  assert.equal(completed, true);
});

test('rejects WebSocket upgrades without a valid session', async () => {
  const socketUrl = baseUrl.replace('http:', 'ws:') + '/ws';
  const socket = new WebSocket(socketUrl, ['relay.auth.invalid-token', 'relay.v1']);
  socket.on('error', () => {});
  const status = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for rejected WebSocket upgrade')), 1500);
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timeout);
      resolve(response.statusCode);
    });
    socket.once('open', () => {
      clearTimeout(timeout);
      reject(new Error('WebSocket connected without a valid session'));
    });
  });
  assert.equal(status, 401);
  socket.terminate();
});

test('registers unique normalized handles with UUID, DOB, and hashed password', async () => {
  const availability = await fetch(`${baseUrl}/api/v1/auth/availability?username=%40Milan`);
  assert.deepEqual(await availability.json(), { valid: true, available: true, username: 'milan' });

  const createdResponse = await fetch(`${baseUrl}/api/v1/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: '@Milan', dob: '1992-06-03', password: 'Long-Secure-Password-42!' }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.user.username, 'milan');
  assert.equal(created.user.name, '@milan');
  assert.match(created.user.id, /^[0-9a-f-]{36}$/i);
  assert.equal(created.expiresAt, undefined);
  const stored = service.db.prepare('SELECT dob, password_hash FROM users WHERE id = ?').get(created.user.id);
  assert.equal(stored.dob, '1992-06-03');
  assert.match(stored.password_hash, /^scrypt\$32768\$8\$1\$/);
  assert.notEqual(stored.password_hash, 'Long-Secure-Password-42!');
  assert.equal(service.db.prepare('SELECT expires_at FROM sessions WHERE user_id = ?').get(created.user.id).expires_at, null);

  const duplicate = await fetch(`${baseUrl}/api/v1/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'MILAN', dob: '1992-06-03', password: 'Long-Secure-Password-42!' }),
  });
  assert.equal(duplicate.status, 409);
  assert.match((await duplicate.json()).error, /already taken/i);

  const wrongPassword = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: '@MILAN', password: 'incorrect-password' }),
  });
  assert.equal(wrongPassword.status, 401);
  const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: created.user.id, password: 'Long-Secure-Password-42!' }),
  });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).user.id, created.user.id);
});

test('keeps sessions valid until explicit logout, then revokes them', async () => {
  const account = await createSession('logoutowner');
  const before = await fetch(`${baseUrl}/api/v1/me`, { headers: { Authorization: `Bearer ${account.token}` } });
  assert.equal(before.status, 200);
  const logout = await fetch(`${baseUrl}/api/v1/auth/logout`, {
    method: 'POST', headers: { Authorization: `Bearer ${account.token}` },
  });
  assert.equal(logout.status, 204);
  const after = await fetch(`${baseUrl}/api/v1/me`, { headers: { Authorization: `Bearer ${account.token}` } });
  assert.equal(after.status, 401);
});

test('searches discoverable handles and persists selected contacts', async () => {
  const owner = await createSession('contactowner');
  const discovered = await createSession('milan');

  const unauthenticated = await fetch(`${baseUrl}/api/v1/contacts/search?q=milan`);
  assert.equal(unauthenticated.status, 401);
  const search = await fetch(`${baseUrl}/api/v1/contacts/search?q=%40MIL`, {
    headers: { Authorization: `Bearer ${owner.token}` },
  });
  assert.equal(search.status, 200);
  assert.deepEqual((await search.json()).map((user) => user.username), ['milan']);

  const add = await fetch(`${baseUrl}/api/v1/contacts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: discovered.user.id }),
  });
  assert.equal(add.status, 200);
  const contacts = await fetch(`${baseUrl}/api/v1/contacts`, { headers: { Authorization: `Bearer ${owner.token}` } });
  const savedContacts = (await contacts.json()).map((user) => user.username);
  assert.ok(savedContacts.includes('milan'));
  assert.equal(new Set(savedContacts).size, savedContacts.length);
});

test('issues a one-use pairing session for the authenticated account', async () => {
  const primary = await createSession('pairowner');
  const created = await fetch(`${baseUrl}/api/v1/pairing`, { method: 'POST', headers: { Authorization: `Bearer ${primary.token}` } });
  assert.equal(created.status, 201);
  const { code } = await created.json();
  const claim = await fetch(`${baseUrl}/api/v1/pairing/${code}/claim`, { method: 'POST' });
  assert.equal(claim.status, 200);
  const linked = await claim.json();
  const profile = await fetch(`${baseUrl}/api/v1/me`, { headers: { Authorization: `Bearer ${linked.token}` } });
  assert.equal(profile.status, 200);
  assert.equal((await profile.json()).user.id, primary.user.id);
  const replay = await fetch(`${baseUrl}/api/v1/pairing/${code}/claim`, { method: 'POST' });
  assert.equal(replay.status, 410);
});

test('authenticates sockets, delivers messages, and persists read status', async () => {
  const ava = await createSession('messageava');
  const jordan = await createSession('messagejordan');
  const sender = await connect(ava.token);
  const receiver = await connect(jordan.token);
  const delivered = waitForEvent(receiver, 'message:new');
  const ack = waitForEvent(sender, 'message:ack');
  sender.send(JSON.stringify({ type: 'message:send', message: { id: 'test-message', receiverId: jordan.user.id, content: 'Hello in real time' } }));
  const [incoming, accepted] = await Promise.all([delivered, ack]);
  assert.equal(incoming.message.status, 'sent', 'one tick until the device confirms');
  assert.equal(accepted.message.status, 'sent');
  assert.equal(accepted.message.senderId, ava.user.id);
  // Only the recipient can confirm delivery; then the sender sees two ticks.
  sender.send(JSON.stringify({ type: 'message:delivered', messageIds: ['test-message'] }));
  const deliveredUpdate = waitForEvent(sender, 'message:status', (event) => event.messageId === 'test-message');
  receiver.send(JSON.stringify({ type: 'message:delivered', messageIds: ['test-message'] }));
  assert.equal((await deliveredUpdate).status, 'delivered');
  assert.equal(incoming.message.senderUsername, 'messageava');
  const recipientContacts = await fetch(`${baseUrl}/api/v1/contacts`, { headers: { Authorization: `Bearer ${jordan.token}` } });
  assert.ok((await recipientContacts.json()).some((contact) => contact.id === ava.user.id));

  const readUpdate = waitForEvent(sender, 'message:status', (event) => event.messageId === 'test-message');
  receiver.send(JSON.stringify({ type: 'message:read', messageId: 'test-message' }));
  assert.equal((await readUpdate).status, 'read');

  const history = await fetch(`${baseUrl}/api/v1/messages?peerId=${jordan.user.id}`, { headers: { Authorization: `Bearer ${ava.token}` } });
  assert.equal(history.status, 200);
  const messages = await history.json();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, 'Hello in real time');
  assert.equal(messages[0].status, 'read');
  sender.close();
  receiver.close();
});

test('queued messages are re-sent on every reconnect until the recipient device confirms them', async () => {
  const ava = await createSession('offlineava');
  const jordan = await createSession('offlinejordan');
  const sender = await connect(ava.token);
  const acknowledgement = waitForEvent(sender, 'message:ack');
  sender.send(JSON.stringify({ type: 'message:send', message: { id: 'offline-message', receiverId: jordan.user.id, content: 'Catch you later' } }));
  assert.equal((await acknowledgement).message.status, 'sent');

  // A device that connects but never confirms (lost the message) leaves it at one tick and gets it again.
  const silent = await connect(jordan.token);
  assert.equal((await waitForEvent(silent, 'message:new', (event) => event.message.id === 'offline-message')).message.status, 'sent');
  silent.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const deliveryUpdate = waitForEvent(sender, 'message:status', (event) => event.messageId === 'offline-message');
  const receiver = await connect(jordan.token);
  const replayedMessage = await waitForEvent(receiver, 'message:new', (event) => event.message.id === 'offline-message');
  assert.equal(replayedMessage.message.content, 'Catch you later');
  assert.equal(replayedMessage.message.status, 'sent');
  receiver.send(JSON.stringify({ type: 'message:delivered', messageIds: ['offline-message'] }));
  assert.equal((await deliveryUpdate).status, 'delivered');

  const history = await fetch(`${baseUrl}/api/v1/messages?peerId=${ava.user.id}`, { headers: { Authorization: `Bearer ${jordan.token}` } });
  assert.equal((await history.json())[0].status, 'delivered');
  sender.close();
  receiver.close();
});

test('deduplicates retried messages and syncs read receipts to other devices', async () => {
  const ava = await createSession('retryava');
  const jordan = await createSession('retryjordan');
  const sender = await connect(ava.token);
  const receiver = await connect(jordan.token);
  const secondDevice = await connect(jordan.token);
  const firstDelivery = waitForEvent(receiver, 'message:new', (event) => event.message.id === 'retry-message');
  const secondDelivery = waitForEvent(secondDevice, 'message:new', (event) => event.message.id === 'retry-message');
  const firstAck = waitForEvent(sender, 'message:ack');
  const payload = { type: 'message:send', message: { id: 'retry-message', receiverId: jordan.user.id, content: 'Send once' } };
  sender.send(JSON.stringify(payload));
  await Promise.all([firstDelivery, secondDelivery, firstAck]);

  const retryAck = waitForEvent(sender, 'message:ack');
  sender.send(JSON.stringify(payload));
  await retryAck;
  const statusOnSecondDevice = waitForEvent(secondDevice, 'message:status', (event) => event.messageId === 'retry-message');
  receiver.send(JSON.stringify({ type: 'message:read', messageId: 'retry-message' }));
  assert.equal((await statusOnSecondDevice).status, 'read');

  const history = await fetch(`${baseUrl}/api/v1/messages?peerId=${jordan.user.id}`, { headers: { Authorization: `Bearer ${ava.token}` } });
  assert.equal((await history.json()).length, 1);
  sender.close();
  receiver.close();
  secondDevice.close();
});

test('relays WebRTC signaling only between saved contacts', async () => {
  const caller = await createSession('callcaller');
  const callee = await createSession('callcallee');
  const addContact = await fetch(`${baseUrl}/api/v1/contacts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${caller.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: callee.user.id }),
  });
  assert.equal(addContact.status, 200);
  const sender = await connect(caller.token);
  const receiver = await connect(callee.token);
  const receivedIce = waitForEvent(receiver, 'call:signal', (event) => event.callId === 'call-test' && event.signal.type === 'ice');
  const receivedOffer = waitForEvent(receiver, 'call:signal', (event) => event.callId === 'call-test' && event.signal.type === 'offer');
  sender.send(JSON.stringify({
    type: 'call:signal',
    targetId: callee.user.id,
    callId: 'call-test',
    mode: 'audio',
    signalId: 'ice-before-offer',
    signal: { type: 'ice', candidate: { candidate: 'candidate:one' } },
  }));
  sender.send(JSON.stringify({
    type: 'call:signal',
    targetId: callee.user.id,
    callId: 'call-test',
    mode: 'audio',
    signalId: 'offer-after-ice',
    signal: { type: 'offer', sdp: { type: 'offer', sdp: 'test-offer' } },
  }));
  const [ice, offer] = await Promise.all([receivedIce, receivedOffer]);
  assert.equal(ice.from, caller.user.id);
  assert.equal(ice.signalId, 'ice-before-offer');
  assert.equal(offer.mode, 'audio');
  assert.equal(offer.signalId, 'offer-after-ice');

  const unauthorized = waitForEvent(sender, 'error');
  sender.send(JSON.stringify({
    type: 'call:signal', targetId: randomUUID(), callId: 'call-no-contact', signalId: 'invalid-call', mode: 'video',
    signal: { type: 'offer', sdp: { type: 'offer', sdp: 'test-offer' } },
  }));
  assert.match((await unauthorized).message, /not a contact/i);
  sender.close();
  receiver.close();
});

test('ends unanswered calls on the server and notifies both peers', async () => {
  await service.close();
  service = createChatServer({ port: 0, databasePath: join(directory, 'call-timeout.sqlite'), callTimeoutMs: 80 });
  const address = await service.listen();
  baseUrl = `http://127.0.0.1:${address.port}`;

  const caller = await createSession('timeoutcaller');
  const callee = await createSession('timeoutcallee');
  const addContact = await fetch(`${baseUrl}/api/v1/contacts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${caller.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: callee.user.id }),
  });
  assert.equal(addContact.status, 200);
  const callerSocket = await connect(caller.token);
  const calleeSocket = await connect(callee.token);
  const incomingOffer = waitForEvent(calleeSocket, 'call:signal', (event) => event.callId === 'timeout-call' && event.signal.type === 'offer');
  const callerTimeout = waitForEvent(callerSocket, 'call:signal', (event) => event.callId === 'timeout-call' && event.signal.type === 'end');
  const calleeTimeout = waitForEvent(calleeSocket, 'call:signal', (event) => event.callId === 'timeout-call' && event.signal.type === 'end');
  callerSocket.send(JSON.stringify({
    type: 'call:signal', targetId: callee.user.id, callId: 'timeout-call', signalId: 'timeout-offer', mode: 'audio',
    signal: { type: 'offer', sdp: { type: 'offer', sdp: 'timeout-test' } },
  }));
  await incomingOffer;
  assert.equal((await callerTimeout).signal.reason, 'no-answer');
  assert.equal((await calleeTimeout).signal.reason, 'no-answer');
  callerSocket.close();
  calleeSocket.close();
});

test('tells the caller only when a callee device is ringing', async () => {
  const caller = await createSession('ringcaller');
  const online = await createSession('ringonline');
  const offline = await createSession('ringoffline');
  for (const callee of [online, offline]) {
    const added = await fetch(`${baseUrl}/api/v1/contacts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${caller.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: callee.user.id }),
    });
    assert.equal(added.status, 200);
  }
  const callerSocket = await connect(caller.token);
  const onlineSocket = await connect(online.token);
  const seen = [];
  callerSocket.on('message', (data) => seen.push(JSON.parse(data.toString())));
  const ringing = waitForEvent(callerSocket, 'call:signal', (event) => event.callId === 'ring-online' && event.signal.type === 'ringing');
  callerSocket.send(JSON.stringify({
    type: 'call:signal', targetId: online.user.id, callId: 'ring-online', signalId: 'ring-offer-1', mode: 'video',
    signal: { type: 'offer', sdp: { type: 'offer', sdp: 'ring-test' } },
  }));
  const event = await ringing;
  assert.equal(event.from, online.user.id);
  assert.equal(event.mode, 'video');

  callerSocket.send(JSON.stringify({
    type: 'call:signal', targetId: offline.user.id, callId: 'ring-offline', signalId: 'ring-offer-2', mode: 'audio',
    signal: { type: 'offer', sdp: { type: 'offer', sdp: 'ring-test' } },
  }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(seen.some((item) => item.callId === 'ring-offline' && item.signal?.type === 'ringing'), false);
  callerSocket.close();
  onlineSocket.close();
});

test('uses longer heartbeat intervals while idle or backgrounded', () => {
  assert.equal(heartbeatIntervalForState({ visibility: 'visible', idle: false }), 25_000);
  assert.equal(heartbeatIntervalForState({ visibility: 'visible', idle: true }), 60_000);
  assert.equal(heartbeatIntervalForState({ visibility: 'hidden', idle: false }), 120_000);
});

test('times read like WhatsApp in the phone time zone', () => {
  // Local constructors keep this independent of the machine's time zone.
  const now = new Date(2026, 10, 9, 14, 0);
  assert.equal(formatMessageTime(new Date(2026, 10, 9, 22, 35)), '10:35 pm');
  assert.equal(formatMessageTime(new Date(2026, 10, 9, 0, 7)), '12:07 am');
  assert.equal(formatMessageTime(new Date(2026, 10, 9, 12, 0)), '12:00 pm');
  assert.equal(formatMessageTime('nonsense'), '');
  assert.equal(formatChatListTime(new Date(2026, 10, 9, 2, 11), now), '2:11 am');
  assert.equal(formatChatListTime(new Date(2026, 10, 8, 23, 59), now), 'Yesterday');
  assert.equal(formatChatListTime(new Date(2026, 10, 5, 9, 0), now), 'Thursday');
  assert.equal(formatChatListTime(new Date(2026, 10, 7 - 5, 9, 0), now), '02/11/2026');
  assert.equal(formatMessageDate(new Date(2026, 10, 9, 1, 0), now), 'Today');
  assert.equal(formatMessageDate(new Date(2026, 10, 8, 1, 0), now), 'Yesterday');
  assert.equal(formatMessageDate(new Date(2026, 10, 4, 1, 0), now), 'Wednesday');
  assert.equal(formatMessageDate(new Date(2026, 9, 20, 1, 0), now), '20 October 2026');
  assert.equal(localDateKey(new Date(2026, 10, 4, 23, 59)), localDateKey(new Date(2026, 10, 4, 0, 0)));
  assert.notEqual(localDateKey(new Date(2026, 10, 4, 23, 59)), localDateKey(new Date(2026, 10, 5, 0, 0)));
});

test('message receipts advance monotonically from sent to delivered to read', () => {
  assert.equal(mergeMessageStatus('sent', 'delivered'), 'delivered');
  assert.equal(mergeMessageStatus('delivered', 'read'), 'read');
  assert.equal(mergeMessageStatus('read', 'delivered'), 'read');
  assert.equal(mergeMessageStatus('read', 'sent'), 'read');
});

test('uploads and downloads attachments only for conversation participants', async () => {
  const sender = await createSession('mediasender');
  const receiver = await createSession('mediareceiver');
  const body = Buffer.from('relay attachment payload');
  const upload = await fetch(`${baseUrl}/api/v1/media?receiverId=${receiver.user.id}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${sender.token}`,
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent('notes test.txt'),
    },
    body,
  });
  assert.equal(upload.status, 201);
  const attachment = await upload.json();
  assert.equal(attachment.filename, 'notes test.txt');

  const recipientDownload = await fetch(`${baseUrl}/api/v1/media/${attachment.id}`, {
    headers: { Authorization: `Bearer ${receiver.token}` },
  });
  assert.equal(recipientDownload.status, 200);
  assert.deepEqual(Buffer.from(await recipientDownload.arrayBuffer()), body);

  const unrelated = await createSession('mediaobserver');
  const denied = await fetch(`${baseUrl}/api/v1/media/${attachment.id}`, {
    headers: { Authorization: `Bearer ${unrelated.token}` },
  });
  assert.equal(denied.status, 404);
});

test('protects RTC configuration and returns default ICE servers to authenticated users', async () => {
  const unauthenticated = await fetch(`${baseUrl}/api/v1/rtc-config`);
  assert.equal(unauthenticated.status, 401);
  const user = await createSession('rtcconfiguser');
  const response = await fetch(`${baseUrl}/api/v1/rtc-config`, { headers: { Authorization: `Bearer ${user.token}` } });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).iceServers, [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]);
});

test('allows exact configured tunnel origins and rejects arbitrary public origins', async () => {
  assert.equal(isAllowedAppOrigin('http://127.0.0.1:5173'), true);
  assert.equal(isAllowedAppOrigin('http://192.168.1.25:5173'), true);
  assert.equal(isAllowedAppOrigin('https://relay-test.ngrok-free.app', ['https://relay-test.ngrok-free.app']), true);
  assert.equal(isAllowedAppOrigin('https://attacker.example', ['https://relay-test.ngrok-free.app']), false);
  assert.equal(isAllowedAppOrigin('javascript:alert(1)', []), false);

  await service.close();
  service = createChatServer({ port: 0, databasePath: join(directory, 'origin-check.sqlite'), allowedOrigins: ['https://relay-test.ngrok-free.app'] });
  const address = await service.listen();
  baseUrl = `http://127.0.0.1:${address.port}`;

  const publicHealth = await fetch(`${baseUrl}/api/v1/health`, { headers: { Origin: 'https://relay-test.ngrok-free.app' } });
  assert.equal(publicHealth.status, 200);
  assert.equal(publicHealth.headers.get('access-control-allow-origin'), 'https://relay-test.ngrok-free.app');
  const rejectedHealth = await fetch(`${baseUrl}/api/v1/health`, { headers: { Origin: 'https://attacker.example' } });
  assert.equal(rejectedHealth.status, 403);

  const account = await createSession('originuser');
  const socketUrl = baseUrl.replace('http:', 'ws:') + '/ws';
  const socket = new WebSocket(socketUrl, ['relay.auth.' + account.token, 'relay.v1'], {
    headers: { Origin: 'https://attacker.example' },
  });
  socket.on('error', () => {});
  const status = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for origin rejection')), 1500);
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timeout);
      resolve(response.statusCode);
    });
    socket.once('open', () => {
      clearTimeout(timeout);
      reject(new Error('WebSocket connected from an unconfigured origin'));
    });
  });
  assert.equal(status, 403);
  socket.terminate();
});

test('development Ngrok origins pass CORS preflight and authenticated WebSocket upgrades', async () => {
  const origin = 'https://new-tunnel.ngrok-free.app';
  assert.equal(isAllowedAppOrigin(origin), true);
  for (const denied of ['https://ngrok-free.app', 'https://x.ngrok-free.app.attacker.example', 'https://evilngrok-free.app', 'http://x.ngrok-free.app', `${origin}/path`]) {
    assert.equal(isAllowedAppOrigin(denied), false);
  }
  const response = await fetch(`${baseUrl}/api/v1/uploads/upload-a`, {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'authorization,x-upload-offset,ngrok-skip-browser-warning' },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.equal(response.headers.get('access-control-allow-methods'), 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
  assert.match(response.headers.get('access-control-allow-headers'), /X-Upload-Offset/);
  // The account backup upload (src/cloudBackup.js) names its key type in a header; the app's origin must be allowed to send it.
  assert.match(response.headers.get('access-control-allow-headers'), /X-Backup-Kdf/);
  assert.match(response.headers.get('vary'), /Origin/);
  const account = await createSession('ngrokuser');
  const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/ws', ['relay.auth.' + account.token, 'relay.v1'], { headers: { Origin: origin } });
  try {
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    assert.equal(socket.protocol, 'relay.v1');
  } finally {
    socket.terminate();
  }
});