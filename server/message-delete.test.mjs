import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, test } from 'node:test';
import WebSocket from 'ws';
import { createChatServer } from './index.mjs';

let service;
let directory;
let baseUrl;
let databasePath;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-delete-test-'));
  databasePath = join(directory, 'test.sqlite');
  service = createChatServer({ port: 0, databasePath });
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

async function connect(token) {
  const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/ws', [`relay.auth.${token}`, 'relay.v1']);
  socket.eventBuffer = [];
  socket.on('message', (raw) => socket.eventBuffer.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return socket;
}

async function waitFor(socket, type, predicate = () => true) {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    const index = socket.eventBuffer.findIndex((event) => event.type === type && predicate(event));
    if (index >= 0) return socket.eventBuffer.splice(index, 1)[0];
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Timed out waiting for ${type}`);
}

async function history(session, peerId) {
  const response = await fetch(`${baseUrl}/api/v1/messages?peerId=${peerId}`, { headers: { Authorization: `Bearer ${session.token}` } });
  assert.equal(response.status, 200);
  return response.json();
}

async function sendMessage(sender, receiver, senderSocket, receiverSocket, id) {
  senderSocket.send(JSON.stringify({ type: 'message:send', message: { id, receiverId: receiver.user.id, content: `hello ${id}` } }));
  await waitFor(receiverSocket, 'message:new', (event) => event.message.id === id);
}

test('delete for everyone tombstones the message for both users and notifies them', async () => {
  const ava = await createSession('deleteava');
  const jordan = await createSession('deletejordan');
  const avaSocket = await connect(ava.token);
  const jordanSocket = await connect(jordan.token);
  await sendMessage(ava, jordan, avaSocket, jordanSocket, 'everyone-1');

  avaSocket.send(JSON.stringify({ type: 'message:delete', messageId: 'everyone-1', scope: 'everyone' }));
  assert.equal((await waitFor(avaSocket, 'message:deleted')).scope, 'everyone');
  assert.equal((await waitFor(jordanSocket, 'message:deleted')).messageId, 'everyone-1');

  for (const [session, peer] of [[ava, jordan], [jordan, ava]]) {
    const messages = await history(session, peer.user.id);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].deleted, true);
    assert.equal(messages[0].content, '');
  }
  avaSocket.close();
  jordanSocket.close();
});

test('only the sender can delete for everyone', async () => {
  const ava = await createSession('senderava');
  const jordan = await createSession('senderjordan');
  const avaSocket = await connect(ava.token);
  const jordanSocket = await connect(jordan.token);
  await sendMessage(ava, jordan, avaSocket, jordanSocket, 'sender-1');

  jordanSocket.send(JSON.stringify({ type: 'message:delete', messageId: 'sender-1', scope: 'everyone' }));
  await waitFor(jordanSocket, 'message:delete:error');
  assert.equal((await history(ava, jordan.user.id))[0].content, 'hello sender-1');
  avaSocket.close();
  jordanSocket.close();
});

test('delete for everyone is refused after 24 hours', async () => {
  const ava = await createSession('windowava');
  const jordan = await createSession('windowjordan');
  const avaSocket = await connect(ava.token);
  const jordanSocket = await connect(jordan.token);
  await sendMessage(ava, jordan, avaSocket, jordanSocket, 'old-1');

  const db = new DatabaseSync(databasePath);
  db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(Date.now() - 25 * 60 * 60 * 1000, 'old-1');
  db.close();

  avaSocket.send(JSON.stringify({ type: 'message:delete', messageId: 'old-1', scope: 'everyone' }));
  const error = await waitFor(avaSocket, 'message:delete:error');
  assert.match(error.message, /too old/);
  assert.equal((await history(jordan, ava.user.id))[0].content, 'hello old-1');

  avaSocket.send(JSON.stringify({ type: 'message:delete', messageId: 'old-1', scope: 'me' }));
  await waitFor(avaSocket, 'message:deleted');
  avaSocket.close();
  jordanSocket.close();
});

test('delete for me hides the message only from the requesting user', async () => {
  const ava = await createSession('hideava');
  const jordan = await createSession('hidejordan');
  const avaSocket = await connect(ava.token);
  const jordanSocket = await connect(jordan.token);
  await sendMessage(ava, jordan, avaSocket, jordanSocket, 'me-1');

  jordanSocket.send(JSON.stringify({ type: 'message:delete', messageId: 'me-1', scope: 'me' }));
  assert.equal((await waitFor(jordanSocket, 'message:deleted')).scope, 'me');

  assert.equal((await history(jordan, ava.user.id)).length, 0);
  const senderView = await history(ava, jordan.user.id);
  assert.equal(senderView.length, 1);
  assert.equal(senderView[0].content, 'hello me-1');
  assert.equal(avaSocket.eventBuffer.some((event) => event.type === 'message:deleted'), false);
  avaSocket.close();
  jordanSocket.close();
});
