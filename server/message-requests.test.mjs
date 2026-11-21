// Message requests (Signal's model, src/messageRequests.js): a stranger who writes first hears no "delivered" or "read"
// until the receiver accepts (Accept, saving them, or replying); chats from before, and chats I start, are unaffected.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import { createChatServer } from './index.mjs';
import { holdsReceipts, isMessageRequest } from '../src/messageRequests.js';

const PASSWORD = 'correct horse battery staple';
let directory;
let service;
let base;
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-requests-'));
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), pushSender: null });
  base = `http://127.0.0.1:${(await service.listen()).port}`;
});
after(async () => {
  await service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});
async function api(path, { token, method = 'GET', body } = {}) {
  const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) };
  const response = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
const register = async (username) => (await api('/api/v1/auth/register', { method: 'POST', body: { username, dob: '1990-04-12', password: PASSWORD } })).body;
async function connect(session) {
  const socket = new WebSocket(`${base.replace('http:', 'ws:')}/ws`, [`relay.auth.${session.token}`, 'relay.v1']);
  socket.events = [];
  socket.on('message', (raw) => socket.events.push(JSON.parse(raw.toString())));
  await new Promise((resolve) => socket.once('open', resolve));
  return socket;
}
const until = async (check, label, timeout = 3000) => {
  const end = Date.now() + timeout;
  for (;;) { const value = check(); if (value) return value; if (Date.now() > end) throw new Error(`timed out: ${label}`); await new Promise((r) => setTimeout(r, 25)); }
};
const pause = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));
const statusOf = (socket, id) => socket.events.filter((event) => event.type === 'message:status' && event.messageId === id).map((event) => event.status);

test('a stranger hears no delivered or read until I accept; then they do', async () => {
  const stranger = await register('mr_stranger');
  const me = await register('mr_me');
  const them = await connect(stranger);
  const mine = await connect(me);
  them.send(JSON.stringify({ type: 'message:send', message: { id: 'req-1', receiverId: me.user.id, content: 'hi, it is me' } }));
  await until(() => mine.events.find((event) => event.type === 'message:new' && event.message.id === 'req-1'), 'message arrives');
  mine.send(JSON.stringify({ type: 'message:delivered', messageIds: ['req-1'] }));
  mine.send(JSON.stringify({ type: 'message:read', messageId: 'req-1' }));
  await pause();
  assert.deepEqual(statusOf(them, 'req-1'), [], 'nothing told to the stranger');
  const list = (await api('/api/v1/contacts', { token: me.token })).body;
  assert.equal(list.find((row) => row.id === stranger.user.id).accepted, false, 'my chat with them is a request');
  assert.equal((await api('/api/v1/contacts', { token: stranger.token })).body.find((row) => row.id === me.user.id).accepted, true, 'they started it: not a request for them');

  assert.equal((await api(`/api/v1/contacts/${stranger.user.id}/accept`, { token: me.token, method: 'POST' })).status, 200);
  await until(() => mine.events.find((event) => event.type === 'contact:accepted' && event.userId === stranger.user.id), 'my devices hear it');
  them.send(JSON.stringify({ type: 'message:send', message: { id: 'req-2', receiverId: me.user.id, content: 'thanks' } }));
  await until(() => mine.events.find((event) => event.type === 'message:new' && event.message.id === 'req-2'), 'second message');
  mine.send(JSON.stringify({ type: 'message:delivered', messageIds: ['req-2'] }));
  mine.send(JSON.stringify({ type: 'message:read', messageId: 'req-2' }));
  await until(() => statusOf(them, 'req-2').includes('read'), 'read reaches them after accepting');
  them.close();
  mine.close();
});

