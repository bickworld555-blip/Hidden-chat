import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createChatServer } from './index.mjs';
import { FORWARD_LIMIT, forwardSections } from '../src/forwarding.js';
import { quoteView, replyQuoteFor } from '../src/replies.js';
import { orderChatsByActivity, useChatStore } from '../src/store.js';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const mediaDir = join(appDir, '.data', 'media');

let service;
let directory;
let baseUrl;
let createdMedia;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-ux-test-'));
  service = createChatServer({ port: 0, databasePath: join(directory, 'test.sqlite') });
  const address = await service.listen();
  baseUrl = `http://127.0.0.1:${address.port}`;
  createdMedia = [];
});

afterEach(async () => {
  await service?.close();
  for (const id of createdMedia) rmSync(join(mediaDir, `${id}.blob`), { force: true });
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

function send(socket, message) {
  socket.send(JSON.stringify({ type: 'message:send', message }));
}

async function history(session, peerId) {
  const response = await fetch(`${baseUrl}/api/v1/messages?peerId=${peerId}`, { headers: authHeaders(session) });
  assert.equal(response.status, 200);
  return response.json();
}

async function upload(sender, receiver, name, body) {
  const response = await fetch(`${baseUrl}/api/v1/media?receiverId=${receiver.user.id}`, {
    method: 'POST',
    headers: { ...authHeaders(sender), 'Content-Type': 'image/png', 'X-File-Name': encodeURIComponent(name) },
    body,
  });
  assert.equal(response.status, 201);
  const stored = await response.json();
  createdMedia.push(stored.id);
  return stored;
}

// --- Chat list ordering -----------------------------------------------------

test('chats are ordered by latest activity, unknown activity last in original order', () => {
  const ordered = orderChatsByActivity([
    { id: 'a' },
    { id: 'old', lastActivityAt: '2026-01-01T00:00:00Z' },
    { id: 'b', lastActivityAt: 'not a date' },
    { id: 'new', lastActivityAt: '2026-03-01T00:00:00Z' },
    { id: 'mid', lastActivityAt: '2026-02-01T00:00:00Z' },
  ]);
  assert.deepEqual(ordered.map((chat) => chat.id), ['new', 'mid', 'old', 'a', 'b']);
});

test('sending or receiving a message moves that chat to the top with a fresh preview', () => {
  const store = useChatStore;
  store.setState({
    userId: 'me',
    messages: {
      alpha: [{ id: 'a1', senderId: 'alpha', receiverId: 'me', timestamp: '2026-01-03T00:00:00Z', content: 'hi', status: 'read' }],
      beta: [{ id: 'b1', senderId: 'me', receiverId: 'beta', timestamp: '2026-01-02T00:00:00Z', content: 'yo', status: 'read' }],
    },
    chats: [],
  });
  store.getState().setContacts([{ id: 'beta', name: 'Beta' }, { id: 'gamma', name: 'Gamma' }, { id: 'alpha', name: 'Alpha' }]);
  assert.deepEqual(store.getState().chats.map((chat) => chat.id), ['alpha', 'beta', 'gamma']);

  store.getState().addMessage({ id: 'b2', senderId: 'me', receiverId: 'beta', timestamp: '2026-01-04T00:00:00Z', content: 'outgoing', status: 'sent' });
  assert.deepEqual(store.getState().chats.map((chat) => chat.id), ['beta', 'alpha', 'gamma']);
  assert.equal(store.getState().chats[0].preview, 'outgoing');

  store.getState().addMessage({ id: 'g1', senderId: 'gamma', receiverId: 'me', timestamp: '2026-01-05T00:00:00Z', content: 'incoming', status: 'delivered' });
  assert.deepEqual(store.getState().chats.map((chat) => chat.id), ['gamma', 'beta', 'alpha']);

  store.getState().mergeHistory('alpha', [{ id: 'a2', senderId: 'alpha', receiverId: 'me', timestamp: '2026-01-06T00:00:00Z', content: 'synced', status: 'delivered' }]);
  assert.deepEqual(store.getState().chats.map((chat) => chat.id), ['alpha', 'gamma', 'beta']);
  assert.equal(store.getState().chats[0].preview, 'synced');

  // An out-of-order (older) delivery must not bump the chat above newer conversations.
  store.getState().addMessage({ id: 'b0', senderId: 'beta', receiverId: 'me', timestamp: '2026-01-01T00:00:00Z', content: 'late', status: 'delivered' });
  assert.deepEqual(store.getState().chats.map((chat) => chat.id), ['alpha', 'gamma', 'beta']);
});

// --- Forward sheet sections ---------------------------------------------------

test('forward sheet groups chats into frequently contacted, recent, and other contacts', () => {
  const chats = [
    { id: 'c1', name: 'Cara', username: 'cara', lastActivityAt: '2026-01-09T00:00:00Z' },
    { id: 'c2', name: 'Dev', username: 'dev', lastActivityAt: '2026-01-08T00:00:00Z' },
    { id: 'c3', name: 'Eli', username: 'eli', lastActivityAt: '2026-01-07T00:00:00Z' },
    { id: 'c4', name: 'Fay', username: 'fay', lastActivityAt: '2026-01-06T00:00:00Z' },
    { id: 'c5', name: 'Gus', username: 'gus', lastActivityAt: '2026-01-05T00:00:00Z' },
    { id: 'c6', name: 'Hal', username: 'hal' },
  ];
  const outgoing = (to, count) => Array.from({ length: count }, (_, index) => ({ id: `${to}-${index}`, senderId: 'me', receiverId: to, content: 'x' }));
  const messages = {
    c2: outgoing('c2', 5),
    c4: outgoing('c4', 3),
    c5: [...outgoing('c5', 1), { id: 'call', senderId: 'me', receiverId: 'c5', content: 'call:{}' }],
    c3: [{ id: 'in', senderId: 'c3', receiverId: 'me', content: 'only incoming' }],
  };

  const sections = forwardSections(chats, messages, 'me', '');
  assert.deepEqual(sections.map((section) => section.title), ['Frequently contacted', 'Recent chats', 'Other contacts']);
  assert.deepEqual(sections[0].chats.map((chat) => chat.id), ['c2', 'c4', 'c5']);
  assert.deepEqual(sections[1].chats.map((chat) => chat.id), ['c1', 'c3']);
  assert.deepEqual(sections[2].chats.map((chat) => chat.id), ['c6']);
  const all = sections.flatMap((section) => section.chats.map((chat) => chat.id));
  assert.equal(new Set(all).size, all.length, 'a chat appears in only one section');

  const searched = forwardSections(chats, messages, 'me', '@DE');
  assert.deepEqual(searched.flatMap((section) => section.chats.map((chat) => chat.id)), ['c2']);
  assert.deepEqual(forwardSections(chats, messages, 'me', 'nobody'), []);
  assert.deepEqual(forwardSections([{ id: 'me', name: 'Self' }], {}, 'me', ''), [], 'you never forward to yourself');
  assert.equal(FORWARD_LIMIT, 5);
});

// --- Reply quotes -----------------------------------------------------------

test('reply quotes carry only the reference and render sender and preview', () => {
  const quote = replyQuoteFor({ id: 'm1', senderId: 'peer', content: 'media:abc:holiday.jpg', status: 'read', reactions: {} });
  assert.deepEqual(quote, { id: 'm1', senderId: 'peer', content: 'media:abc:holiday.jpg' });
  assert.deepEqual(quoteView(quote, 'me', 'Ava'), { sender: 'Ava', text: '📷 Photo', self: false });
  assert.deepEqual(quoteView({ id: 'm2', senderId: 'me', content: 'hello' }, 'me', 'Ava'), { sender: 'You', text: 'hello', self: true });
  assert.deepEqual(quoteView({ id: 'm3', senderId: 'peer', deleted: true }, 'me', 'Ava'), { sender: 'Ava', text: '🚫 This message was deleted', self: false });
  assert.deepEqual(quoteView({ id: 'm4', senderName: 'You', content: 'legacy local quote' }, 'me', 'Ava'), { sender: 'You', text: 'legacy local quote', self: true });
  assert.equal(quoteView(null, 'me', 'Ava'), null);
});

test('replies reach the recipient with the quoted message, and deleted quotes are tombstoned', async () => {
  const ava = await createSession('replyava');
  const jordan = await createSession('replyjordan');
  const avaSocket = await connect(ava);
  const jordanSocket = await connect(jordan);

  send(avaSocket, { id: 'orig', receiverId: jordan.user.id, content: 'Lunch at noon?' });
  await waitFor(jordanSocket, 'message:new', (event) => event.message.id === 'orig');

  send(jordanSocket, { id: 'reply', receiverId: ava.user.id, content: 'Sounds good', replyTo: { id: 'orig', senderId: ava.user.id, content: 'spoofed text' } });
  const received = await waitFor(avaSocket, 'message:new', (event) => event.message.id === 'reply');
  assert.deepEqual(received.message.replyTo, { id: 'orig', senderId: ava.user.id, content: 'Lunch at noon?' });
  assert.equal(received.message.replyToId, undefined);
  assert.equal(received.message.forwarded, undefined);
  const ack = await waitFor(jordanSocket, 'message:ack', (event) => event.message.id === 'reply');
  assert.equal(ack.message.replyTo.id, 'orig');

  avaSocket.send(JSON.stringify({ type: 'message:delete', messageId: 'orig', scope: 'everyone' }));
  await waitFor(jordanSocket, 'message:deleted');
  const reply = (await history(jordan, ava.user.id)).find((message) => message.id === 'reply');
  assert.deepEqual(reply.replyTo, { id: 'orig', senderId: ava.user.id, deleted: true });

  avaSocket.close();
  jordanSocket.close();
});

test('a reply to a message from another conversation is sent without the quote', async () => {
  const ava = await createSession('leakava');
  const jordan = await createSession('leakjordan');
  const sam = await createSession('leaksam');
  const avaSocket = await connect(ava);
  const jordanSocket = await connect(jordan);
  const samSocket = await connect(sam);

  send(avaSocket, { id: 'private', receiverId: jordan.user.id, content: 'secret plans' });
  await waitFor(jordanSocket, 'message:new', (event) => event.message.id === 'private');

  send(samSocket, { id: 'probe', receiverId: ava.user.id, content: 'hey', replyTo: { id: 'private' } });
  const received = await waitFor(avaSocket, 'message:new', (event) => event.message.id === 'probe');
  assert.equal(received.message.replyTo, undefined);
  assert.equal(received.message.content, 'hey');

  for (const socket of [avaSocket, jordanSocket, samSocket]) socket.close();
});

// --- Forwarding ---------------------------------------------------------------

test('forwarded text and media reach a third person who can download the file', async () => {
  const ava = await createSession('fwdava');
  const jordan = await createSession('fwdjordan');
  const sam = await createSession('fwdsam');
  const avaSocket = await connect(ava);
  const jordanSocket = await connect(jordan);
  const samSocket = await connect(sam);
  const bytes = Buffer.from([137, 80, 78, 71, 1, 2, 3, 4]);
  const stored = await upload(ava, jordan, 'beach.png', bytes);

  send(avaSocket, { id: 'photo', receiverId: jordan.user.id, content: `media:${stored.id}:beach.png` });
  await waitFor(jordanSocket, 'message:new', (event) => event.message.id === 'photo');

  send(jordanSocket, { id: 'fwd-text', receiverId: sam.user.id, content: 'look at this', forwarded: true });
  const text = await waitFor(samSocket, 'message:new', (event) => event.message.id === 'fwd-text');
  assert.equal(text.message.forwarded, true);

  send(jordanSocket, { id: 'fwd-photo', receiverId: sam.user.id, content: `media:${stored.id}:beach.png`, forwarded: true });
  const photo = await waitFor(samSocket, 'message:new', (event) => event.message.id === 'fwd-photo');
  const [, copyId, filename] = photo.message.content.split(':');
  createdMedia.push(copyId);
  assert.notEqual(copyId, stored.id, 'the recipient gets their own copy');
  assert.equal(filename, 'beach.png');
  assert.equal(photo.message.forwarded, true);
  const ack = await waitFor(jordanSocket, 'message:ack', (event) => event.message.id === 'fwd-photo');
  assert.equal(ack.message.content, photo.message.content, 'the sender learns the copy id');

  const download = await fetch(`${baseUrl}/api/v1/media/${copyId}`, { headers: authHeaders(sam) });
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);

  // Ava deleting her original for everyone leaves the forwarded copy intact.
  avaSocket.send(JSON.stringify({ type: 'message:delete', messageId: 'photo', scope: 'everyone' }));
  await waitFor(avaSocket, 'message:deleted');
  const after = await fetch(`${baseUrl}/api/v1/media/${copyId}`, { headers: authHeaders(sam) });
  assert.equal(after.status, 200);
  assert.deepEqual(Buffer.from(await after.arrayBuffer()), bytes);

  for (const socket of [avaSocket, jordanSocket, samSocket]) socket.close();
});

test('media from a conversation you are not part of cannot be forwarded', async () => {
  const ava = await createSession('denyava');
  const jordan = await createSession('denyjordan');
  const sam = await createSession('denysam');
  const samSocket = await connect(sam);
  const stored = await upload(ava, jordan, 'private.png', Buffer.from([1, 2, 3]));

  send(samSocket, { id: 'steal', receiverId: ava.user.id, content: `media:${stored.id}:private.png`, forwarded: true });
  await waitFor(samSocket, 'error');
  assert.equal((await history(ava, sam.user.id)).length, 0);
  samSocket.close();
});

// --- UI wiring contracts ----------------------------------------------------------

test('chat window wires swipe-to-reply, quotes, and the sectioned forward sheet', () => {
  const source = readFileSync(join(appDir, 'src', 'components', 'ChatWindow.jsx'), 'utf8');
  const css = readFileSync(join(appDir, 'src', 'styles.css'), 'utf8');
  for (const needle of [
    'onPointerDown={handlePointerDown}',
    'swipeReply?.(message)',
    'onSwipeReply={message.content?.startsWith(\'call:\') || message.deleted ? null : stableStartReply}',
    'quote={quoteView(resolveQuote(message.replyTo, messages), userId, chat.name)}',
    'onQuoteClick={stableShowInChat}',
    'composerInputRef.current?.focus()',
    'sendToChat(target.id, source.content, { forwarded: true })',
    "transmitDirect(client, { id: message.id, receiverId, content, ...extras, ...(linkPreview ? { linkPreview } : {}) })",
    'onSend={handleForwardMessage}',
    'forwardSections(',
  ]) {
    assert.ok(source.includes(needle), `ChatWindow.jsx is missing ${needle}`);
  }
  for (const selector of ['.swipe-reply-icon', '.message-line.swipe-armed', '--swipe-x', '.wa-forward-sheet', '.wa-forward-section h4', '.wa-forward-check', '.wa-forward-send', '.wa-forwarded-label', 'button.wa-quoted-reply-preview']) {
    assert.ok(css.includes(selector), `styles.css is missing ${selector}`);
  }
  assert.ok(!css.includes('.wa-forward-picker'), 'the superseded forward picker styles are removed');
});

test('a status reply\'s card and chat-list line say whose status it was, as on WhatsApp', async () => {
  const { statusQuoteView } = await import('../src/replies.js');
  // They replied to my text status.
  const theirs = statusQuoteView({ kind: 'text', text: 'Beach day', bg: '#7e57c2' }, { mine: false, peerName: 'Ava', content: 'Looks great!' });
  assert.equal(theirs.title, 'You · Status');
  assert.equal(theirs.text, 'Beach day');
  assert.equal(theirs.background, '#7e57c2');
  assert.equal(theirs.listLabel, 'Replied to your status');
  assert.equal(theirs.listText, 'Looks great!');
  // I reacted to their photo status.
  const mine = statusQuoteView({ kind: 'image', text: '', reaction: true }, { mine: true, peerName: 'Ava', content: '😍' });
  assert.equal(mine.title, 'Ava · Status');
  assert.equal(mine.text, '📷 Photo');
  assert.equal(mine.background, null);
  assert.equal(mine.listLabel, 'You reacted 😍 to their status');
  assert.equal(mine.listText, '');
  assert.equal(statusQuoteView({ kind: 'text', text: '', bg: 'red; x' }, {}).background, null, 'only a plain colour is used');
  assert.equal(statusQuoteView(null), null);
});

test('the chat list knows when the last message was a status reply, and forgets when it is not', async () => {
  const { useChatStore } = await import('../src/store.js');
  useChatStore.setState({ userId: 'me', chats: [{ id: 'ava', name: 'Ava' }], messages: {} });
  const { addMessage } = useChatStore.getState();
  addMessage({ id: 's1', senderId: 'ava', receiverId: 'me', timestamp: '2026-11-13T10:00:00.000Z', content: '😍', statusReply: { kind: 'text', text: 'Hi', reaction: true } });
  assert.deepEqual(useChatStore.getState().chats.find((chat) => chat.id === 'ava').previewStatus, { kind: 'text', text: 'Hi', reaction: true, mine: false, content: '😍' });
  addMessage({ id: 's2', senderId: 'me', receiverId: 'ava', timestamp: '2026-11-13T10:01:00.000Z', content: 'thanks' });
  assert.equal(useChatStore.getState().chats.find((chat) => chat.id === 'ava').previewStatus, null);
});

test('a status reply carries the status colour inside the encryption, and nothing else', async () => {
  const { innerOf, openedFrom } = await import('../src/e2e/client.js');
  const inner = innerOf('Nice', { statusReply: { kind: 'text', text: 'Hi', bg: '#7e57c2', extra: 'dropped' } });
  assert.deepEqual(inner.sr, { kind: 'text', text: 'Hi', bg: '#7e57c2' });
  assert.deepEqual(openedFrom(inner, {}).statusReply, { kind: 'text', text: 'Hi', bg: '#7e57c2' });
  assert.equal(innerOf('x', { statusReply: { kind: 'text', text: '', bg: 'url(x)' } }).sr.bg, undefined);
});
