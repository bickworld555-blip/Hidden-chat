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

test('every call is one log entry and one call card in the chat; the same call logged twice is kept once', async () => {
  const { useChatStore } = await import('../src/store.js');
  // Saving to IndexedDB is the browser's part; this checks what the store keeps.
  useChatStore.setState({ userId: 'me', chats: [{ id: 'ava', name: 'Ava' }], messages: {}, callLogs: [], persistCallLogs: async () => {} });
  const { logCall } = useChatStore.getState();
  // Five missed calls from the same person: five entries, five cards.
  for (let i = 0; i < 5; i += 1) logCall('ava', { callId: `c${i}`, mode: i % 2 ? 'video' : 'audio', status: 'missed', direction: 'incoming', timestamp: `2026-11-16T10:0${i}:00.000Z` });
  // The phone's background code reports call c4 again (it rang there too): not a sixth entry.
  logCall('ava', { callId: 'c4', mode: 'video', status: 'missed', direction: 'incoming' });
  const state = useChatStore.getState();
  assert.equal(state.callLogs.length, 5);
  assert.deepEqual(state.callLogs.map((entry) => entry.timestamp).sort().at(0), '2026-11-16T10:00:00.000Z', 'kept at the time the call happened');
  const cards = (state.messages.ava ?? []).filter((message) => message.content.startsWith('call:'));
  assert.equal(cards.length, 5);
  assert.deepEqual(cards.map((card) => JSON.parse(card.content.slice(5)).mode), ['audio', 'video', 'audio', 'video', 'audio']);
  assert.ok(cards.every((card) => card.senderId === 'ava'), 'shown as incoming');
});

test('read markers: one cumulative marker per chat over XMPP; a marker turns that message and every earlier one blue', async () => {
  const { useChatStore } = await import('../src/store.js');
  const sent = [];
  const origin = `d${'b'.repeat(40)}@h`;
  useChatStore.setState({
    userId: 'me', chats: [{ id: 'ava', name: 'Ava', unread: 3 }], callLogs: [], persistCallLogs: async () => {},
    client: { send: (event) => { sent.push(event); return true; } },
    messages: { ava: [
      { id: 'x1', senderId: 'ava', receiverId: 'me', timestamp: '2026-11-16T10:00:00.000Z', content: 'a', status: 'delivered', origin },
      { id: 'x2', senderId: 'ava', receiverId: 'me', timestamp: '2026-11-16T10:01:00.000Z', content: 'b', status: 'delivered', origin },
      { id: 's1', senderId: 'ava', receiverId: 'me', timestamp: '2026-11-16T10:02:00.000Z', content: 'c', status: 'delivered' },
      { id: 'm1', senderId: 'me', receiverId: 'ava', timestamp: '2026-11-16T09:59:00.000Z', content: 'mine 1', status: 'delivered' },
      { id: 'm2', senderId: 'me', receiverId: 'ava', timestamp: '2026-11-16T10:03:00.000Z', content: 'mine 2', status: 'delivered' },
      { id: 'm3', senderId: 'me', receiverId: 'ava', timestamp: '2026-11-16T10:04:00.000Z', content: 'mine 3', status: 'sent' },
    ] },
  });
  useChatStore.getState().readChat('ava');
  assert.deepEqual(sent, [
    { type: 'message:read', messageId: 's1' },
    { type: 'message:read', messageId: 'x2', origin, upTo: true },
  ], 'the server-path message one by one; the XMPP ones as one marker for the newest');
  useChatStore.getState().markReadThrough('m2');
  const status = Object.fromEntries(useChatStore.getState().messages.ava.map((message) => [message.id, message.status]));
  assert.deepEqual([status.m1, status.m2, status.m3], ['read', 'read', 'sent'], 'everything of mine up to the marked message');

  // Seen on the desktop: text messages with ISO times, then a file whose time was a number; the marker named the
  // file and only the file turned blue. Every earlier message of mine turns blue too.
  useChatStore.setState({ messages: { ava: [
    { id: 't1', senderId: 'me', receiverId: 'ava', timestamp: '2026-11-16T09:32:00.000Z', content: 'HI', status: 'delivered' },
    { id: 't2', senderId: 'me', receiverId: 'ava', timestamp: '2026-11-16T09:40:00.000Z', content: 'HIIII', status: 'delivered' },
    { id: 'f1', senderId: 'me', receiverId: 'ava', timestamp: Date.parse('2026-11-16T09:43:00.000Z'), content: 'media:x', status: 'delivered' },
  ] } });
  useChatStore.getState().markReadThrough('f1');
  assert.deepEqual(useChatStore.getState().messages.ava.map((message) => message.status), ['read', 'read', 'read']);
});

