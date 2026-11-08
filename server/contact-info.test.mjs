import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createChatServer } from './index.mjs';
import { endBlock, hiddenByBlock, isBlocked, startBlock } from '../src/blocking.js';
import { CHAT_THEMES, exportChatText, exportFilename, searchMessages, sharedContent } from '../src/contactInfo.js';
import { DISAPPEARING_OPTIONS, disappearingLabel, isDisappearingDuration } from '../src/disappearing.js';
import { useChatStore } from '../src/store.js';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(appDir, path), 'utf8').replace(/\r\n/g, '\n');
const DAY = 24 * 60 * 60;

let service;
let directory;
let baseUrl;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-contact-info-test-'));
  service = createChatServer({ port: 0, databasePath: join(directory, 'test.sqlite') });
  const address = await service.listen();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

function authHeaders(session) {
  return { Authorization: 'Bearer ' + session.token };
}

async function createSession(username) {
  const response = await fetch(`${baseUrl}/api/v1/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, dob: '1990-04-12', password: 'Correct-Horse-Battery-42!' }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

async function connect(session) {
  const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/ws', [`relay.auth.${session.token}`, 'relay.v1']);
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

async function sendAndAck(socket, message) {
  socket.send(JSON.stringify({ type: 'message:send', message }));
  return (await waitFor(socket, 'message:ack', (event) => event.message.id === message.id)).message;
}

async function history(session, peerId) {
  const response = await fetch(`${baseUrl}/api/v1/messages?peerId=${peerId}`, { headers: authHeaders(session) });
  assert.equal(response.status, 200);
  return response.json();
}

async function contacts(session) {
  const response = await fetch(`${baseUrl}/api/v1/contacts`, { headers: authHeaders(session) });
  assert.equal(response.status, 200);
  return response.json();
}

function chatAction(session, peerId, action, body = {}) {
  return fetch(`${baseUrl}/api/v1/chats/${peerId}/${action}`, {
    method: 'POST',
    headers: { ...authHeaders(session), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function pair() {
  const alice = await createSession('alice_info');
  const bob = await createSession('bob_info');
  const aliceSocket = await connect(alice);
  const bobSocket = await connect(bob);
  return { alice, bob, aliceSocket, bobSocket, close() { aliceSocket.close(); bobSocket.close(); } };
}

// --- Disappearing messages ---------------------------------------------------

test('disappearing timer is shared by both people and stamps an expiry on new messages', async () => {
  const { alice, bob, aliceSocket, bobSocket, close } = await pair();
  try {
    await sendAndAck(aliceSocket, { id: 'before-timer', receiverId: bob.user.id, content: 'sent before the timer' });

    aliceSocket.send(JSON.stringify({ type: 'chat:disappearing', peerId: bob.user.id, seconds: DAY }));
    const own = await waitFor(aliceSocket, 'chat:disappearing');
    const peer = await waitFor(bobSocket, 'chat:disappearing');
    assert.deepEqual(own, { type: 'chat:disappearing', peerId: bob.user.id, seconds: DAY, updatedBy: alice.user.id });
    assert.deepEqual(peer, { type: 'chat:disappearing', peerId: alice.user.id, seconds: DAY, updatedBy: alice.user.id });
    assert.equal((await contacts(alice)).find((contact) => contact.id === bob.user.id).disappearSeconds, DAY);
    assert.equal((await contacts(bob)).find((contact) => contact.id === alice.user.id).disappearSeconds, DAY);

    const sentAt = Date.now();
    const reply = await sendAndAck(bobSocket, { id: 'timed', receiverId: alice.user.id, content: 'gone tomorrow' });
    const expiresIn = Date.parse(reply.expiresAt) - sentAt;
    assert.ok(expiresIn > (DAY - 5) * 1000 && expiresIn <= (DAY + 5) * 1000, `expiry ${expiresIn}ms`);
    const stored = await history(alice, bob.user.id);
    assert.equal(stored.find((message) => message.id === 'before-timer').expiresAt, undefined);
    assert.equal(stored.find((message) => message.id === 'timed').expiresAt, reply.expiresAt);

    bobSocket.send(JSON.stringify({ type: 'chat:disappearing', peerId: alice.user.id, seconds: 0 }));
    await waitFor(aliceSocket, 'chat:disappearing', (event) => event.seconds === 0);
    const untimed = await sendAndAck(aliceSocket, { id: 'after-off', receiverId: bob.user.id, content: 'stays' });
    assert.equal(untimed.expiresAt, undefined);
  } finally {
    close();
  }
});

test('disappearing timer rejects unsupported durations and unrelated users', async () => {
  const { bob, aliceSocket, close } = await pair();
  const stranger = await createSession('stranger_info');
  try {
    aliceSocket.send(JSON.stringify({ type: 'chat:disappearing', peerId: bob.user.id, seconds: 3600 }));
    await waitFor(aliceSocket, 'error', (event) => /Disappearing/.test(event.message));
    aliceSocket.send(JSON.stringify({ type: 'chat:disappearing', peerId: stranger.user.id, seconds: DAY }));
    await waitFor(aliceSocket, 'error', (event) => /Disappearing/.test(event.message));
    assert.equal(aliceSocket.eventBuffer.some((event) => event.type === 'chat:disappearing'), false);
  } finally {
    close();
  }
});

test('expired messages are deleted for both people and become tombstones in history', async () => {
  const { alice, bob, aliceSocket, bobSocket, close } = await pair();
  try {
    await sendAndAck(aliceSocket, { id: 'link', receiverId: bob.user.id, content: 'hi' });
    aliceSocket.send(JSON.stringify({ type: 'chat:disappearing', peerId: bob.user.id, seconds: DAY }));
    await waitFor(bobSocket, 'chat:disappearing');
    const timed = await sendAndAck(aliceSocket, { id: 'expiring', receiverId: bob.user.id, content: 'secret' });
    await waitFor(bobSocket, 'message:new', (event) => event.message.id === 'expiring');

    assert.equal(await service.expireMessages(Date.parse(timed.expiresAt) - 1000), 0);
    assert.equal(await service.expireMessages(Date.parse(timed.expiresAt) + 1), 1);
    for (const socket of [aliceSocket, bobSocket]) {
      const event = await waitFor(socket, 'message:deleted', (item) => item.messageId === 'expiring');
      assert.equal(event.scope, 'everyone');
    }
    const tombstone = (await history(bob, alice.user.id)).find((message) => message.id === 'expiring');
    assert.equal(tombstone.deleted, true);
    assert.equal(tombstone.content, '');
  } finally {
    close();
  }
});

// --- Clear chat / delete chat ---------------------------------------------------

test('clear chat hides messages for the requester only and keeps the requested ids', async () => {
  const { alice, bob, aliceSocket, bobSocket, close } = await pair();
  try {
    for (const id of ['m1', 'm2', 'm3']) await sendAndAck(aliceSocket, { id, receiverId: bob.user.id, content: id });
    const response = await chatAction(alice, bob.user.id, 'clear', { keepIds: ['m2'] });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { hidden: 2 });
    assert.deepEqual(await waitFor(aliceSocket, 'chat:cleared'), { type: 'chat:cleared', peerId: bob.user.id, keepIds: ['m2'] });
    assert.deepEqual((await history(alice, bob.user.id)).map((message) => message.id), ['m2']);
    assert.deepEqual((await history(bob, alice.user.id)).map((message) => message.id), ['m1', 'm2', 'm3']);
    assert.equal(bobSocket.eventBuffer.some((event) => event.type === 'chat:cleared'), false);

    assert.equal((await chatAction(alice, bob.user.id, 'clear', { keepIds: 'm2' })).status, 400);
    assert.equal((await chatAction(alice, bob.user.id, 'clear', { keepIds: Array.from({ length: 501 }, (_, i) => `k${i}`) })).status, 400);
    assert.equal((await chatAction(alice, alice.user.id, 'clear')).status, 400);
  } finally {
    close();
  }
});

test('delete chat removes it from the chat list until a new message arrives', async () => {
  const { alice, bob, aliceSocket, bobSocket, close } = await pair();
  try {
    await sendAndAck(aliceSocket, { id: 'old', receiverId: bob.user.id, content: 'old news' });
    const response = await chatAction(alice, bob.user.id, 'delete');
    assert.equal(response.status, 200);
    await waitFor(aliceSocket, 'chat:deleted', (event) => event.peerId === bob.user.id);
    assert.equal((await contacts(alice)).some((contact) => contact.id === bob.user.id), false);
    assert.deepEqual(await history(alice, bob.user.id), []);
    assert.equal((await contacts(bob)).some((contact) => contact.id === alice.user.id), true);

    await sendAndAck(bobSocket, { id: 'new', receiverId: alice.user.id, content: 'hello again' });
    assert.equal((await contacts(alice)).some((contact) => contact.id === bob.user.id), true);
    assert.deepEqual((await history(alice, bob.user.id)).map((message) => message.id), ['new']);
  } finally {
    close();
  }
});

// --- Pure helpers -----------------------------------------------------------------

test('disappearing options match WhatsApp and are the only accepted durations', () => {
  assert.deepEqual(DISAPPEARING_OPTIONS.map((option) => option.label), ['24 hours', '7 days', '90 days', 'Off']);
  assert.equal(isDisappearingDuration(7 * DAY), true);
  assert.equal(isDisappearingDuration(3600), false);
  assert.equal(isDisappearingDuration('86400'), false);
  assert.equal(disappearingLabel(90 * DAY), '90 days');
  assert.equal(disappearingLabel(undefined), 'Off');
});

test('block periods hide only incoming messages sent while blocked', () => {
  let periods = startBlock(undefined, '2026-01-02T00:00:00.000Z');
  assert.equal(isBlocked(periods), true);
  assert.equal(startBlock(periods, '2026-01-03T00:00:00.000Z'), periods);
  periods = endBlock(periods, '2026-01-04T00:00:00.000Z');
  assert.equal(isBlocked(periods), false);
  const from = (timestamp, senderId = 'peer') => ({ senderId, timestamp });
  assert.equal(hiddenByBlock(from('2026-01-01T12:00:00.000Z'), periods, 'me'), false);
  assert.equal(hiddenByBlock(from('2026-01-03T12:00:00.000Z'), periods, 'me'), true);
  assert.equal(hiddenByBlock(from('2026-01-03T12:00:00.000Z', 'me'), periods, 'me'), false);
  assert.equal(hiddenByBlock(from('2026-01-05T12:00:00.000Z'), periods, 'me'), false);
  assert.equal(hiddenByBlock(from('2026-01-05T12:00:00.000Z'), undefined, 'me'), false);
});

test('shared content groups media, links and docs newest first', () => {
  const messages = [
    { id: 'a', content: 'media:1:photo.jpg' },
    { id: 'b', content: 'see https://example.com/page' },
    { id: 'c', content: 'media:2:report.pdf' },
    { id: 'd', content: 'voice:3:note.webm' },
    { id: 'e', content: 'media:4:clip.mp4' },
    { id: 'f', content: 'plain text' },
  ];
  const shared = sharedContent(messages);
  assert.deepEqual(shared.media.map((message) => message.id), ['e', 'a']);
  assert.deepEqual(shared.links.map((message) => message.id), ['b']);
  assert.deepEqual(shared.docs.map((message) => message.id), ['c']);
  assert.equal(shared.total, 4);
});

test('export uses the WhatsApp text format without media', () => {
  const text = exportChatText([
    { id: '1', senderId: 'me', timestamp: '2026-06-11T18:46:00.000Z', content: 'Hello' },
    { id: '2', senderId: 'peer', timestamp: '2026-06-11T18:47:00.000Z', content: 'media:9:Plan.pdf' },
    { id: '3', senderId: 'peer', timestamp: '2026-06-11T18:48:00.000Z', content: 'call:{"mode":"video","status":"missed"}' },
    { id: '4', senderId: 'peer', timestamp: '2026-06-11T18:49:00.000Z', content: '', deleted: true },
  ], { userId: 'me', selfName: 'Sam', peerName: 'Ava' });
  const lines = text.split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2} - Sam: Hello$/);
  assert.match(lines[1], / - Ava: <attached: Plan\.pdf>$/);
  assert.match(lines[2], / - Ava: Missed video call$/);
  assert.equal(exportFilename('A/B: "C"'), 'Hidden Messenger chat with A B C.txt');
});

test('in-chat search matches text and file names but not internal payloads', () => {
  const messages = [
    { id: '1', content: 'Budget meeting' },
    { id: '2', content: 'media:1:budget.xlsx' },
    { id: '3', content: 'call:{"mode":"audio","note":"budget"}' },
    { id: '4', content: 'lunch?' },
  ];
  assert.deepEqual(searchMessages(messages, ' BUDGET '), ['1', '2']);
  assert.deepEqual(searchMessages(messages, ''), []);
});

// --- Store ------------------------------------------------------------------------

test('store hides blocked senders, clears with kept ids and tracks per-chat preferences', () => {
  const initial = useChatStore.getState();
  useChatStore.setState({
    userId: '',
    activeChatId: null,
    chats: [{ id: 'peer', name: 'Peer', unread: 0 }],
    messages: { peer: [] },
    blockedChats: {},
    favouriteChatIds: [],
    chatThemes: {},
  });
  try {
    const store = useChatStore.getState();
    const incoming = (id, timestamp) => ({ id, senderId: 'peer', receiverId: '', timestamp, content: id });
    store.addMessage(incoming('before', '2026-01-01T00:00:00.000Z'));
    useChatStore.setState({ blockedChats: { peer: startBlock(undefined, '2026-01-02T00:00:00.000Z') } });
    store.addMessage(incoming('during', '2026-01-03T00:00:00.000Z'));
    store.mergeHistory('peer', [incoming('history-during', '2026-01-03T01:00:00.000Z')]);
    assert.deepEqual(useChatStore.getState().messages.peer.map((message) => message.id), ['before']);
    assert.equal(useChatStore.getState().chats[0].unread, 1);

    store.addMessage({ id: 'mine', senderId: '', receiverId: 'peer', timestamp: '2026-01-03T02:00:00.000Z', content: 'mine' });
    store.clearChat('peer', ['before']);
    assert.deepEqual(useChatStore.getState().messages.peer.map((message) => message.id), ['before']);
    store.clearChat('peer');
    assert.deepEqual(useChatStore.getState().messages.peer, []);
    assert.equal(useChatStore.getState().chats[0].preview, 'No messages yet');

    store.toggleFavouriteChat('peer');
    store.setChatTheme('peer', 'ocean');
    store.setDisappearing('peer', DAY);
    assert.deepEqual(useChatStore.getState().favouriteChatIds, ['peer']);
    assert.deepEqual(useChatStore.getState().chatThemes, { peer: 'ocean' });
    assert.equal(useChatStore.getState().chats[0].disappearSeconds, DAY);
    store.setChatTheme('peer', 'default');
    assert.deepEqual(useChatStore.getState().chatThemes, {});
    store.deleteChat('peer');
    assert.deepEqual(useChatStore.getState().favouriteChatIds, []);
  } finally {
    useChatStore.setState(initial, true);
  }
});

// --- UI contracts -----------------------------------------------------------------

test('chat header opens the contact info drawer with WhatsApp sections and no phone number', () => {
  const chatWindow = read('src/components/ChatWindow.jsx');
  assert.ok(chatWindow.includes('onClick={() => setContactInfoOpen(true)}'));
  assert.ok(chatWindow.includes('<ContactInfoDrawer'));
  assert.ok(chatWindow.includes('contactInfoOpen);'), 'the drawer counts as a modal for selection Escape handling');
  assert.ok(chatWindow.includes('data-chat-theme={chatTheme}'));
  assert.ok(chatWindow.includes('You blocked this contact. Tap to unblock.'));

  const drawer = read('src/components/ContactInfoDrawer.jsx');
  for (const label of ['Contact info', 'Voice', 'Video', 'Search', 'Media, links and docs', 'Starred messages', 'Mute notifications',
    'Disappearing messages', 'Chat theme', 'Restricted chat', 'Add to favourites', 'Export chat', 'Clear chat', 'Delete chat']) {
    assert.ok(drawer.includes(label), `missing ${label}`);
  }
  assert.ok(drawer.includes('`Block ${name}`') && drawer.includes('`Report ${name}`'));
  assert.ok(drawer.includes('className={`wa-info-block'), 'block is a highlighted card');
  assert.equal((drawer.match(/title="(Clear chat|Delete chat)" danger/g) ?? []).length, 2);
  assert.ok(drawer.includes('`Report ${name}`} danger'));
  assert.doesNotMatch(drawer, /phone number|\.phone\b/i);
  assert.ok(drawer.includes('<small>Messages are stored on your Hidden Messenger server and are not end-to-end encrypted.</small>'));
  assert.doesNotMatch(drawer, /Messages are end-to-end encrypted/);

  const css = read('src/styles.css');
  assert.ok(css.includes('@keyframes wa-info-slide-in'));
  assert.ok(css.includes('.app-shell.dark-theme .wa-info-block'));
  assert.ok(css.includes('.app-shell.is-mobile .wa-info-drawer { width: 100%;'));
  for (const theme of CHAT_THEMES.filter((item) => item.id !== 'default')) {
    assert.ok(css.includes(`.app-shell .message-scroll[data-chat-theme="${theme.id}"]`), `missing light ${theme.id}`);
    assert.ok(css.includes(`.app-shell.dark-theme .message-scroll[data-chat-theme="${theme.id}"]`), `missing dark ${theme.id}`);
  }
});

test('muted and blocked chats stay silent and blocked contacts cannot ring', () => {
  const app = read('src/App.jsx');
  assert.ok(app.includes("if (incoming && !silenced) {\n              playNotificationTone('message');"), 'muted or blocked senders never play the message tone');
  assert.ok(app.includes("if (isBlocked(useChatStore.getState().blockedChats[event.from])) return;"));
  for (const type of ['chat:disappearing', 'chat:cleared', 'chat:deleted']) assert.ok(app.includes(`'${type}'`), type);
});
