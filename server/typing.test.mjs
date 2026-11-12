// "typing…" and "recording audio…" (as on WhatsApp): what a device sends, what the server relays, what the other
// device shows and for how long.
import test, { after, before, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createChatServer } from './index.mjs';
import { ACTIVITY_EXPIRES_MS, ACTIVITY_REFRESH_MS, TYPING_IDLE_MS, activityFromEvent, activityLabel, createActivitySender, groupActivityLabel, groupActivityPeople } from '../src/typing.js';

// A sender on a fake clock: every message it sends, with the time it was sent.
function fakeSender() {
  let time = 0;
  let timers = [];
  const sent = [];
  const sender = createActivitySender((event) => sent.push({ at: time, ...event }), {
    peerId: 'ava',
    now: () => time,
    setTimer: (fn, ms) => { const timer = { at: time + ms, fn }; timers.push(timer); return timer; },
    clearTimer: (timer) => { timers = timers.filter((item) => item !== timer); },
  });
  const advance = (ms) => {
    const end = time + ms;
    for (;;) {
      const next = timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      timers = timers.filter((timer) => timer !== next);
      time = next.at;
      next.fn();
    }
    time = end;
  };
  return { sender, sent, advance };
}

test('typing: one "typing" per refresh period however fast the keys, then "stopped" after a pause', () => {
  const { sender, sent, advance } = fakeSender();
  for (let i = 0; i < 10; i += 1) { sender.typed(); advance(200); }
  assert.deepEqual(sent.map((event) => [event.at, event.active, event.kind]), [[0, true, 'typing']]);
  advance(ACTIVITY_REFRESH_MS - 2000);
  sender.typed();
  assert.equal(sent.length, 2, 'refreshed while still typing');
  assert.deepEqual(sent[1], { at: ACTIVITY_REFRESH_MS, type: 'presence:typing', peerId: 'ava', active: true, kind: 'typing' });
  advance(TYPING_IDLE_MS);
  assert.deepEqual(sent.at(-1), { at: ACTIVITY_REFRESH_MS + TYPING_IDLE_MS, type: 'presence:typing', peerId: 'ava', active: false });
  assert.equal(sender.kind, null);
  sender.stop();
  assert.equal(sent.length, 3, 'stopping twice sends one "stopped"');
});

test('recording: "recording" at once, refreshed for as long as the voice note runs, "stopped" when it ends', () => {
  const { sender, sent, advance } = fakeSender();
  sender.typed();
  sender.recording(true);
  assert.deepEqual(sent.map((event) => event.kind), ['typing', 'recording'], 'the mic replaces typing');
  sender.typed();
  advance(ACTIVITY_REFRESH_MS * 4 + 100);
  assert.equal(sent.filter((event) => event.kind === 'recording').length, 5, 'kept alive with a refresh per period');
  assert.ok(sent.every((event) => event.active), 'typing while recording does not end the recording');
  sender.recording(false);
  assert.deepEqual(sent.at(-1), { at: ACTIVITY_REFRESH_MS * 4 + 100, type: 'presence:typing', peerId: 'ava', active: false });
  const count = sent.length;
  advance(ACTIVITY_REFRESH_MS * 3);
  assert.equal(sent.length, count, 'nothing after it ended');
});

test('a chat with no one in it sends nothing', () => {
  const sent = [];
  const sender = createActivitySender((event) => sent.push(event), { peerId: '' });
  sender.typed();
  sender.recording(true);
  sender.stop();
  assert.deepEqual(sent, []);
});

test('reading an event: recording, typing (also for anything unknown), or stopped', () => {
  assert.equal(activityFromEvent({ active: true, kind: 'recording' }), 'recording');
  assert.equal(activityFromEvent({ active: true, kind: 'typing' }), 'typing');
  assert.equal(activityFromEvent({ active: true }), 'typing', 'an older app sends no kind');
  assert.equal(activityFromEvent({ active: false, kind: 'recording' }), null);
  assert.equal(activityLabel('recording'), 'recording audio…');
  assert.equal(activityLabel('typing'), 'typing…');
  assert.equal(activityLabel(null), '');
});

