// Calls and pushes for a phone that just went offline (live report: an offline phone showed "Ringing" forever to the
// caller, and messages sent while it was offline brought no notification when it came back). Short timers here; the
// real ones are CALL_UNREACHABLE_MS (30 s), DELIVERY_PUSH_MS (8 s) and NUDGE_AFTER_MS (10 s).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
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
