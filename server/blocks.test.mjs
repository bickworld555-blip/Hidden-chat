// Blocking (as on WhatsApp) and deleted accounts: what the server lets through, and what it tells each side.
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
  directory = mkdtempSync(join(tmpdir(), 'relay-blocks-'));
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), dataDirectory: directory });
  baseUrl = `http://127.0.0.1:${(await service.listen()).port}`;
});
after(async () => {
  await service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function api(path, { session, method = 'GET', body } = {}) {
  const response = await fetch(baseUrl + path, { method, headers: { ...(session ? { Authorization: `Bearer ${session.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, data: response.headers.get('content-type')?.includes('json') ? await response.json() : null };
}
async function register(prefix) {
  counter += 1;
  const { data } = await api('/api/v1/auth/register', { method: 'POST', body: { username: `${prefix}${counter}`, dob: '1990-04-12', password: PASSWORD } });
  return data;
}
function connect(session) {
  const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/ws', [`relay.auth.${session.token}`, 'relay.v1']);
  socket.events = [];
  socket.on('message', (raw) => socket.events.push(JSON.parse(raw.toString())));
  socket.waitFor = async (predicate, timeout = 3000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const found = socket.events.find(predicate); if (found) return found; await new Promise((r) => setTimeout(r, 20)); }
    return null;
  };
  return new Promise((resolve, reject) => { socket.once('open', () => resolve(socket)); socket.once('error', reject); });
}
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

test('a block list follows the account: block, list with names, unblock; not yourself', async () => {
  const ava = await register('blka');
  const ben = await register('blkb');
  assert.equal((await api(`/api/v1/blocks/${ava.user.id}`, { session: ava, method: 'PUT' })).status, 400);
  assert.equal((await api(`/api/v1/blocks/${ben.user.id}`, { session: ava, method: 'PUT' })).status, 204);
  const list = (await api('/api/v1/blocks', { session: ava })).data;
  assert.deepEqual(list.map((user) => user.username), [ben.user.username]);
  assert.ok(list[0].blockedAt > 0);
  assert.deepEqual((await api('/api/v1/blocks', { session: ben })).data, [], 'the blocked person is not told');
  assert.equal((await api(`/api/v1/blocks/${ben.user.id}`, { session: ava, method: 'DELETE' })).status, 204);
  assert.deepEqual((await api('/api/v1/blocks', { session: ava })).data, []);
});

test("a blocked person's messages get one tick and are never delivered; the blocker must unblock to write", async () => {
  const ava = await register('blkc');
  const ben = await register('blkd');
  const avaSocket = await connect(ava);
  const benSocket = await connect(ben);
  await api(`/api/v1/blocks/${ben.user.id}`, { session: ava, method: 'PUT' });

  benSocket.send(JSON.stringify({ type: 'message:send', message: { id: 'blocked-1', receiverId: ava.user.id, content: 'are you there?' } }));
  const ack = await benSocket.waitFor((event) => event.type === 'message:ack' && event.message?.id === 'blocked-1');
  assert.equal(ack?.message.status, 'sent', 'looks sent to the blocked person');
  await settle();
  assert.equal(avaSocket.events.some((event) => event.type === 'message:new'), false, 'never delivered');
  assert.equal((await api(`/api/v1/messages?peerId=${ben.user.id}`, { session: ava })).data.length, 0, 'never stored');

  avaSocket.send(JSON.stringify({ type: 'message:send', message: { id: 'blocker-1', receiverId: ben.user.id, content: 'hello' } }));
  const refused = await avaSocket.waitFor((event) => event.code === 'blocked');
  assert.equal(refused?.messageId, 'blocker-1');

  await api(`/api/v1/blocks/${ben.user.id}`, { session: ava, method: 'DELETE' });
  benSocket.send(JSON.stringify({ type: 'message:send', message: { id: 'after-1', receiverId: ava.user.id, content: 'unblocked now' } }));
  assert.ok(await avaSocket.waitFor((event) => event.type === 'message:new' && event.message?.id === 'after-1'), 'delivered again after the unblock');
  avaSocket.close();
  benSocket.close();
});

test("calls from a blocked person never ring, and neither side sees the other's online status or typing", async () => {
  const ava = await register('blke');
  const ben = await register('blkf');
  const avaSocket = await connect(ava);
  // A chat between them, so presence would normally flow.
  avaSocket.send(JSON.stringify({ type: 'message:send', message: { id: 'link-1', receiverId: ben.user.id, content: 'hi' } }));
  await avaSocket.waitFor((event) => event.type === 'message:ack');
  await api(`/api/v1/blocks/${ben.user.id}`, { session: ava, method: 'PUT' });

  const benSocket = await connect(ben);
  const ready = await benSocket.waitFor((event) => event.type === 'connection:ready');
  const avaSeenByBen = ready.presence.find((item) => item.userId === ava.user.id);
  assert.ok(!avaSeenByBen || avaSeenByBen.status === 'hidden', 'Ben does not see Ava online');

  benSocket.send(JSON.stringify({ type: 'call:signal', callId: 'c-blocked', mode: 'audio', targetId: ava.user.id, signal: { type: 'offer', sdp: 'v=0' } }));
  benSocket.send(JSON.stringify({ type: 'presence:typing', peerId: ava.user.id, active: true }));
  await settle(400);
  assert.equal(avaSocket.events.some((event) => event.type === 'call:signal'), false, 'no ringing');
  assert.equal(avaSocket.events.some((event) => event.type === 'presence:typing'), false, 'no typing');
  assert.equal(benSocket.events.some((event) => event.type === 'error'), false, 'the caller is not told');
  avaSocket.close();
  benSocket.close();
});

test('a deleted account stays in other people\'s chats as "Deleted account", read-only, and they are told', async () => {
  const ava = await register('dela');
  const cal = await register('delc');
  const avaSocket = await connect(ava);
  avaSocket.send(JSON.stringify({ type: 'message:send', message: { id: 'before-delete', receiverId: cal.user.id, content: 'hi Cal' } }));
  await avaSocket.waitFor((event) => event.type === 'message:ack');

  assert.equal((await api('/api/v1/me', { session: cal, method: 'DELETE', body: { password: PASSWORD, confirm: cal.user.username } })).status, 204);
  assert.ok(await avaSocket.waitFor((event) => event.type === 'account:deleted' && event.userId === cal.user.id), 'told at once');

  const contact = (await api('/api/v1/contacts', { session: ava })).data.find((item) => item.id === cal.user.id);
  assert.equal(contact?.deleted, true);
  assert.equal(contact?.name, 'Deleted account');
  assert.equal(contact?.avatar, null);

  avaSocket.send(JSON.stringify({ type: 'message:send', message: { id: 'after-delete', receiverId: cal.user.id, content: 'still there?' } }));
  assert.equal((await avaSocket.waitFor((event) => event.code === 'account_deleted'))?.messageId, 'after-delete');
  const found = (await api(`/api/v1/contacts/search?q=${cal.user.username}`, { session: ava })).data;
  assert.equal(found.some((user) => user.id === cal.user.id), false, 'not found in search');
  assert.equal((await api('/api/v1/contacts', { session: ava, method: 'POST', body: { userId: cal.user.id } })).status, 404, 'cannot be added');
  avaSocket.close();
});