test('the indicator lapses without a refresh, a refresh keeps it, and "stopped" clears it at once', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { useChatStore } = await import('../src/store.js');
    const { setTyping } = useChatStore.getState();
    setTyping('ava', 'recording');
    assert.equal(useChatStore.getState().typing.ava, 'recording');
    mock.timers.tick(ACTIVITY_EXPIRES_MS - 1000);
    setTyping('ava', 'recording');
    mock.timers.tick(ACTIVITY_EXPIRES_MS - 1000);
    assert.equal(useChatStore.getState().typing.ava, 'recording', 'the refresh restarted the countdown');
    mock.timers.tick(1000);
    assert.equal(useChatStore.getState().typing.ava, undefined, 'lapsed with no refresh');
    setTyping('ben', 'typing');
    setTyping('ben', null);
    assert.equal(useChatStore.getState().typing.ben, undefined);
    mock.timers.tick(ACTIVITY_EXPIRES_MS * 2);
    assert.deepEqual(useChatStore.getState().typing, {});
  } finally {
    mock.timers.reset();
  }
});

// The server: relays the kind between two people in a chat, as fast as the socket allows.
const PASSWORD = 'Correct-Horse-Battery-42!';
let service;
let directory;
let baseUrl;
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-typing-'));
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), dataDirectory: directory });
  baseUrl = `http://127.0.0.1:${(await service.listen()).port}`;
});
after(async () => {
  await service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});
