// Status updates: 24-hour text/photo/video posts seen by the author's contacts, with seen state and viewers;
// and reaction events that carry what the background service needs to notify the message's author.
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
  directory = mkdtempSync(join(tmpdir(), 'relay-status-'));
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), dataDirectory: directory });
  const address = await service.listen();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function api(path, { session, method = 'GET', body, raw, headers = {} } = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: { ...(session ? { Authorization: `Bearer ${session.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const type = response.headers.get('content-type') ?? '';
  const data = type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer());
  return { status: response.status, data };
}

async function register(prefix) {
  counter += 1;
  const { status, data } = await api('/api/v1/auth/register', { method: 'POST', body: { username: `${prefix}${counter}`, dob: '1990-04-12', password: PASSWORD } });
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

test('statuses reach the author\'s contacts only, track who saw them, and can be deleted', async () => {
  const author = await register('sta');
  const friend = await register('stf');
  const stranger = await register('sts');
  // The author has the friend in their contacts; the stranger is not linked at all.
  assert.equal((await api('/api/v1/contacts', { session: author, method: 'POST', body: { userId: friend.user.id } })).status < 300, true);
  const friendSocket = await connect(friend);

  const text = await api('/api/v1/statuses', { session: author, method: 'POST', body: { content: 'Good morning ☀️', background: '#7e57c2' } });
  assert.equal(text.status, 201);
  assert.equal(text.data.background, '#7e57c2');
  assert.equal(text.data.views, 0);
  assert.ok(new Date(text.data.expiresAt) - new Date(text.data.createdAt) === 24 * 60 * 60 * 1000, 'disappears after 24 hours');
  await friendSocket.wait('status:changed', (event) => event.userId === author.user.id);

  // A photo status: uploaded to yourself, then readable by contacts only through the status.
  const upload = await fetch(`${baseUrl}/api/v1/media?receiverId=${author.user.id}`, {
    method: 'POST', headers: { Authorization: `Bearer ${author.token}`, 'Content-Type': 'image/png', 'X-File-Name': 'sunrise.png' }, body: Buffer.from('fake png bytes'),
  });
  assert.equal(upload.status, 201);
  const media = await upload.json();
  assert.equal((await api(`/api/v1/media/${media.id}`, { session: friend })).status, 404, 'not readable before it is a status');
  const photo = await api('/api/v1/statuses', { session: author, method: 'POST', body: { content: `media:${media.id}:sunrise.png` } });
  assert.equal(photo.status, 201);
  const read = await api(`/api/v1/media/${media.id}`, { session: friend });
  assert.equal(read.status, 200);
  assert.equal(read.data.toString(), 'fake png bytes');
  assert.equal((await api(`/api/v1/media/${media.id}`, { session: stranger })).status, 404);

  // Someone else's media cannot be posted, nor voice notes or oversized text.
  assert.equal((await api('/api/v1/statuses', { session: friend, method: 'POST', body: { content: `media:${media.id}:x.png` } })).status, 400);
  assert.equal((await api('/api/v1/statuses', { session: author, method: 'POST', body: { content: 'x'.repeat(701) } })).status, 400);
  assert.equal((await api('/api/v1/statuses', { session: author, method: 'POST', body: { content: '' } })).status, 400);

  const feed = (await api('/api/v1/statuses', { session: friend })).data;
  assert.deepEqual(feed.mine, []);
  assert.equal(feed.others.length, 1);
  assert.equal(feed.others[0].user.id, author.user.id);
  assert.deepEqual(feed.others[0].statuses.map((status) => status.seen), [false, false]);
  assert.equal(feed.others[0].allSeen, false);
  assert.deepEqual((await api('/api/v1/statuses', { session: stranger })).data.others, [], 'not linked: nothing to see');
  assert.equal((await api(`/api/v1/statuses/${text.data.id}/view`, { session: stranger, method: 'POST' })).status, 404);

  const authorSocket = await connect(author);
  assert.equal((await api(`/api/v1/statuses/${text.data.id}/view`, { session: friend, method: 'POST' })).status, 204);
  await authorSocket.wait('status:viewed', (event) => event.statusId === text.data.id && event.viewerId === friend.user.id);
  // The viewer's own devices hear it too, so the ring turns grey on every one of them.
  await friendSocket.wait('status:viewed', (event) => event.statusId === text.data.id && event.viewerId === friend.user.id);
  assert.equal((await api(`/api/v1/statuses/${photo.data.id}/view`, { session: friend, method: 'POST' })).status, 204);
  assert.equal((await api('/api/v1/statuses', { session: friend })).data.others[0].allSeen, true);
  const mine = (await api('/api/v1/statuses', { session: author })).data.mine;
  assert.deepEqual(mine.map((status) => status.views), [1, 1]);
  const viewers = (await api(`/api/v1/statuses/${text.data.id}/viewers`, { session: author })).data;
  assert.equal(viewers[0].user.id, friend.user.id);
  assert.equal((await api(`/api/v1/statuses/${text.data.id}/viewers`, { session: friend })).status, 404, 'only the author sees viewers');

  assert.equal((await api(`/api/v1/statuses/${photo.data.id}`, { session: friend, method: 'DELETE' })).status, 404);
  assert.equal((await api(`/api/v1/statuses/${photo.data.id}`, { session: author, method: 'DELETE' })).status, 204);
  assert.equal((await api(`/api/v1/media/${media.id}`, { session: friend })).status, 404, 'its photo goes with it');
  assert.equal((await api('/api/v1/statuses', { session: friend })).data.others[0].statuses.length, 1);
  friendSocket.close();
  authorSocket.close();
});

test('a reaction tells the message author who reacted and to what, so it can be notified with the app closed', async () => {
  const sender = await register('rxs');
  const reactor = await register('rxr');
  const senderSocket = await connect(sender);
  const reactorSocket = await connect(reactor);
  senderSocket.send(JSON.stringify({ type: 'message:send', message: { id: 'rx-1', receiverId: reactor.user.id, content: 'Dinner at 8?' } }));
  await reactorSocket.wait('message:new', (event) => event.message.id === 'rx-1');
  reactorSocket.send(JSON.stringify({ type: 'message:reaction', messageId: 'rx-1', emoji: '❤️' }));
  const event = await senderSocket.wait('message:reaction', (item) => item.messageId === 'rx-1');
  assert.equal(event.emoji, '❤️');
  assert.equal(event.messageSenderId, sender.user.id);
  assert.equal(event.messageContent, 'Dinner at 8?');
  assert.match(event.reactorName, /rxr/);
  const own = await reactorSocket.wait('message:reaction', (item) => item.messageId === 'rx-1');
  assert.equal(own.messageContent, undefined, 'the reactor\'s own copy stays minimal');
  senderSocket.close();
  reactorSocket.close();
});

test('the ring round a photo: blue for an unseen status, grey when all are seen, gone once they expire', async () => {
  const { nextStatusExpiry, statusRingsFrom } = await import('../src/store.js');
  const now = Date.parse('2026-11-13T12:00:00.000Z');
  const at = (hours) => new Date(now + hours * 3600_000).toISOString();
  const feed = { others: [
    { user: { id: 'ava' }, statuses: [{ id: 'a1', seen: true, expiresAt: at(2) }, { id: 'a2', seen: false, expiresAt: at(20) }] },
    { user: { id: 'ben' }, statuses: [{ id: 'b1', seen: true, expiresAt: at(5) }] },
    // Cal's only (unseen) one expired a minute ago: no ring at all.
    { user: { id: 'cal' }, statuses: [{ id: 'c1', seen: false, expiresAt: at(-0.02) }] },
    { user: { id: 'dee' }, statuses: [] },
  ] };
  assert.deepEqual(statusRingsFrom(feed, now), { ava: 'new', ben: 'seen' });
  assert.equal(nextStatusExpiry(feed, now), Date.parse(at(2)), 'the rings next change when Ava\'s first one expires');
  // Three hours on: Ava's seen one has gone, her unseen one keeps the ring blue.
  assert.deepEqual(statusRingsFrom(feed, now + 3 * 3600_000), { ava: 'new', ben: 'seen' });
  // A day on: nothing left, no rings, nothing to wait for.
  assert.deepEqual(statusRingsFrom(feed, now + 24 * 3600_000), {});
  assert.equal(nextStatusExpiry(feed, now + 24 * 3600_000), null);
  assert.deepEqual(statusRingsFrom(null), {});
});
