// WhatsApp-style cards in the chat: "You deleted this message" placeholders for messages deleted for everyone,
// call cards with duration and time, and the Android floating video window filling its whole window.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createChatServer } from './index.mjs';
import { useChatStore } from '../src/store.js';
import { callCardView, callDurationLabel } from '../src/callCard.js';

const PASSWORD = 'Correct-Horse-Battery-42!';
const root = new URL('../', import.meta.url);
const source = (path) => readFile(new URL(path, root), 'utf8');
let service;
let directory;
let baseUrl;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-cards-'));
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
  return { status: response.status, data: await response.json().catch(() => null) };
}

async function register(username) {
  const { status, data } = await api('/api/v1/auth/register', { method: 'POST', body: { username, dob: '1990-04-12', password: PASSWORD } });
  assert.equal(status, 201);
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

test('a message deleted for everyone stays in both histories as a placeholder with no content', async () => {
  const sender = await register('delsender');
  const receiver = await register('delreceiver');
  const senderSocket = await connect(sender);
  const receiverSocket = await connect(receiver);
  senderSocket.send(JSON.stringify({ type: 'message:send', message: { id: 'del-1', receiverId: receiver.user.id, content: 'Oops, wrong chat' } }));
  senderSocket.send(JSON.stringify({ type: 'message:send', message: { id: 'del-2', receiverId: receiver.user.id, content: 'Still here' } }));
  await receiverSocket.wait('message:new', (event) => event.message.id === 'del-2');
  senderSocket.send(JSON.stringify({ type: 'message:delete', messageId: 'del-1', scope: 'everyone' }));
  const event = await receiverSocket.wait('message:deleted', (item) => item.messageId === 'del-1');
  assert.equal(event.scope, 'everyone');
  assert.equal(event.reason, undefined, 'not a disappearing-message expiry');

  for (const [session, peer] of [[sender, receiver], [receiver, sender]]) {
    const { data } = await api(`/api/v1/messages?peerId=${peer.user.id}`, { session });
    const deleted = data.find((message) => message.id === 'del-1');
    assert.deepEqual([deleted.deleted, deleted.expired, deleted.content], [true, false, '']);
    assert.deepEqual([data.find((message) => message.id === 'del-2').deleted, data.find((message) => message.id === 'del-2').expired], [false, false]);
  }
  const { data: sync } = await api(`/api/v1/messages/sync?after=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}`, { session: receiver });
  if (Array.isArray(sync)) assert.equal(sync.find((message) => message.id === 'del-1')?.expired, false);
  senderSocket.close();
  receiverSocket.close();
});

test('the store turns a deleted message into WhatsApp\'s placeholder and drops messages that disappeared', () => {
  const store = useChatStore;
  store.setState({
    userId: 'me',
    messages: {
      ava: [
        { id: 'm1', senderId: 'me', receiverId: 'ava', timestamp: '2026-11-09T10:00:00Z', content: 'media:abc:photo.jpg', status: 'read', starred: true, reactions: [{ userId: 'ava', emoji: '❤️' }] },
        { id: 'm2', senderId: 'ava', receiverId: 'me', timestamp: '2026-11-09T10:01:00Z', content: 'secret', status: 'delivered' },
        { id: 'm3', senderId: 'ava', receiverId: 'me', timestamp: '2026-11-09T10:02:00Z', content: 'gone soon', status: 'read' },
      ],
    },
    chats: [{ id: 'ava', name: 'Ava', unread: 1 }],
  });
  store.getState().markMessageDeleted('m1');
  const placeholder = store.getState().messages.ava[0];
  assert.deepEqual([placeholder.deleted, placeholder.content, placeholder.starred, placeholder.reactions], [true, '', undefined, undefined]);

  // The other side deletes their last message: the chat list reads "🚫 This message was deleted", and it no longer counts as unread.
  store.getState().mergeHistory('ava', [
    { id: 'm2', senderId: 'ava', receiverId: 'me', timestamp: '2026-11-09T10:01:00Z', content: '', status: 'delivered', deleted: true, expired: false },
    { id: 'm3', senderId: 'ava', receiverId: 'me', timestamp: '2026-11-09T10:02:00Z', content: '', status: 'read', deleted: true, expired: true },
  ]);
  const messages = store.getState().messages.ava;
  assert.deepEqual(messages.map((message) => message.id), ['m1', 'm2'], 'a disappeared message is removed, a deleted one stays');
  assert.equal(messages[1].content, '');
  assert.equal(store.getState().chats[0].preview, '🚫 This message was deleted');
  assert.equal(store.getState().chats[0].unread, 0);

  store.getState().markMessageDeleted('m2');
  store.getState().addMessage({ id: 'm4', senderId: 'me', receiverId: 'ava', timestamp: '2026-11-09T10:03:00Z', content: 'hello', status: 'sent' });
  store.getState().markMessageDeleted('m4');
  assert.equal(store.getState().chats[0].preview, '🚫 You deleted this message');
  store.setState({ userId: null }); // signed out: the pending save to this device's storage is skipped
});

test('the deleted bubble shows the prohibited sign with WhatsApp\'s wording; the app keeps placeholders for everyone-deletes', async () => {
  const chat = await source('src/components/ChatWindow.jsx');
  assert.ok(chat.includes('<p className="deleted-text"><Ban size={15} aria-hidden="true" /><span>{deletedLabel(mine)}</span></p>'));
  const app = await source('src/App.jsx');
  assert.ok(app.includes("if (event.scope === 'everyone' && event.reason !== 'expired') useChatStore.getState().markMessageDeleted(event.messageId);"));
});

test('call cards read like WhatsApp\'s: duration, No answer, missed calls', () => {
  assert.equal(callDurationLabel(1), '1 sec');
  assert.equal(callDurationLabel(45), '45 secs');
  assert.equal(callDurationLabel(60), '1 min');
  assert.equal(callDurationLabel(12 * 60 + 30), '12 mins');
  assert.equal(callDurationLabel(3600), '1 hr');
  assert.equal(callDurationLabel(3600 + 5 * 60), '1 hr 5 mins');
  assert.deepEqual(callCardView({ mode: 'audio', status: 'completed', duration: 754 }, true), { title: 'Voice call', detail: '12 mins', missed: false, answered: true, video: false });
  assert.deepEqual(callCardView({ mode: 'video', status: 'no-answer', duration: 0 }, true), { title: 'Video call', detail: 'No answer', missed: false, answered: false, video: true });
  assert.deepEqual(callCardView({ mode: 'audio', status: 'missed', duration: 0 }, false), { title: 'Missed voice call', detail: 'Tap to call back', missed: true, answered: false, video: false });
  assert.equal(callCardView({ mode: 'video', status: 'completed', duration: 8 }, false).title, 'Video call');
});

test('Android floating video window: the call fills the whole window, and Back opens it like Home', async () => {
  const css = await source('src/styles.css');
  assert.ok(css.includes('@media (max-width: 319px) { body { min-width: 0; } }'), 'no 320px minimum that makes the WebView zoom out');
  assert.match(css, /html\.native-pip \.wa-call-backdrop, html\.native-pip \.wa-call-backdrop\.is-pip \{ position: fixed !important; inset: 0 !important; width: auto !important; height: auto !important;/);
  assert.match(css, /html\.native-pip \.wa-call-screen, html\.native-pip \.wa-call-backdrop\.is-pip \.wa-call-screen \{ width: 100% !important; height: 100% !important;/);
  assert.ok(!/html\.native-pip[^{]*\{[^}]*100v[wh]/.test(css), 'viewport units are the PiP window, not the zoomed page');
});
