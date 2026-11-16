// Calls and pushes for a phone that just went offline (live report: an offline phone showed "Ringing" forever to the
// caller, and messages sent while it was offline brought no notification when it came back). Short timers here; the
// real ones are CALL_UNREACHABLE_MS (30 s), DELIVERY_PUSH_MS (8 s) and NUDGE_AFTER_MS (10 s).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createChatServer } from './index.mjs';

const PASSWORD = 'Correct-Horse-Battery-42!';
const sent = [];
const fakePush = { send: async (token, data, options) => { sent.push({ token, data, options }); return { ok: true }; } };
let service;
let directory;
let baseUrl;
let counter = 0;
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-reach-'));
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), pushSender: fakePush, callUnreachableMs: 500, deliveryPushMs: 400 });
  baseUrl = `http://127.0.0.1:${(await service.listen()).port}`;
});
after(async () => {
  await service?.close();
  rmSync(directory, { recursive: true, force: true });
});

const api = async (path, { session, method = 'GET', body } = {}) => {
  const response = await fetch(baseUrl + path, { method, headers: { 'X-HM-Client': '3', ...(session ? { Authorization: `Bearer ${session.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};
async function pair() {
  counter += 1;
  const [a, b] = await Promise.all(['reacha', 'reachb'].map(async (prefix) => (await api('/api/v1/auth/register', { method: 'POST', body: { username: `${prefix}${counter}`, dob: '1990-04-12', password: PASSWORD } })).body));
  await api('/api/v1/contacts', { session: a, method: 'POST', body: { userId: b.user.id } });
  await api('/api/v1/contacts', { session: b, method: 'POST', body: { userId: a.user.id } });
  const token = `fcm-${randomBytes(8).toString('hex')}`;
  await api('/api/v1/push/devices', { session: b, method: 'POST', body: { token, key: randomBytes(32).toString('base64'), platform: 'android' } });
  return { a, b, token };
}
async function registerOldPhone(session) {
  const token = `fcm-old-${randomBytes(8).toString('hex')}`;
  await fetch(baseUrl + '/api/v1/push/devices', { method: 'POST', headers: { 'X-HM-Client': '2', Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ token, key: randomBytes(32).toString('base64'), platform: 'android' }) });
  return token;
}
function connect(session, protocol = 'relay.client.3') {
  const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/ws', [`relay.auth.${session.token}`, 'relay.v1', ...(protocol ? [protocol] : [])]);
  socket.events = [];
  socket.on('message', (raw) => socket.events.push(JSON.parse(raw.toString())));
  return new Promise((resolve, reject) => { socket.once('open', () => resolve(socket)); socket.once('error', reject); });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, timeout = 4000) {
  const deadline = Date.now() + timeout;
  for (;;) { const value = check(); if (value) return value; if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`); await sleep(20); }
}
const ready = (socket) => until(() => socket.events.some((event) => event.type === 'connection:ready'), 'ready');
const signalsOf = (socket, callId, type) => socket.events.filter((event) => event.type === 'call:signal' && event.callId === callId && event.signal?.type === type);
// As the app sends it: every call carries its own id as its room id (src/components/CallOverlay.jsx). Without it
// these tests passed while every real call skipped the missed-call push and the "unavailable" timer.
const offer = (socket, targetId, callId) => socket.send(JSON.stringify({ type: 'call:signal', targetId, callId, roomId: callId, mode: 'audio', signalId: `${callId}-o`, signal: { type: 'offer', sdp: 'v=0 x' } }));

test('a call to an offline phone never shows "Ringing", and ends as "unavailable" when no device confirms', async () => {
  const { a, b, token } = await pair();
  const caller = await connect(a);
  await ready(caller);
  offer(caller, b.user.id, 'c-offline');
  await until(() => sent.some((item) => item.token === token && item.options?.collapseKey === 'call:c-offline'), 'call push');
  const end = await until(() => signalsOf(caller, 'c-offline', 'end')[0], 'the call ends');
  assert.equal(end.signal.reason, 'unavailable');
  assert.equal(signalsOf(caller, 'c-offline', 'ringing').length, 0, 'a queued push is no proof the phone rang');
});

test('a phone whose socket looks open but is gone (current app) is not "Ringing" either; one that confirms is', async () => {
  const { a, b } = await pair();
  const caller = await connect(a);
  const silentPhone = await connect(b);
  await Promise.all([ready(caller), ready(silentPhone)]);
  offer(caller, b.user.id, 'c-zombie');
  await until(() => signalsOf(silentPhone, 'c-zombie', 'offer')[0], 'offer written to the socket');
  assert.equal((await until(() => signalsOf(caller, 'c-zombie', 'end')[0], 'the call ends')).signal.reason, 'unavailable');
  assert.equal(signalsOf(caller, 'c-zombie', 'ringing').length, 0, 'writing to a socket proves nothing');

  // A live phone confirms (the app sends "ringing" when the call arrives): the caller hears ringing, once, and the
  // call is not cut as unavailable.
  offer(caller, b.user.id, 'c-live');
  await until(() => signalsOf(silentPhone, 'c-live', 'offer')[0], 'offer');
  for (let i = 0; i < 2; i += 1) silentPhone.send(JSON.stringify({ type: 'call:signal', targetId: a.user.id, callId: 'c-live', mode: 'audio', signalId: `r${i}`, signal: { type: 'ringing' } }));
  await until(() => signalsOf(caller, 'c-live', 'ringing')[0], 'ringing after the confirmation');
  await sleep(700);
  assert.equal(signalsOf(caller, 'c-live', 'ringing').length, 1, 'one "Ringing" however many confirmations');
  assert.equal(signalsOf(caller, 'c-live', 'end').length, 0, 'a confirmed call rings on until answered or the ring timeout');
  caller.send(JSON.stringify({ type: 'call:signal', targetId: b.user.id, callId: 'c-live', mode: 'audio', signalId: 'e', signal: { type: 'end', reason: 'ended' } }));
  silentPhone.close(); caller.close();
});

test('an app too old to confirm (wire version 2) keeps the old rule: ringing once the offer reaches it', async () => {
  const { a, b } = await pair();
  const caller = await connect(a);
  const oldPhone = await connect(b, 'relay.client.2');
  await Promise.all([ready(caller), ready(oldPhone)]);
  offer(caller, b.user.id, 'c-old');
  await until(() => signalsOf(caller, 'c-old', 'ringing')[0], 'ringing as before');
  await sleep(700);
  assert.equal(signalsOf(caller, 'c-old', 'end').length, 0, 'never cut as unavailable: it cannot confirm');
  caller.send(JSON.stringify({ type: 'call:signal', targetId: b.user.id, callId: 'c-old', mode: 'audio', signalId: 'e', signal: { type: 'end', reason: 'ended' } }));
  oldPhone.close(); caller.close();
});

test('a message written to a screen that never confirms it still gets its push; a confirmed one does not', async () => {
  const { a, b, token } = await pair();
  const sender = await connect(a);
  const screen = await connect(b);
  await Promise.all([ready(sender), ready(screen)]);
  const pushes = () => sent.filter((item) => item.token === token && item.data?.t === 'msg');
  sender.send(JSON.stringify({ type: 'message:send', message: { id: 'unconfirmed-1', receiverId: b.user.id, content: 'hi' } }));
  await until(() => screen.events.some((event) => event.type === 'message:new' && event.message.id === 'unconfirmed-1'), 'written to the screen');
  assert.equal(pushes().length, 0, 'someone is on screen: no push at once');
  await until(() => pushes().length === 1, 'the push once nobody confirmed it in time');

  sender.send(JSON.stringify({ type: 'message:send', message: { id: 'confirmed-1', receiverId: b.user.id, content: 'again' } }));
  await until(() => screen.events.some((event) => event.type === 'message:new' && event.message.id === 'confirmed-1'), 'written');
  screen.send(JSON.stringify({ type: 'message:delivered', messageIds: ['confirmed-1'] }));
  await sleep(700);
  assert.equal(pushes().length, 1, 'confirmed in time: no push');
  sender.close(); screen.close();
});

test('XMPP wake-up: only between linked people, content-free, rate limited', async () => {
  const { a, b, token } = await pair();
  const result = await api('/api/v1/xmpp/nudge', { session: a, method: 'POST', body: { userId: b.user.id, messageId: 'm' } });
  assert.deepEqual([result.status, result.body.sent], [202, 1]);
  const pushed = sent.filter((item) => item.token === token).at(-1);
  assert.equal(pushed.data.t, 'xwake');
  assert.equal(pushed.options.collapseKey, undefined);
  counter += 1;
  const stranger = (await api('/api/v1/auth/register', { method: 'POST', body: { username: `reachs${counter}`, dob: '1990-04-12', password: PASSWORD } })).body;
  assert.equal((await api('/api/v1/xmpp/nudge', { session: stranger, method: 'POST', body: { userId: b.user.id } })).body.sent, 0, 'not linked: nothing');
  let limited = 0;
  for (let i = 0; i < 31; i += 1) if ((await api('/api/v1/xmpp/nudge', { session: a, method: 'POST', body: { userId: b.user.id } })).status === 429) limited += 1;
  assert.ok(limited >= 1, 'at most 30 a minute');
});

test('the XMPP session asks for a wake-up when the receiver does not confirm a message in time; their receipt cancels it', async () => {
  const { startXmppSession } = await import('../src/xmpp/session.js');
  const asked = [];
  let onEvent = null;
  const session = await startXmppSession({
    sessionToken: 't', userId: 'me', deliver: () => {}, legacySend: () => {},
    targetsFor: async () => ({ targets: ['dpeer@h/app'], complete: true, sender: { userId: 'me', deviceId: 'phone' } }),
    userForAddress: (address) => (String(address).startsWith('dpeer') ? 'peer' : String(address).startsWith('dmine') ? 'me' : null),
    fetchImpl: async (path, init = {}) => {
      if (path === '/api/v1/xmpp/nudge') { asked.push(JSON.parse(init.body)); return new Response('{}', { status: 202 }); }
      return new Response(JSON.stringify({ transport: 'xmpp' }), { status: 200 });
    },
    createTransport: (options) => { onEvent = options.onEvent; return { state: 'online', sendSealed() { return true; }, setActive() {}, close() {}, checkNow() {} }; },
    nudgeAfterMs: 150,
  });
  session.route({ type: 'message:send', message: { id: 'x-silent', receiverId: 'peer', content: 'e2e2:text|{}' } });
  session.route({ type: 'message:send', message: { id: 'x-confirmed', receiverId: 'peer', content: 'e2e2:text|{}' } });
  await sleep(20);
  onEvent({ type: 'receipt', id: 'x-confirmed', from: 'dmine@h/app' });   // the sender's own other device: does not count
  onEvent({ type: 'receipt', id: 'x-confirmed', from: 'dpeer@h/app' });   // the receiver's device: confirmed
  await sleep(300);
  assert.deepEqual(asked, [{ userId: 'peer', messageId: 'x-silent' }]);
  session.close();
});

test('a phone registered by an app too old to confirm calls (push only) is never cut as "unavailable"', async () => {
  const { a, b } = await pair();
  await registerOldPhone(b);
  const caller = await connect(a);
  await ready(caller);
  offer(caller, b.user.id, 'c-old-phone');
  await sleep(800);
  assert.equal(signalsOf(caller, 'c-old-phone', 'end').length, 0, 'it rings on its own timeout, as before');
  caller.send(JSON.stringify({ type: 'call:signal', targetId: b.user.id, callId: 'c-old-phone', mode: 'audio', signalId: 'e', signal: { type: 'end', reason: 'ended' } }));
  caller.close();
});

test('a call to a phone that was offline the whole time leaves a missed-call push that waits for it; a call it rang for does not', async () => {
  const { a, b, token } = await pair();
  const caller = await connect(a);
  await ready(caller);
  const missedFor = (callId) => sent.filter((item) => item.token === token && item.data?.t === 'missed');
  const before = missedFor().length;
  offer(caller, b.user.id, 'c-missed');
  await until(() => signalsOf(caller, 'c-missed', 'end')[0], 'ended as unavailable');
  await until(() => missedFor().length === before + 1, 'a missed-call push');
  const missed = missedFor().at(-1);
  assert.equal(missed.options.ttlSeconds, undefined, 'the default lifetime: 4 weeks');
  assert.equal(missed.options.collapseKey, undefined);

  // The caller hangs up before the offline phone rings: missed too.
  offer(caller, b.user.id, 'c-cancelled');
  await sleep(100);
  caller.send(JSON.stringify({ type: 'call:signal', targetId: b.user.id, callId: 'c-cancelled', mode: 'audio', signalId: 'e', signal: { type: 'end', reason: 'ended' } }));
  await until(() => missedFor().length === before + 2, 'missed after the caller hung up');

  // A call the phone confirmed (it rang there): the phone shows its own missed call, no second one by push.
  offer(caller, b.user.id, 'c-rang');
  await sleep(100);
  await api('/api/v1/calls/c-rang/ringing', { session: b, method: 'POST' });
  caller.send(JSON.stringify({ type: 'call:signal', targetId: b.user.id, callId: 'c-rang', mode: 'audio', signalId: 'e2', signal: { type: 'end', reason: 'ended' } }));
  await sleep(300);
  assert.equal(missedFor().length, before + 2);

  // Declined by the callee from the push-rung screen: not missed.
  offer(caller, b.user.id, 'c-declined');
  await sleep(100);
  await api('/api/v1/calls/c-declined/decline', { session: b, method: 'POST' });
  await sleep(300);
  assert.equal(missedFor().length, before + 2);
  caller.close();
});

test('C1: a group-call invite to a phone with no app open rings it by push, waits for its connection, and a decline reaches the host', async () => {
  const { a, b, token } = await pair();
  const host = await connect(a);
  await ready(host);
  const before = sent.length;
  host.send(JSON.stringify({ type: 'call:invite', roomId: 'room-c1', targetId: b.user.id, mode: 'video', participants: [] }));
  await until(() => sent.slice(before).some((item) => item.token === token && item.data?.t === 'call'), 'the invite rings the phone by push');
  const push = sent.slice(before).find((item) => item.token === token && item.data?.t === 'call');
  // The payload is encrypted for the phone; its collapse key and lifetime show it rings under the room id, briefly.
  assert.deepEqual([push.options.collapseKey, push.options.ttlSeconds], ['call:room-c1', 45], 'rung under the room id');
  await sleep(100);
  assert.ok(!host.events.some((event) => event.type === 'call:invite-reply' && event.reason === 'offline'), 'not "offline": the phone is ringing');
  // The connection the push opens collects the invite.
  const phone = await connect(b);
  await until(() => phone.events.some((event) => event.type === 'call:invite' && event.roomId === 'room-c1'), 'the held invite reaches the phone');
  phone.close();
  // Declined on the notification (HTTP): the host hears it, and the invite is no longer held.
  assert.equal((await api('/api/v1/calls/room-c1/end', { session: b, method: 'POST' })).status, 204);
  await until(() => host.events.some((event) => event.type === 'call:invite-reply' && event.roomId === 'room-c1' && event.accepted === false && event.reason === 'declined'), 'the host hears the decline');
  const again = await connect(b);
  await ready(again);
  await sleep(100);
  assert.ok(!again.events.some((event) => event.type === 'call:invite'), 'not delivered twice');
  again.close();
  host.close();
});

test('L2: a group shows its running call to every member, a member not in it joins (linked to everyone in it), leaving and silence end it', async () => {
  const { a, b } = await pair();
  counter += 1;
  const c = (await api('/api/v1/auth/register', { method: 'POST', body: { username: `reachc${counter}`, dob: '1990-04-12', password: PASSWORD } })).body;
  const outsider = (await api('/api/v1/auth/register', { method: 'POST', body: { username: `reacho${counter}`, dob: '1990-04-12', password: PASSWORD } })).body;
  await api('/api/v1/contacts', { session: a, method: 'POST', body: { userId: c.user.id } });
  await api('/api/v1/contacts', { session: c, method: 'POST', body: { userId: a.user.id } });
  const created = await api('/api/v1/groups', { session: a, method: 'POST', body: { name: 'Join call', memberIds: [b.user.id, c.user.id] } });
  assert.equal(created.status, 201);
  const groupId = created.body.id;
  const [host, bob, carol, stranger] = await Promise.all([connect(a), connect(b), connect(c), connect(outsider)]);
  await Promise.all([host, bob, carol, stranger].map(ready));
  const callEvents = (socket) => socket.events.filter((event) => event.type === 'group:call' && event.groupId === groupId);

  // Nothing to join yet.
  carol.send(JSON.stringify({ type: 'group:call-join', groupId }));
  await until(() => carol.events.find((event) => event.type === 'group:call-join' && event.ok === false && event.reason === 'ended'), 'no call to join');

  // The host and Bob are connected in the group's call: every member hears who is in it.
  host.send(JSON.stringify({ type: 'group:call', action: 'join', groupId, roomId: 'room-l2', mode: 'audio' }));
  bob.send(JSON.stringify({ type: 'group:call', action: 'join', groupId, roomId: 'room-l2', mode: 'audio' }));
  await until(() => callEvents(carol).some((event) => event.participants.length === 2), 'Carol sees both in the call');
  const shown = callEvents(carol).at(-1);
  assert.deepEqual([shown.roomId, shown.mode, [...shown.participants].sort()], ['room-l2', 'audio', [a.user.id, b.user.id].sort()]);
  // A repeat ("beat") changes nothing, so nobody is told again.
  const told = callEvents(carol).length;
  host.send(JSON.stringify({ type: 'group:call', action: 'beat', groupId, roomId: 'room-l2', mode: 'audio' }));
  await sleep(150);
  assert.equal(callEvents(carol).length, told, 'a beat is quiet');
  // Someone outside the group neither sees it nor may join it.
  assert.equal(callEvents(stranger).length, 0);
  stranger.send(JSON.stringify({ type: 'group:call-join', groupId }));
  await until(() => stranger.events.some((event) => event.type === 'error'), 'a non-member is refused');
  // A second call in the same group is not listed over the running one.
  carol.send(JSON.stringify({ type: 'group:call', action: 'join', groupId, roomId: 'room-other', mode: 'video' }));
  await sleep(150);
  assert.equal(callEvents(host).at(-1).roomId, 'room-l2');

  // Carol joins: she gets the room and everyone in it, and may now place pair calls to Bob (no contact of hers).
  carol.send(JSON.stringify({ type: 'group:call-join', groupId }));
  const joined = await until(() => carol.events.find((event) => event.type === 'group:call-join' && event.ok === true), 'the join reply');
  assert.deepEqual([joined.roomId, joined.mode, [...joined.participants].sort()], ['room-l2', 'audio', [a.user.id, b.user.id].sort()]);
  carol.send(JSON.stringify({ type: 'call:signal', targetId: b.user.id, callId: 'pair-carol-bob', roomId: 'room-l2', groupId, mode: 'audio', signalId: 's1', signal: { type: 'offer', sdp: 'v=0' } }));
  const offer = await until(() => bob.events.find((event) => event.type === 'call:signal' && event.callId === 'pair-carol-bob'), 'Bob gets Carol\'s offer');
  assert.deepEqual([offer.roomId, offer.groupId], ['room-l2', groupId], 'the pair names its room and group, so Bob takes it without ringing');
  carol.send(JSON.stringify({ type: 'group:call', action: 'join', groupId, roomId: 'room-l2', mode: 'audio' }));
  await until(() => callEvents(host).at(-1)?.participants.length === 3, 'three in the call');

  // Leaving: the list shrinks; the last one out ends it for everyone.
  for (const [socket] of [[host], [bob], [carol]]) socket.send(JSON.stringify({ type: 'group:call', action: 'leave', groupId, roomId: 'room-l2' }));
  await until(() => callEvents(bob).at(-1)?.roomId === null && callEvents(bob).at(-1)?.participants.length === 0, 'the call ended');

  // A reconnecting member is told of a running call at once.
  host.send(JSON.stringify({ type: 'group:call', action: 'join', groupId, roomId: 'room-l2b', mode: 'video' }));
  await until(() => callEvents(bob).at(-1)?.roomId === 'room-l2b', 'a new call');
  const later = await connect(c);
  await until(() => callEvents(later).some((event) => event.roomId === 'room-l2b'), 'a fresh connection hears of the running call');
  host.send(JSON.stringify({ type: 'group:call', action: 'leave', groupId, roomId: 'room-l2b' }));
  await until(() => callEvents(later).at(-1)?.participants.length === 0, 'and of its end');
  for (const socket of [host, bob, carol, stranger, later]) socket.close();
});

test('L2: a participant that goes silent (crash, lost network) leaves the group call by itself', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-l2-'));
  const quick = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(dir, 'db.sqlite'), pushSender: fakePush, groupCallPresenceMs: 300 });
  const url = `http://127.0.0.1:${(await quick.listen()).port}`;
  try {
    const call = async (path, session, body) => (await (await fetch(url + path, { method: body ? 'POST' : 'GET', headers: { 'X-HM-Client': '3', ...(session ? { Authorization: `Bearer ${session.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })).json());
    const [x, y] = await Promise.all(['silentx', 'silenty'].map((name) => call('/api/v1/auth/register', null, { username: name, dob: '1990-04-12', password: PASSWORD })));
    await call('/api/v1/contacts', x, { userId: y.user.id });
    await call('/api/v1/contacts', y, { userId: x.user.id });
    const group = await call('/api/v1/groups', x, { name: 'Silent', memberIds: [y.user.id] });
    const open = (session) => {
      const socket = new WebSocket(url.replace('http:', 'ws:') + '/ws', [`relay.auth.${session.token}`, 'relay.v1', 'relay.client.3']);
      socket.events = [];
      socket.on('message', (raw) => socket.events.push(JSON.parse(raw.toString())));
      return new Promise((resolve) => socket.once('open', () => resolve(socket)));
    };
    const [sx, sy] = await Promise.all([open(x), open(y)]);
    await until(() => sx.events.some((event) => event.type === 'connection:ready') && sy.events.some((event) => event.type === 'connection:ready'), 'ready');
    sx.send(JSON.stringify({ type: 'group:call', action: 'join', groupId: group.id, roomId: 'room-silent', mode: 'audio' }));
    await until(() => sy.events.some((event) => event.type === 'group:call' && event.participants.length === 1), 'in the call');
    // No beat follows: after the presence time the server drops it and tells the group.
    await until(() => sy.events.some((event) => event.type === 'group:call' && event.roomId === null), 'dropped after silence', 3000);
    sx.close();
    sy.close();
  } finally {
    await quick.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P5: a phone that keeps its own connection (Always connected) gets the message wake-up over it too, besides Firebase', async () => {
  const { a, b, token } = await pair();
  // The Android service's own connection: relay.background (never shows the person online).
  const service = await connect(b, 'relay.background');
  await ready(service);
  const before = sent.length;
  const result = await api('/api/v1/xmpp/nudge', { session: a, method: 'POST', body: { userId: b.user.id, messageId: 'm-p5' } });
  assert.deepEqual([result.status, result.body.sent], [202, 2], 'the push and the connection');
  const wake = await until(() => service.events.find((event) => event.type === 'xmpp:wake'), 'the wake-up over the connection');
  assert.deepEqual(wake, { type: 'xmpp:wake', from: a.user.id }, 'content-free, like the push');
  assert.ok(sent.slice(before).some((item) => item.token === token && item.data?.t === 'xwake'), 'Firebase still gets it');
  // An app on screen is not sent it (it is connected to XMPP itself).
  const app = await connect(b);
  await ready(app);
  await api('/api/v1/xmpp/nudge', { session: a, method: 'POST', body: { userId: b.user.id, messageId: 'm-p5b' } });
  await sleep(100);
  assert.ok(!app.events.some((event) => event.type === 'xmpp:wake'));
  service.close();
  app.close();

  const relay = readFileSync(new URL('../android/app/src/main/java/io/github/bickworld555/hiddenchat/NativeRelay.java', import.meta.url), 'utf8');
  assert.match(relay, /"xmpp:wake"\.equals\(type\)\) \{[\s\S]{0,200}PushService\.handleXmppWake\(context, session, event\);/);
  const service2 = readFileSync(new URL('../android/app/src/main/java/io/github/bickworld555/hiddenchat/MessagingService.java', import.meta.url), 'utf8');
  assert.match(service2, /!PushRegistration\.isActive\(context\) \|\| AlwaysConnected\.enabled\(context\)/, 'the always-on mode when chosen');
});

test('group call: an invitee\'s pair with the person who invited them connects (its pair id fits the server\'s limit)', async () => {
  const { a, b } = await pair();
  const host = await connect(a);
  const invitee = await connect(b);
  await Promise.all([ready(host), ready(invitee)]);
  // The app's invited pair id: a random UUID like every pair (src/App.jsx). The old one was 110 characters.
  const room = crypto.randomUUID();
  const pairId = crypto.randomUUID();
  invitee.send(JSON.stringify({ type: 'call:signal', targetId: a.user.id, callId: pairId, roomId: room, mode: 'audio', signalId: 's-ok', signal: { type: 'offer', sdp: 'v=0' } }));
  const offer = await until(() => host.events.find((event) => event.type === 'call:signal' && event.callId === pairId), 'the offer reaches the inviter');
  assert.equal(offer.roomId, room);
  // What the old id looked like: refused, so that pair never connected.
  const oldId = `${room}:${b.user.id}:${a.user.id}`;
  assert.ok(oldId.length > 80);
  invitee.send(JSON.stringify({ type: 'call:signal', targetId: a.user.id, callId: oldId, roomId: room, mode: 'audio', signalId: 's-old', signal: { type: 'offer', sdp: 'v=0' } }));
  await until(() => invitee.events.some((event) => event.type === 'error' && /Call signaling is invalid/.test(event.message)), 'the old id is refused');
  assert.ok(!host.events.some((event) => event.callId === oldId));
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /const invited = \{ id: crypto\.randomUUID\(\), roomId: event\.roomId/);
  host.close();
  invitee.close();
});
