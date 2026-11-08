// "Online" only while the app is on screen, background-only connections, and catching up after a drop.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createChatServer } from './index.mjs';
import { SYNC_OVERLAP_MS, newestTimestamp, planSync, syncMissedMessages } from '../src/messageSync.js';

const PASSWORD = 'Correct-Horse-Battery-42!';
let service;
let directory;
let baseUrl;
let counter = 0;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-background-'));
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite') });
  baseUrl = `http://127.0.0.1:${(await service.listen()).port}`;
});
after(async () => {
  await service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
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
function connect(session, extraProtocols = []) {
  const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/ws', [`relay.auth.${session.token}`, 'relay.v1', ...extraProtocols]);
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
const latest = (socket, userId) => socket.events.filter((event) => event.type === 'presence:update' && event.userId === userId).at(-1);

test('minimising the app shows "last seen"; bringing it back shows "online"', async () => {
  const me = await register('bgme');
  const friend = await register('bgfr');
  await api('/api/v1/contacts', { session: friend, method: 'POST', body: { userId: me.user.id } });
  const watcher = await connect(friend);
  const app = await connect(me);
  await until(() => latest(watcher, me.user.id)?.status === 'online', 'online');
  const before = Date.now();
  app.send(JSON.stringify({ type: 'client:state', visibility: 'hidden', idle: false }));
  const away = await until(() => latest(watcher, me.user.id)?.status === 'offline' && latest(watcher, me.user.id), 'last seen');
  assert.ok(away.lastSeenAt >= before, 'last seen is when the app went to the background');
  app.send(JSON.stringify({ type: 'client:state', visibility: 'visible', idle: false }));
  await until(() => latest(watcher, me.user.id)?.status === 'online', 'online again');
  app.close();
  watcher.close();
});

test('the Android service\'s background connection receives messages but never shows the user online', async () => {
  const me = await register('bgsv');
  const friend = await register('bgsf');
  await api('/api/v1/contacts', { session: friend, method: 'POST', body: { userId: me.user.id } });
  const watcher = await connect(friend);
  await until(() => watcher.events.some((event) => event.type === 'connection:ready'), 'ready');
  const service = await connect(me, ['relay.background']);
  await until(() => service.events.some((event) => event.type === 'connection:ready'), 'service ready');
  // Even a "visible" state report cannot make a background-only connection online.
  service.send(JSON.stringify({ type: 'client:state', visibility: 'visible', idle: false }));
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.notEqual(latest(watcher, me.user.id)?.status, 'online');
  watcher.send(JSON.stringify({ type: 'message:send', message: { id: 'to-service', receiverId: me.user.id, content: 'Are you there?' } }));
  const incoming = await until(() => service.events.find((event) => event.type === 'message:new' && event.message.id === 'to-service'), 'message on service');
  assert.equal(incoming.message.status, 'sent');
  service.send(JSON.stringify({ type: 'message:delivered', messageIds: ['to-service'] }));
  const ticks = await until(() => watcher.events.find((event) => event.type === 'message:status' && event.messageId === 'to-service'), 'delivered');
  assert.equal(ticks.status, 'delivered', 'two ticks while the app itself is closed');
  service.close();
  watcher.close();
});

test('the catch-up endpoint returns what changed since my newest message', async () => {
  const me = await register('syme');
  const friend = await register('syfr');
  await api('/api/v1/contacts', { session: friend, method: 'POST', body: { userId: me.user.id } });
  const friendSocket = await connect(friend);
  friendSocket.send(JSON.stringify({ type: 'message:send', message: { id: 'old-1', receiverId: me.user.id, content: 'old' } }));
  await until(() => friendSocket.events.some((event) => event.type === 'message:ack'), 'ack');
  const cutoff = new Date().toISOString();
  await new Promise((resolve) => setTimeout(resolve, 20));
  friendSocket.send(JSON.stringify({ type: 'message:send', message: { id: 'new-1', receiverId: me.user.id, content: 'new' } }));
  await until(() => friendSocket.events.filter((event) => event.type === 'message:ack').length === 2, 'second ack');
  const sync = await api(`/api/v1/messages/sync?after=${encodeURIComponent(cutoff)}`, { session: me });
  assert.equal(sync.status, 200);
  assert.deepEqual(sync.body.map((message) => message.id), ['new-1']);
  assert.equal((await api('/api/v1/messages/sync?after=nonsense', { session: me })).status, 400);
  assert.equal((await api(`/api/v1/messages/sync?after=${encodeURIComponent(cutoff)}`)).status, 401);
  // The sender's own recent messages come back too, so their ticks can update.
  const own = await api(`/api/v1/messages/sync?after=${encodeURIComponent(new Date().toISOString())}`, { session: friend });
  assert.deepEqual(own.body.map((message) => message.id), ['old-1', 'new-1']);
  friendSocket.close();
});

test('catching up adds missed messages, acknowledges them, and refreshes ticks of known ones', async () => {
  const messages = {
    ava: [
      { id: 'a1', senderId: 'me', receiverId: 'ava', timestamp: '2026-11-09T10:00:00.000Z', content: 'hi', status: 'sent' },
      { id: 'a2', senderId: 'ava', receiverId: 'me', timestamp: '2026-11-09T10:05:00.000Z', content: 'hello', status: 'read' },
    ],
  };
  assert.equal(newestTimestamp(messages), Date.parse('2026-11-09T10:05:00.000Z'));
  assert.equal(newestTimestamp({}), 0);
  const rows = [
    { id: 'a1', senderId: 'me', receiverId: 'ava', timestamp: '2026-11-09T10:00:00.000Z', content: 'hi', status: 'read' },
    { id: 'b1', senderId: 'ben', receiverId: 'me', timestamp: '2026-11-09T10:07:00.000Z', content: 'missed', status: 'sent' },
    { id: 'b2', senderId: 'ben', receiverId: 'me', timestamp: '2026-11-09T10:08:00.000Z', content: '', status: 'sent', deleted: true },
  ];
  const plan = planSync(rows, messages, 'me');
  assert.deepEqual(plan.added.map((row) => row.id), ['b1'], 'deleted messages that were never seen are skipped');
  assert.deepEqual([...plan.updates.keys()], ['ava']);
  assert.deepEqual(plan.acknowledge, ['b1']);

  const calls = { added: [], merged: [], acked: [], url: '' };
  const store = { getState: () => ({ messages, addMessage: (m) => calls.added.push(m.id), mergeHistory: (peer, list) => calls.merged.push([peer, list.map((m) => m.status)]) }) };
  const fetchImpl = async (url) => { calls.url = url; return { ok: true, json: async () => rows }; };
  const result = await syncMissedMessages({ sessionToken: 't', userId: 'me', acknowledge: (ids) => calls.acked.push(...ids), store, fetchImpl });
  assert.deepEqual(result, { added: 1, updated: 1 });
  assert.deepEqual(calls.added, ['b1']);
  assert.deepEqual(calls.merged, [['ava', ['read']]]);
  assert.deepEqual(calls.acked, ['b1']);
  const after = new URL(calls.url, 'http://x').searchParams.get('after');
  assert.equal(Date.parse('2026-11-09T10:05:00.000Z') - Date.parse(after), SYNC_OVERLAP_MS);
});