test('replying accepts the request; a chat I start is never one', async () => {
  const stranger = await register('mr_writer');
  const me = await register('mr_replier');
  const them = await connect(stranger);
  const mine = await connect(me);
  them.send(JSON.stringify({ type: 'message:send', message: { id: 'rp-1', receiverId: me.user.id, content: 'hello?' } }));
  await until(() => mine.events.find((event) => event.type === 'message:new' && event.message.id === 'rp-1'), 'arrives');
  mine.send(JSON.stringify({ type: 'message:send', message: { id: 'rp-2', receiverId: stranger.user.id, content: 'hi!' } }));
  await until(() => mine.events.find((event) => event.type === 'contact:accepted' && event.userId === stranger.user.id), 'replying accepted');
  them.send(JSON.stringify({ type: 'message:send', message: { id: 'rp-3', receiverId: me.user.id, content: 'great' } }));
  await until(() => mine.events.find((event) => event.type === 'message:new' && event.message.id === 'rp-3'), 'third');
  mine.send(JSON.stringify({ type: 'message:delivered', messageIds: ['rp-3'] }));
  await until(() => statusOf(them, 'rp-3').includes('delivered'), 'delivered after replying');
  // They started the chat, so it was never a request for them: my reply gets its ticks.
  them.send(JSON.stringify({ type: 'message:delivered', messageIds: ['rp-2'] }));
  await until(() => statusOf(mine, 'rp-2').includes('delivered'), 'they started the chat, so my reply gets its ticks');
  them.close();
  mine.close();
});

test('saving them (Add to contacts) accepts too', async () => {
  const stranger = await register('mr_saved');
  const me = await register('mr_saver');
  const them = await connect(stranger);
  them.send(JSON.stringify({ type: 'message:send', message: { id: 'sv-1', receiverId: me.user.id, content: 'yo' } }));
  await until(() => them.events.find((event) => event.type === 'message:ack'), 'sent');
  await api(`/api/v1/contacts/${stranger.user.id}/name`, { token: me.token, method: 'PUT', body: { name: 'Gym friend' } });
  assert.equal((await api('/api/v1/contacts', { token: me.token })).body.find((row) => row.id === stranger.user.id).accepted, true);
  them.close();
});

test('the app: which chats are requests and whose receipts wait', () => {
  assert.equal(isMessageRequest({ id: 'a', accepted: false }), true);
  assert.equal(isMessageRequest({ id: 'a', accepted: false, saved: true }), false);
  assert.equal(isMessageRequest({ id: 'a', accepted: false, alias: 'Rana' }), false);
  assert.equal(isMessageRequest({ id: 'a' }), false, 'chats from before message requests');
  assert.equal(isMessageRequest({ id: 'g', accepted: false, group: true }), false);
  assert.equal(holdsReceipts('a', [{ id: 'a', accepted: false }]), true);
  assert.equal(holdsReceipts('b', [{ id: 'b', accepted: true }]), false);
  assert.equal(holdsReceipts('new', []), true, 'someone not in my lists yet (a first message over XMPP)');
});

test('calls: the offer leaves sooner, the ring time is split, and a hidden video call pauses its camera instead of freezing', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const engine = read('src/callEngine.js');
  assert.equal((engine.match(/const \[stream\] = await Promise\.all\(\[captureLocal\(state\.mode\), ensureConnection\(\)\]\);/g) ?? []).length, 1, 'answering: camera and connection setup overlap');
  // Calling: the offer (what rings the other phone) leaves before the microphone / camera are open; they fill its slots.
  assert.match(engine, /const capture = captureLocal\(state\.mode\);[\s\S]{0,120}await ensureConnection\(\);[\s\S]{0,200}const slots = openSlots\(state\.mode\);\s+const offered = negotiate\(\);\s+const stream = await capture;\s+await fillSlots\(slots, stream\);/, 'calling: offer first, media after');
  assert.ok(engine.includes('if (signal.ring && !ringDetail) ringDetail = signal.ring;'));
  const overlay = read('src/components/CallOverlay.jsx');
  assert.match(overlay, /if \(iceCache && iceCache\.token === sessionToken && Date\.now\(\) - iceCache\.at < ICE_CACHE_MS\) return iceCache\.servers;/);
  assert.match(overlay, /if \(pageHidden && !pipActive\) \{[\s\S]{0,400}engine\.setCameraOff\(true\)/, 'hidden without the floating window: camera off');
  assert.match(overlay, /if \(autoPausedRef\.current\) \{\s+autoPausedRef\.current = false;\s+allEngines\(\)\.forEach\(\(engine\) => engine\.setCameraOff\(false\)\);/, 'back: only the camera this screen paused comes back');
  assert.ok(read('src/App.jsx').includes('prefetchIceServers(sessionToken)'));
  const server = read('server/index.mjs');
  assert.ok(server.includes("signal: { type: 'ringing', ring: ringDetail(activeCall, 'push') }") && server.includes("ringDetail(activeCall, 'socket')"));
});
