import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import WebSocket from 'ws';
import { createChatServer } from './index.mjs';

let service;
let directory;
let baseUrl;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-reaction-test-'));
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
  return response.json();
}

test('reactions broadcast to both peers, persist in history, and can be changed or removed', async () => {
  const ava = await createSession('reactava');
  const jordan = await createSession('reactjordan');
  const avaSocket = await connect(ava.token);
  const jordanSocket = await connect(jordan.token);
  avaSocket.send(JSON.stringify({ type: 'message:send', message: { id: 'react-1', receiverId: jordan.user.id, content: 'hi' } }));
  await waitFor(jordanSocket, 'message:new');

  jordanSocket.send(JSON.stringify({ type: 'message:reaction', messageId: 'react-1', emoji: '👍' }));
  for (const socket of [avaSocket, jordanSocket]) {
    const event = await waitFor(socket, 'message:reaction');
    assert.deepEqual([event.messageId, event.userId, event.emoji], ['react-1', jordan.user.id, '👍']);
  }
  assert.deepEqual((await history(ava, jordan.user.id))[0].reactions, [{ userId: jordan.user.id, emoji: '👍' }]);

  jordanSocket.send(JSON.stringify({ type: 'message:reaction', messageId: 'react-1', emoji: '❤️' }));
  await waitFor(avaSocket, 'message:reaction', (event) => event.emoji === '❤️');
  assert.deepEqual((await history(jordan, ava.user.id))[0].reactions, [{ userId: jordan.user.id, emoji: '❤️' }]);

  jordanSocket.send(JSON.stringify({ type: 'message:reaction', messageId: 'react-1', emoji: null }));
  assert.equal((await waitFor(avaSocket, 'message:reaction', (event) => event.emoji === null)).userId, jordan.user.id);
  assert.deepEqual((await history(ava, jordan.user.id))[0].reactions, []);
  avaSocket.close();
  jordanSocket.close();
});

test('rejects reactions from non-participants', async () => {
  const ava = await createSession('partava');
  const jordan = await createSession('partjordan');
  const mallory = await createSession('partmallory');
  const avaSocket = await connect(ava.token);
  const jordanSocket = await connect(jordan.token);
  const mallorySocket = await connect(mallory.token);
  avaSocket.send(JSON.stringify({ type: 'message:send', message: { id: 'part-1', receiverId: jordan.user.id, content: 'hi' } }));
  await waitFor(jordanSocket, 'message:new');

  mallorySocket.send(JSON.stringify({ type: 'message:reaction', messageId: 'part-1', emoji: '👍' }));
  await waitFor(mallorySocket, 'message:reaction:error');
  assert.deepEqual((await history(ava, jordan.user.id))[0].reactions, []);
  avaSocket.close();
  jordanSocket.close();
  mallorySocket.close();
});