async function register(username) {
  const response = await fetch(`${baseUrl}/api/v1/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, dob: '1990-04-12', password: PASSWORD }) });
  return response.json();
}
function connect(session) {
  const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/ws', [`relay.auth.${session.token}`, 'relay.v1']);
  socket.events = [];
  socket.on('message', (raw) => socket.events.push(JSON.parse(raw.toString())));
  socket.waitFor = async (predicate, timeout = 3000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const found = socket.events.find(predicate); if (found) return found; await new Promise((r) => setTimeout(r, 10)); }
    return null;
  };
  return new Promise((resolve, reject) => { socket.once('open', () => resolve(socket)); socket.once('error', reject); });
}

test('the server relays "typing", "recording" and "stopped" to the other person only', async () => {
  const ava = await register('typava');
  const ben = await register('typben');
  const cal = await register('typcal');
  const [avaSocket, benSocket, calSocket] = await Promise.all([connect(ava), connect(ben), connect(cal)]);
  const relayed = async (event) => {
    benSocket.events.length = 0;
    avaSocket.send(JSON.stringify({ type: 'presence:typing', peerId: ben.user.id, ...event }));
    return benSocket.waitFor((item) => item.type === 'presence:typing');
  };
  const started = Date.now();
  assert.deepEqual(await relayed({ active: true, kind: 'recording' }), { type: 'presence:typing', userId: ava.user.id, active: true, kind: 'recording' });
  assert.ok(Date.now() - started < 1000, 'relayed straight away');
  assert.deepEqual(await relayed({ active: true, kind: 'typing' }), { type: 'presence:typing', userId: ava.user.id, active: true, kind: 'typing' });
  assert.equal((await relayed({ active: true, kind: '<script>' })).kind, 'typing', 'an unknown kind is typing');
  assert.deepEqual(await relayed({ active: false, kind: 'recording' }), { type: 'presence:typing', userId: ava.user.id, active: false });
  assert.equal(calSocket.events.some((item) => item.type === 'presence:typing'), false, 'nobody else hears it');
  assert.equal(avaSocket.events.some((item) => item.type === 'presence:typing'), false, 'not echoed to the sender');
  for (const socket of [avaSocket, benSocket, calSocket]) socket.close();
});

test('a group shows who is busy in it, by name, as WhatsApp words it', () => {
  assert.equal(groupActivityLabel([]), '');
  assert.equal(groupActivityLabel([{ name: 'Ava', kind: 'typing' }]), 'Ava is typing…');
  assert.equal(groupActivityLabel([{ name: 'Ava', kind: 'recording' }]), 'Ava is recording audio…');
  assert.equal(groupActivityLabel([{ name: 'Ava', kind: 'typing' }, { name: 'Ben', kind: 'typing' }]), 'Ava and Ben are typing…');
  assert.equal(groupActivityLabel([{ name: 'Ava', kind: 'recording' }, { name: 'Ben', kind: 'recording' }]), 'Ava and Ben are recording audio…');
  assert.equal(groupActivityLabel([{ name: 'Ava', kind: 'typing' }, { name: 'Ben', kind: 'recording' }, { name: 'Cal', kind: 'typing' }]), '3 people are typing…');
  assert.equal(groupActivityLabel([{ name: '', kind: 'typing' }]), 'Someone is typing…');
  // A saved contact's name wins over the name the server sent.
  const people = groupActivityPeople({ u1: { kind: 'typing', name: 'Ava Server' }, u2: { kind: 'typing', name: 'Ben' } }, (id) => (id === 'u1' ? 'Mum' : ''));
  assert.deepEqual(people, [{ userId: 'u1', kind: 'typing', name: 'Mum' }, { userId: 'u2', kind: 'typing', name: 'Ben' }]);
});

test('typing in a group is addressed to the group', () => {
  const sent = [];
  const sender = createActivitySender((event) => sent.push(event), { groupId: 'g1' });
  sender.typed();
  sender.stop();
  assert.deepEqual(sent, [
    { type: 'presence:typing', groupId: 'g1', active: true, kind: 'typing' },
    { type: 'presence:typing', groupId: 'g1', active: false },
  ]);
});

test('a group\'s typing people lapse one by one; "stopped" or their message removes them', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { useChatStore } = await import('../src/store.js');
    const { setGroupTyping } = useChatStore.getState();
    setGroupTyping('g1', 'ava', 'typing', 'Ava');
    mock.timers.tick(3000);
    setGroupTyping('g1', 'ben', 'typing', 'Ben');
    assert.deepEqual(Object.keys(useChatStore.getState().groupTyping.g1), ['ava', 'ben']);
    mock.timers.tick(ACTIVITY_EXPIRES_MS - 3000);
    assert.deepEqual(Object.keys(useChatStore.getState().groupTyping.g1), ['ben'], 'Ava lapsed, Ben is still fresh');
    setGroupTyping('g1', 'ben', 'typing');
    assert.equal(useChatStore.getState().groupTyping.g1.ben.name, 'Ben', 'a refresh keeps the name');
    setGroupTyping('g1', 'ben', null);
    assert.equal(useChatStore.getState().groupTyping.g1, undefined);
  } finally {
    mock.timers.reset();
  }
});

test('the server relays group typing, with the name, to the other members only', async () => {
  const ava = await register('gtava');
  const ben = await register('gtben');
  const cal = await register('gtcal');
  const outsider = await register('gtout');
  const created = await fetch(`${baseUrl}/api/v1/groups`, { method: 'POST', headers: { Authorization: `Bearer ${ava.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Team', memberIds: [ben.user.id, cal.user.id] }) });
  const group = await created.json();
  assert.equal(created.status < 300, true, JSON.stringify(group));
  const [avaSocket, benSocket, calSocket, outSocket] = await Promise.all([connect(ava), connect(ben), connect(cal), connect(outsider)]);
  avaSocket.send(JSON.stringify({ type: 'presence:typing', groupId: group.id, active: true, kind: 'typing' }));
  const heard = await benSocket.waitFor((item) => item.type === 'presence:typing');
  assert.deepEqual(heard, { type: 'presence:typing', groupId: group.id, userId: ava.user.id, active: true, kind: 'typing', name: ava.user.name || `@${ava.user.username}` });
  assert.ok(await calSocket.waitFor((item) => item.type === 'presence:typing' && item.groupId === group.id), 'every other member hears it');
  avaSocket.send(JSON.stringify({ type: 'presence:typing', groupId: group.id, active: false }));
  assert.deepEqual(await benSocket.waitFor((item) => item.type === 'presence:typing' && !item.active), { type: 'presence:typing', groupId: group.id, userId: ava.user.id, active: false });
  // Someone outside the group can't announce themselves in it.
  outSocket.send(JSON.stringify({ type: 'presence:typing', groupId: group.id, active: true }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(benSocket.events.some((item) => item.type === 'presence:typing' && item.userId === outsider.user.id), false);
  assert.equal(outSocket.events.some((item) => item.type === 'presence:typing'), false, 'non-members hear nothing');
  assert.equal(avaSocket.events.some((item) => item.type === 'presence:typing'), false, 'not echoed to the sender');
  for (const socket of [avaSocket, benSocket, calSocket, outSocket]) socket.close();
});
