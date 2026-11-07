import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import WebSocket from 'ws';
import { createChatServer, heartbeatIntervalForState, isAllowedAppOrigin } from './index.mjs';
import { mergeMessageStatus } from '../src/messageStatus.js';
import { formatMessageDate, formatMessageTime, utcDateKey } from '../src/time.js';

let service;
let directory;
let baseUrl;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-chat-test-'));
  service = createChatServer({ port: 0, databasePath: join(directory, 'test.sqlite') });
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
  assert.equal(incoming.message.status, 'delivered');
  assert.equal(accepted.message.senderId, ava.user.id);
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

test('marks queued messages delivered when the recipient reconnects', async () => {
  const ava = await createSession('offlineava');
  const jordan = await createSession('offlinejordan');
  const sender = await connect(ava.token);
  const acknowledgement = waitForEvent(sender, 'message:ack');
  sender.send(JSON.stringify({ type: 'message:send', message: { id: 'offline-message', receiverId: jordan.user.id, content: 'Catch you later' } }));
  assert.equal((await acknowledgement).message.status, 'sent');

  const deliveryUpdate = waitForEvent(sender, 'message:status', (event) => event.messageId === 'offline-message');
  const receiver = await connect(jordan.token);
  assert.equal((await deliveryUpdate).status, 'delivered');
  const replayedMessage = await waitForEvent(receiver, 'message:new', (event) => event.message.id === 'offline-message');
  assert.equal(replayedMessage.message.content, 'Catch you later');
  assert.equal(replayedMessage.message.status, 'delivered');

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

test('formats message times and date grouping in GMT consistently', () => {
  assert.equal(formatMessageTime('2026-11-04T22:35:00.000Z'), '10:35 PM GMT');
  assert.equal(formatMessageDate('2026-11-04T22:35:00.000Z', new Date('2026-11-04T12:00:00.000Z')), 'Today · Wednesday, November 4, 2026 GMT');
  assert.equal(formatMessageDate('2026-11-03T22:35:00.000Z', new Date('2026-11-04T12:00:00.000Z')), 'Yesterday · Tuesday, November 3, 2026 GMT');
  assert.equal(utcDateKey('2026-11-04T23:59:59.000Z'), utcDateKey('2026-11-04T00:00:00.000Z'));
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