// View once voice notes (played exactly once by the recipient, then deleted) and polls with live vote tallies.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createChatServer } from './index.mjs';
import { encodePoll, parsePollContent, pollSummary, tallyPoll } from '../src/polls.js';
import { encodeEvent, eventCalendarFile, parseEventContent } from '../src/calendarEvents.js';
import { parseVoiceContent } from '../src/voice.js';

const PASSWORD = 'Correct-Horse-Battery-42!';
let service;
let directory;
let baseUrl;
let counter = 0;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-view-once-'));
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), dataDirectory: directory });
  const address = await service.listen();
  baseUrl = `http://127.0.0.1:${address.port}`;
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

async function uploadVoice(sender, receiver, bytes) {
  const response = await fetch(`${baseUrl}/api/v1/media?receiverId=${receiver.user.id}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${sender.token}`, 'Content-Type': 'audio/webm', 'X-File-Name': 'voice-note.webm' },
    body: bytes,
  });
  assert.equal(response.status, 201);
  return response.json();
}

test('voice content: plain and view once notes parse; an opened note keeps only its length', () => {
  assert.deepEqual(parseVoiceContent('voice:abc:12'), { id: 'abc', seconds: 12, viewOnce: false, opened: false });
  assert.deepEqual(parseVoiceContent('voice:abc:7:once'), { id: 'abc', seconds: 7, viewOnce: true, opened: false });
  assert.deepEqual(parseVoiceContent('voice-opened:7'), { id: null, seconds: 7, viewOnce: true, opened: true });
  assert.equal(parseVoiceContent('hello'), null);
});

test('a view once voice note plays once for the recipient, then the audio is gone for everyone', async () => {
  const sender = await register('vos');
  const recipient = await register('vor');
  const intruder = await register('voi');
  const senderSocket = await connect(sender);
  const recipientSocket = await connect(recipient);
  const audio = Buffer.from('OggS fake opus audio payload for the test');
  const media = await uploadVoice(sender, recipient, audio);
  senderSocket.send(JSON.stringify({ type: 'message:send', message: { id: 'once-1', receiverId: recipient.user.id, content: `voice:${media.id}:4:once` } }));
  const delivered = await recipientSocket.wait('message:new', (event) => event.message.id === 'once-1');
  assert.equal(delivered.message.content, `voice:${media.id}:4:once`);

  // The ordinary download paths refuse view once audio, for the sender too.
  assert.equal((await api(`/api/v1/media/${media.id}`, { session: recipient })).status, 403);
  assert.equal((await api(`/api/v1/media/${media.id}`, { session: sender })).status, 403);
  assert.equal((await api(`/api/v1/media/${media.id}/link`, { session: recipient, method: 'POST' })).status, 403);
  // Only the recipient may open it; the sender and strangers cannot.
  assert.equal((await api('/api/v1/messages/once-1/view-once', { session: sender, method: 'POST' })).status, 403);
  assert.equal((await api('/api/v1/messages/once-1/view-once', { session: intruder, method: 'POST' })).status, 404);
  // Forwarding it (even by the recipient to themself or a third person) is refused.
  recipientSocket.send(JSON.stringify({ type: 'message:send', message: { id: 'fwd-1', receiverId: intruder.user.id, content: `voice:${media.id}:4`, forwarded: true } }));
  assert.match((await recipientSocket.wait('error')).message, /can’t be forwarded/);

  const opened = await api('/api/v1/messages/once-1/view-once', { session: recipient, method: 'POST' });
  assert.equal(opened.status, 200);
  assert.deepEqual(opened.data, audio);
  for (const socket of [senderSocket, recipientSocket]) {
    const update = await socket.wait('message:updated', (event) => event.messageId === 'once-1');
    assert.equal(update.content, 'voice-opened:4');
  }
  assert.equal((await api('/api/v1/messages/once-1/view-once', { session: recipient, method: 'POST' })).status, 410, 'a second play is refused');
  const history = (await api(`/api/v1/messages?peerId=${sender.user.id}`, { session: recipient })).data;
  assert.equal(history.find((message) => message.id === 'once-1').content, 'voice-opened:4');
  // The audio file and its row are deleted once sent.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await api(`/api/v1/media/${media.id}`, { session: recipient })).status, 404);
  assert.ok(!readdirSync(join(directory, 'media')).includes(`${media.id}.blob`));
  senderSocket.close();
  recipientSocket.close();
});