test('call outcomes come from the end reason: declined, busy, unavailable, cancelled, missed, answered elsewhere', async () => {
  const { callOutcome, callLogRows, callRowLabel } = await import('../src/callLogRows.js');
  const cases = [
    [{ answered: true, direction: 'outgoing' }, 'completed'],
    [{ direction: 'outgoing', reason: 'declined', byPeer: true }, 'declined'],
    [{ direction: 'outgoing', reason: 'busy', byPeer: true }, 'busy'],
    [{ direction: 'outgoing', reason: 'unavailable', byPeer: true }, 'unavailable'],
    [{ direction: 'outgoing', reason: 'ended', byPeer: false }, 'cancelled'],
    [{ direction: 'outgoing', reason: 'no-answer', byPeer: true }, 'no-answer'],
    [{ direction: 'incoming', reason: 'declined', byPeer: false }, 'declined'],
    [{ direction: 'incoming', reason: 'ended', byPeer: true }, 'missed'],
    [{ direction: 'incoming', reason: 'answered-elsewhere', byPeer: true }, 'answered-elsewhere'],
    [{ direction: 'incoming', reason: 'failed' }, 'failed'],
  ];
  for (const [input, expected] of cases) assert.equal(callOutcome(input), expected, JSON.stringify(input));
  const label = (status, direction = 'outgoing', mode = 'audio') => callRowLabel(callLogRows([{ id: 'x', peerId: 'p', direction, status, duration: 0, mode, timestamp: '2026-11-16T10:00:00Z' }])[0]);
  assert.equal(label('busy'), 'Outgoing voice call · Busy');
  assert.equal(label('unavailable', 'outgoing', 'video'), 'Outgoing video call · Unavailable');
  assert.equal(label('cancelled'), 'Outgoing voice call · Cancelled');
  assert.equal(label('answered-elsewhere', 'incoming'), 'Incoming voice call · Answered on another device');
  assert.equal(callLogRows([{ id: 'y', peerId: 'p', direction: 'incoming', status: 'answered-elsewhere', duration: 0, mode: 'audio', timestamp: '2026-11-16T10:00:00Z' }])[0].missed, false);
});

test('call log sync: entries travel sealed to my other devices and merge by id, the better outcome kept', async () => {
  const { callSyncContent, parseCallSync, betterCallOutcome } = await import('../src/callLogSync.js');
  const entry = { id: 'call-abc', peerId: 'ava', mode: 'video', direction: 'incoming', status: 'completed', duration: 42, timestamp: '2026-11-16T10:00:00.000Z' };
  assert.deepEqual(parseCallSync(callSyncContent(entry)), entry, 'round trip');
  assert.equal(parseCallSync('sync:{"k":"call","e":{"id":"x","peerId":"ava","status":"hacked","direction":"incoming","timestamp":"2026-11-16"}}'), null, 'unknown status refused');
  assert.equal(parseCallSync('sync:not json'), null);
  assert.equal(parseCallSync(callSyncContent({ ...entry, peerId: '../../x y' })), null, 'odd ids refused');
  const group = parseCallSync(callSyncContent({ ...entry, id: 'call-g', groupId: 'g1', groupName: 'Team', participants: ['ava', 'ben'] }));
  assert.deepEqual([group.groupId, group.groupName, group.participants], ['g1', 'Team', ['ava', 'ben']]);
  assert.equal(betterCallOutcome({ status: 'completed' }, { status: 'missed' }), true);
  assert.equal(betterCallOutcome({ status: 'missed' }, { status: 'completed' }), false);

  const { useChatStore } = await import('../src/store.js');
  useChatStore.setState({ userId: 'me', chats: [{ id: 'ava', name: 'Ava' }], messages: {}, callLogs: [], persistCallLogs: async () => {} });
  // This device saw the call ring and logged it missed; the phone that answered syncs "completed": one entry, answered.
  useChatStore.getState().logCall('ava', { callId: 'abc', mode: 'video', status: 'missed', direction: 'incoming', timestamp: entry.timestamp });
  useChatStore.getState().mergeSyncedCall(entry);
  const state = useChatStore.getState();
  assert.equal(state.callLogs.length, 1);
  assert.deepEqual([state.callLogs[0].status, state.callLogs[0].duration], ['completed', 42]);
  assert.match(state.messages.ava.find((message) => message.id === 'call-abc').content, /"status":"completed"/, 'the chat card follows');
  // A group call from another device: in the Calls tab, not as a card in a one-to-one chat.
  useChatStore.getState().mergeSyncedCall({ ...entry, id: 'call-g', status: 'missed', groupId: 'g1', participants: ['ava', 'ben'] });
  assert.equal(useChatStore.getState().callLogs.find((item) => item.id === 'call-g').groupId, 'g1');
  assert.equal(useChatStore.getState().messages.ava.some((message) => message.id === 'call-g'), false);
});