test('a voice note turns "played" (blue) once the recipient listens; only the recipient can mark it', async () => {
  const sender = await register('vps');
  const recipient = await register('vpr');
  const senderSocket = await connect(sender);
  const recipientSocket = await connect(recipient);
  const media = await uploadVoice(sender, recipient, Buffer.from('OggS voice note that will be played'));
  senderSocket.send(JSON.stringify({ type: 'message:send', message: { id: 'played-1', receiverId: recipient.user.id, content: `voice:${media.id}:3` } }));
  senderSocket.send(JSON.stringify({ type: 'message:send', message: { id: 'played-text', receiverId: recipient.user.id, content: 'not a voice note' } }));
  await recipientSocket.wait('message:new', (event) => event.message.id === 'played-text');

  // The sender cannot mark their own note, and text messages cannot be "played".
  senderSocket.send(JSON.stringify({ type: 'message:played', messageId: 'played-1' }));
  recipientSocket.send(JSON.stringify({ type: 'message:played', messageId: 'played-text' }));
  const before = (await api(`/api/v1/messages?peerId=${recipient.user.id}`, { session: sender })).data;
  assert.equal(before.find((message) => message.id === 'played-1').played, undefined);
  assert.equal(before.find((message) => message.id === 'played-text').played, undefined);

  recipientSocket.send(JSON.stringify({ type: 'message:played', messageId: 'played-1' }));
  await senderSocket.wait('message:played', (event) => event.messageId === 'played-1');
  const status = await senderSocket.wait('message:status', (event) => event.messageId === 'played-1');
  assert.equal(status.status, 'read', 'listening also reads it');
  const history = (await api(`/api/v1/messages?peerId=${recipient.user.id}`, { session: sender })).data;
  assert.equal(history.find((message) => message.id === 'played-1').played, true);
  const synced = (await api('/api/v1/messages/sync?after=2000-01-01T00:00:00Z', { session: recipient })).data;
  assert.equal(synced.find((message) => message.id === 'played-1').played, true, 'catch-up sync carries it too');

  // A second play is not announced again.
  const count = senderSocket.events.filter((event) => event.type === 'message:played').length;
  recipientSocket.send(JSON.stringify({ type: 'message:played', messageId: 'played-1' }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(senderSocket.events.filter((event) => event.type === 'message:played').length, count);
  senderSocket.close();
  recipientSocket.close();
});

test('only a fresh upload to this chat can be sent as view once', async () => {
  const sender = await register('vfs');
  const first = await register('vff');
  const second = await register('vfo');
  const socket = await connect(sender);
  const media = await uploadVoice(sender, first, Buffer.from('audio'));
  socket.send(JSON.stringify({ type: 'message:send', message: { id: 'wrong-target', receiverId: second.user.id, content: `voice:${media.id}:2:once` } }));
  assert.match((await socket.wait('error')).message, /new voice message/);
  socket.close();
});

test('poll content round-trips and tallies; event content becomes a calendar file', () => {
  const content = encodePoll({ question: ' Dinner? ', options: ['Pizza', ' ', 'Sushi', 'Pizza'], multiple: false });
  assert.deepEqual(parsePollContent(content), { question: 'Dinner?', options: ['Pizza', 'Sushi'], multiple: false });
  assert.equal(encodePoll({ question: 'Only one', options: ['A'] }), null, 'a poll needs two options');
  assert.equal(parsePollContent('poll:{bad json'), null);
  assert.equal(pollSummary(content), '📊 Poll: Dinner?');
  assert.deepEqual(tallyPoll({ 0: ['a', 'b'], 1: ['c'] }, 2, 'b'), { counts: [2, 1], total: 3, voters: 3, mine: [0], leader: 2 });

  const event = encodeEvent({ title: 'Family dinner', startsAt: '2026-11-20T19:30', location: 'Home', description: 'Bring dessert' });
  const parsed = parseEventContent(event);
  assert.equal(parsed.title, 'Family dinner');
  assert.equal(encodeEvent({ title: '  ', startsAt: '2026-11-20T19:30' }), null);
  const ics = eventCalendarFile({ ...parsed, id: 'evt-1' }, new Date('2026-11-08T10:00:00Z'));
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /\r\nSUMMARY:Family dinner\r\n/);
  assert.match(ics, /\r\nLOCATION:Home\r\n/);
  assert.match(ics, /\r\nUID:evt-1@hiddenmessenger\.com\r\n/);
  assert.match(ics, /\r\nDTSTART:\d{8}T\d{6}Z\r\n/);
  assert.match(eventCalendarFile({ title: 'a;b,c\nd', startsAt: parsed.startsAt, id: 'x' }), /SUMMARY:a\\;b\\,c\\nd/);
});

test('poll votes are validated, replace earlier choices and reach everyone in a direct or group chat', async () => {
  const ava = await register('pav');
  const ben = await register('pbe');
  const cal = await register('pca');
  const avaSocket = await connect(ava);
  const benSocket = await connect(ben);
  const calSocket = await connect(cal);
  avaSocket.send(JSON.stringify({ type: 'message:send', message: { id: 'poll-1', receiverId: ben.user.id, content: encodePoll({ question: 'When?', options: ['Fri', 'Sat', 'Sun'] }) } }));
  await benSocket.wait('message:new', (event) => event.message.id === 'poll-1');

  assert.equal((await api('/api/v1/polls/poll-1/vote', { session: ben, method: 'PUT', body: { options: [0, 1] } })).status, 400, 'single choice');
  assert.equal((await api('/api/v1/polls/poll-1/vote', { session: ben, method: 'PUT', body: { options: [3] } })).status, 400, 'out of range');
  assert.equal((await api('/api/v1/polls/poll-1/vote', { session: cal, method: 'PUT', body: { options: [0] } })).status, 404, 'not in this chat');
  assert.deepEqual((await api('/api/v1/polls/poll-1/vote', { session: ben, method: 'PUT', body: { options: [1] } })).data.votes, { 1: [ben.user.id] });
  assert.deepEqual((await api('/api/v1/polls/poll-1/vote', { session: ben, method: 'PUT', body: { options: [2] } })).data.votes, { 2: [ben.user.id] }, 'a new choice replaces the old');
  await api('/api/v1/polls/poll-1/vote', { session: ava, method: 'PUT', body: { options: [2] } });
  const live = await benSocket.wait('poll:votes', (event) => event.votes[2]?.length === 2);
  assert.deepEqual(live.votes, { 2: [ben.user.id, ava.user.id] });
  assert.deepEqual((await api('/api/v1/polls/poll-1', { session: ava })).data.votes, { 2: [ben.user.id, ava.user.id] });
  assert.deepEqual((await api('/api/v1/polls/poll-1/vote', { session: ava, method: 'PUT', body: { options: [] } })).data.votes, { 2: [ben.user.id] }, 'withdrawn');
  assert.equal((await api('/api/v1/polls/poll-1', { session: cal })).status, 404);

  const group = (await api('/api/v1/groups', { session: ava, method: 'POST', body: { name: 'Trip', memberIds: [ben.user.id, cal.user.id] } })).data;
  const posted = await api(`/api/v1/groups/${group.id}/messages`, { session: ava, method: 'POST', body: { content: encodePoll({ question: 'Bring?', options: ['Tent', 'Stove', 'Map'], multiple: true }) } });
  assert.equal(posted.status, 201);
  const pollId = posted.data.id ?? posted.data.message?.id;
  assert.deepEqual((await api(`/api/v1/polls/${pollId}/vote`, { session: cal, method: 'PUT', body: { options: [0, 2, 2] } })).data.votes, { 0: [cal.user.id], 2: [cal.user.id] }, 'multiple choice, duplicates ignored');
  const groupLive = await benSocket.wait('poll:votes', (event) => event.messageId === pollId);
  assert.deepEqual(groupLive.votes, { 0: [cal.user.id], 2: [cal.user.id] });
  for (const socket of [avaSocket, benSocket, calSocket]) socket.close();
});