test('R3: a receipt that overtakes its message is kept and applied when the message arrives', async () => {
  const { useChatStore, orphanReceiptCount } = await import('../src/store.js');
  useChatStore.setState({ userId: 'me', chats: [{ id: 'ava', name: 'Ava' }], messages: {}, callLogs: [], persistCallLogs: async () => {} });
  const store = () => useChatStore.getState();
  const statusOf = (id) => store().messages.ava?.find((message) => message.id === id)?.status;
  // The receipts come first (a copy from my other device still on its way, or saved messages still loading).
  store().applyReceipt('late-1', { status: 'delivered' });
  store().applyReceipt('late-1', { status: 'read' });
  store().applyReceipt('late-1', { status: 'delivered' });
  store().applyReceipt('vn-1', { played: true });
  assert.equal(orphanReceiptCount(), 2, 'kept, one entry per message');
  store().addMessage({ id: 'late-1', senderId: 'me', receiverId: 'ava', timestamp: '2026-11-16T10:00:00.000Z', content: 'hi', status: 'sent' });
  assert.equal(statusOf('late-1'), 'read', 'the furthest status wins, never moving back');
  store().addMessage({ id: 'vn-1', senderId: 'me', receiverId: 'ava', timestamp: '2026-11-16T10:01:00.000Z', content: 'voice', status: 'sent' });
  assert.equal(store().messages.ava.find((message) => message.id === 'vn-1').played, true);
  assert.equal(orphanReceiptCount(), 0, 'applied and forgotten');
  // A receipt for a message already here is applied at once, not kept.
  store().applyReceipt('late-1', { status: 'delivered' });
  assert.equal(orphanReceiptCount(), 0);
  // A cumulative read marker that overtakes its message turns the earlier ones blue once it arrives.
  store().addMessage({ id: 'e-1', senderId: 'me', receiverId: 'ava', timestamp: '2026-11-16T10:02:00.000Z', content: 'a', status: 'delivered' });
  store().applyReceipt('e-2', { status: 'read', upTo: true });
  store().addMessage({ id: 'e-2', senderId: 'me', receiverId: 'ava', timestamp: '2026-11-16T10:03:00.000Z', content: 'b', status: 'sent' });
  assert.deepEqual([statusOf('e-1'), statusOf('e-2')], ['read', 'read']);
  // Bounded: never more than ORPHAN_LIMIT waiting.
  const { ORPHAN_LIMIT } = await import('../src/store.js');
  for (let i = 0; i < ORPHAN_LIMIT + 50; i += 1) store().applyReceipt(`never-${i}`, { status: 'delivered' });
  assert.ok(orphanReceiptCount() <= ORPHAN_LIMIT);
});

test('C2: swiping away a missed-call notification clears that person\'s missed-call mark', async () => {
  const { useChatStore } = await import('../src/store.js');
  useChatStore.setState({ userId: 'me', chats: [{ id: 'ava', name: 'Ava', missedCalls: 3 }, { id: 'ben', name: 'Ben', missedCalls: 1 }], messages: {} });
  useChatStore.getState().clearMissedCalls('ava');
  assert.deepEqual(useChatStore.getState().chats.map((chat) => chat.missedCalls), [0, 1], 'only that person');
  const app = readFileSync(join(appDir, 'src/App.jsx'), 'utf8');
  assert.match(app, /if \(event\.status === 'seen'\) \{ useChatStore\.getState\(\)\.clearMissedCalls\(event\.peerId\); continue; \}/);
  const alerts = readFileSync(join(appDir, 'android/app/src/main/java/io/github/bickworld555/hiddenchat/Alerts.java'), 'utf8');
  assert.ok(alerts.includes('.setDeleteIntent(MissedCallDismissReceiver.intent(context, caller.id,'), 'the notification reports its dismissal');
  const receiver = readFileSync(join(appDir, 'android/app/src/main/java/io/github/bickworld555/hiddenchat/MissedCallDismissReceiver.java'), 'utf8');
  assert.match(receiver, /Alerts\.forgetMissedCount\(callerId\);\s*CallEvents\.record\(context, null, callerId, false, "seen"\);/);
  const manifest = readFileSync(join(appDir, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
  assert.match(manifest, /android:name="\.MissedCallDismissReceiver"\s*android:exported="false"/);
});
