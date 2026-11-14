// Delete for everyone, edits, reactions, "played" and the disappearing timer for messages that travelled over XMPP
// (src/e2e/lifecycle.js): the change travels end to end as a sealed control, each device checks and applies it, in any
// arrival order. The server never had those messages, so it is not asked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CONTROL_PREFIX, EDIT_WINDOW_MS, HOLD_MS, cleanDisappear, controlContent, createControlBuffer, expiredIds, expiryOf, parseControl, resolveControl,
} from '../src/e2e/lifecycle.js';
import { innerFrom, innerOf, openedFrom } from '../src/e2e/client.js';
import { startXmppSession } from '../src/xmpp/session.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const ME = 'me';
const PEER = 'peer';
const T0 = Date.parse('2026-11-15T04:00:00Z');
const theirs = { id: 'm1', senderId: PEER, receiverId: ME, content: 'hello', timestamp: new Date(T0).toISOString(), via: 'xmpp' };
const mine = { id: 'm2', senderId: ME, receiverId: PEER, content: 'hi there', timestamp: new Date(T0).toISOString(), via: 'xmpp' };
const control = (op, extra = {}) => parseControl(controlContent({ op, target: extra.target ?? 'm1', peerId: extra.peerId ?? ME, at: extra.at ?? T0 + 1000, ...extra }));

test('a control is sealed content of its own kind, and anything malformed is refused', () => {
  const content = controlContent({ op: 'react', target: 'm1', peerId: ME, at: T0, emoji: '👍' });
  assert.ok(content.startsWith(CONTROL_PREFIX));
  assert.deepEqual(parseControl(content), { op: 'react', target: 'm1', peerId: ME, at: T0, emoji: '👍' });
  assert.equal(parseControl(controlContent({ op: 'react', target: 'm1', peerId: ME, at: T0, emoji: null })).emoji, null, 'a removed reaction');
  for (const bad of ['hello', 'ctl:', 'ctl:{', 'ctl:{"op":"nuke","t":"m1","p":"me","at":1}', 'ctl:{"op":"delete","t":"m 1","p":"me","at":1}',
    'ctl:{"op":"delete","t":"m1","p":"me","at":-1}', 'ctl:{"op":"edit","t":"m1","p":"me","at":1,"c":""}', `ctl:{"op":"edit","t":"m1","p":"me","at":1,"c":"${'x'.repeat(4001)}"}`,
    `ctl:{"op":"react","t":"m1","p":"me","at":1,"e":"${'x'.repeat(40)}"}`]) assert.equal(parseControl(bad), null, bad);
});

test('delete for everyone: only the sender of the message, from any of their devices', () => {
  assert.deepEqual(resolveControl(control('delete'), { senderId: PEER, target: theirs, me: ME }),
    { action: 'apply', event: { type: 'message:deleted', messageId: 'm1', scope: 'everyone' } });
  assert.equal(resolveControl(control('delete', { target: 'm2' }), { senderId: PEER, target: mine, me: ME }).reason, 'not-sender', 'nobody deletes my message for me');
  // My other device deleted my message: it names the other person in the chat.
  assert.equal(resolveControl(control('delete', { target: 'm2', peerId: PEER }), { senderId: ME, target: mine, me: ME }).action, 'apply');
  // A control about another chat is ignored, whoever sends it.
  assert.equal(resolveControl(control('delete', { peerId: 'someone-else' }), { senderId: PEER, target: theirs, me: ME }).reason, 'not-this-chat');
  assert.equal(resolveControl(control('delete'), { senderId: 'stranger', target: theirs, me: ME }).reason, 'not-this-chat');
});

test('edits: only the sender, only text, within the window; an older edit never replaces a newer one', () => {
  const edit = (at, text = 'hello!') => control('edit', { at, text });
  assert.deepEqual(resolveControl(edit(T0 + 60_000), { senderId: PEER, target: theirs, me: ME }).event,
    { type: 'message:edited', messageId: 'm1', senderId: PEER, content: 'hello!', editedAt: new Date(T0 + 60_000).toISOString() });
  assert.equal(resolveControl(control('edit', { at: T0 + 60_000, text: 'x', peerId: PEER }), { senderId: ME, target: theirs, me: ME }).reason, 'not-sender', 'I cannot edit their message');
  assert.equal(resolveControl(edit(T0 + EDIT_WINDOW_MS + 6 * 60_000), { senderId: PEER, target: theirs, me: ME }).reason, 'too-late');
  assert.equal(resolveControl(edit(T0 + 60_000), { senderId: PEER, target: { ...theirs, content: 'emedia:abc' }, me: ME }).reason, 'not-text');
  assert.equal(resolveControl(edit(T0 + 60_000), { senderId: PEER, target: { ...theirs, content: 'Note: plain text' }, me: ME }).action, 'apply', 'text with a colon is still text');
  assert.equal(resolveControl(edit(T0 + 60_000), { senderId: PEER, target: { ...theirs, deleted: true }, me: ME }).reason, 'deleted');
  const newer = { ...theirs, content: 'second', editedAt: new Date(T0 + 120_000).toISOString() };
  assert.equal(resolveControl(edit(T0 + 60_000, 'first'), { senderId: PEER, target: newer, me: ME }).reason, 'older', 'the first edit arriving last changes nothing');
});

test('reactions: either person; per person the latest wins whatever the arrival order', () => {
  const times = new Map();
  const react = (at, emoji, senderId = PEER, peerId = ME) => {
    const outcome = resolveControl(control('react', { at, emoji, target: 'm2', peerId }), { senderId, target: mine, me: ME, reactedAt: (id, user) => times.get(`${id}:${user}`) ?? null });
    if (outcome.action === 'apply') times.set(`m2:${outcome.event.userId}`, outcome.event.at);
    return outcome;
  };
  assert.equal(react(T0 + 3000, '❤️').event.emoji, '❤️');
  assert.equal(react(T0 + 2000, '👍').reason, 'older', 'an earlier reaction arriving late is dropped');
  assert.equal(react(T0 + 4000, null).event.emoji, null, 'removed');
  assert.equal(react(T0 + 1000, '😂', ME, PEER).event.userId, ME, 'my own reaction from my other device');
  assert.equal(react(T0 + 1000, '😂', ME, ME).reason, 'not-this-chat', 'my own device must name the other person in the chat');
});

test('played: only the person the voice note was sent to', () => {
  assert.deepEqual(resolveControl(control('played', { target: 'm2' }), { senderId: PEER, target: mine, me: ME }).event, { type: 'message:played', messageId: 'm2' });
  assert.equal(resolveControl(control('played'), { senderId: PEER, target: theirs, me: ME }).reason, 'not-listener');
});

test('a control that overtakes its message waits for it, then applies in order; stale ones are forgotten', () => {
  let now = T0;
  const buffer = createControlBuffer({ now: () => now, max: 3 });
  const early = control('edit', { at: T0 + 2000, text: 'second' });
  const earlier = control('edit', { at: T0 + 1000, text: 'first' });
  assert.equal(resolveControl(early, { senderId: PEER, target: null, me: ME }).action, 'hold');
  buffer.hold(early, PEER);
  buffer.hold(earlier, PEER);
  buffer.hold(earlier, PEER);                                    // the same control twice is kept once
  assert.equal(buffer.size, 2);
  assert.deepEqual(buffer.take('m1').map((entry) => entry.control.text), ['first', 'second'], 'oldest first');
  assert.equal(buffer.take('m1').length, 0, 'handed out once');
  buffer.hold(control('delete', { target: 'x1' }), PEER);
  now += HOLD_MS + 1;
  assert.equal(buffer.take('x1').length, 0, 'a control whose message never came is forgotten');
  for (const id of ['a1', 'a2', 'a3', 'a4']) buffer.hold(control('delete', { target: id }), PEER);
  assert.equal(buffer.size, 3, 'bounded');
  assert.equal(buffer.take('a1').length, 0, 'the oldest goes first');
});

test('the disappearing timer travels inside the encryption and each device expires its own copy', () => {
  const inner = innerOf('see you', { disappearSeconds: 86400 });
  assert.equal(inner.ex, 86400);
  assert.equal(openedFrom(innerFrom(JSON.parse(JSON.stringify(inner))), null).disappearSeconds, 86400);
  for (const bad of [5, -86400, '86400', 86400.5, 99999]) assert.equal(cleanDisappear(bad), 0, String(bad));
  assert.equal(innerOf('x', { disappearSeconds: 12 }).ex, undefined, 'only the offered timers');
  assert.equal(expiryOf(new Date(T0).toISOString(), 86400), T0 + 86400_000);
  assert.equal(expiryOf(T0, 0), null);
  const list = [{ id: 'a', expiresAt: new Date(T0 - 1).toISOString() }, { id: 'b', expiresAt: T0 + 1 }, { id: 'c' }, { id: 'd', expiresAt: T0 }];
  assert.deepEqual(expiredIds(list, T0), ['a', 'd']);
});

test('session: messages over XMPP are marked as such; a control goes sealed to every device of both people', async () => {
  const sent = [];
  const delivered = [];
  const fake = { state: 'online', sendSealed: (args) => sent.push(args), setActive() {}, close() {}, checkNow() {} };
  let options;
  const session = await startXmppSession({
    sessionToken: 't', userId: ME, deliver: (event) => delivered.push(event), legacySend: () => { throw new Error('not the server'); },
    targetsFor: async () => ({ targets: ['dpeer@h', 'dmine2@h'], complete: true, sender: { userId: ME, deviceId: 'phone' } }),
    fetchImpl: async () => new Response(JSON.stringify({ transport: 'xmpp' }), { status: 200 }),
    createTransport: (opts) => { options = opts; return fake; },
    seal: async (peerId, content) => `e2e2:text|${JSON.stringify({ v: 2, sd: 'phone', d: {}, sealedFor: peerId, len: content.length })}`,
  });
  const content = controlContent({ op: 'delete', target: 'm2', peerId: PEER });
  assert.equal(await session.sendControl(PEER, content), true);
  assert.deepEqual(sent[0].to, ['dpeer@h', 'dmine2@h'], 'the devices of the contact and my other devices');
  assert.match(sent[0].envelope, /^e2e2:/, 'sealed: the server sees an ordinary message');
  assert.ok(!sent[0].envelope.includes('m2'), 'the target is inside the encryption');

  session.route({ type: 'message:send', message: { id: 'out1', receiverId: PEER, content: 'e2e2:text|{}' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delivered.find((event) => event.type === 'message:ack').message.via, 'xmpp');
  options.onEvent({ type: 'message', id: 'in1', from: 'dpeer@h/app', userId: PEER, deviceId: 'p1', envelope: `e2e2:text|${JSON.stringify({ v: 2, sd: 'p1', d: {} })}`, group: false });
  assert.equal(delivered.find((event) => event.type === 'message:new').message.via, 'xmpp');
});

test('session: no control without sealing or with a device that cannot be reached; groups stay on the server', async () => {
  const fake = { state: 'online', sendSealed() { throw new Error('nothing may be sent'); }, setActive() {}, close() {}, checkNow() {} };
  const start = (opts) => startXmppSession({
    sessionToken: 't', userId: ME, deliver: () => {}, legacySend: () => {},
    targetsFor: async () => ({ targets: ['dpeer@h'], complete: false, sender: { userId: ME, deviceId: 'phone' } }),
    groupTargetsFor: async () => ({ targets: ['d1@h'], complete: true, sender: { userId: ME, deviceId: 'phone' } }),
    fetchImpl: async () => new Response(JSON.stringify({ transport: 'xmpp' }), { status: 200 }),
    createTransport: () => fake, ...opts,
  });
  const noSeal = await start({});
  assert.equal(await noSeal.sendControl(PEER, 'ctl:{}'), false);
  const partial = await start({ seal: async () => 'e2e2:text|{}' });
  assert.equal(await partial.sendControl(PEER, 'ctl:{}'), false, 'a device without XMPP would miss it');
  const envelope = `e2e2:text|${JSON.stringify({ v: 2, sd: 'phone', mh: 'h', g: {} })}`;
  assert.equal(await partial.sendGroup({ groupId: 'g', messageId: 'gm', envelope }), null, 'groups go through the server until group controls exist');
});

test('the app sends changes to XMPP messages as controls and applies incoming ones through the same checks', () => {
  const chat = read('src/components/ChatWindow.jsx');
  assert.ok(chat.includes("if (sendControlFor(target, { op: 'edit', text: content })) return;"), 'edit');
  assert.ok(chat.includes("if (sendControlFor(target, { op: 'delete' })) useChatStore.getState().markMessageDeleted(target.id);"), 'delete for everyone, shown at once');
  assert.ok(chat.includes("if (!sendControlFor(message, { op: 'played' })) shared.send?.({ type: 'message:played', messageId: message.id });"), 'played');
  assert.ok(chat.includes("if (!overXmpp) client?.send?.({ type: 'message:delete', messageId: target.id, scope: 'me' });"), 'delete for me never asks the server about an XMPP message');
  const messaging = read('src/e2e/messaging.js');
  assert.ok(messaging.includes("if (sendControlFor(storedMessage(messageId, peerId), { op: 'react', emoji: emoji || null })) return true;"), 'reactions');
  assert.ok(messaging.includes("event.message?.via === 'xmpp' && typeof message?.content === 'string' && message.content.startsWith('ctl:')"), 'only an XMPP copy can carry a control');
  assert.ok(messaging.includes('disappearSeconds,\n    }, { fresh'), 'the chat timer is sealed in');
  const app = read('src/App.jsx');
  assert.ok(app.includes("if (event.type === 'message:control') { applyControl(event); return; }"));
  assert.ok(app.includes('for (const held of heldControls.take(event.message.id)) applyControl(held);'), 'held controls apply when their message arrives');
  assert.ok(app.includes('for (const messageId of expiredIds(list, now)) deleteMessage(chatId, messageId);'), 'the expiry sweep');
  const relay = read('android/app/src/main/java/io/github/bickworld555/hiddenchat/NativeRelay.java');
  assert.ok(relay.includes('if (socket != null && network.equals(boundNetwork)) return;'), 'the background connection follows a network change at once');
  assert.ok(relay.includes('if (socket != null) dropSocket();'));
});

test('retired devices: idle for 30 days, or on an XMPP account with no XMPP address for 10 minutes; connected or unknown stays', async () => {
  const { DEVICE_IDLE_MS, DEVICE_XMPP_GRACE_MS, isRetiredDevice } = await import('./e2e.mjs');
  const now = T0;
  const minutes = (n) => now - n * 60_000;
  assert.equal(isRetiredDevice({ lastActive: now - DEVICE_IDLE_MS - 1, hasXmpp: true, onXmpp: true, now }), true, 'idle for a month');
  assert.equal(isRetiredDevice({ lastActive: now - DEVICE_IDLE_MS + 60_000, hasXmpp: true, onXmpp: true, now }), false);
  assert.equal(isRetiredDevice({ lastActive: minutes(11), hasXmpp: false, onXmpp: true, now }), true, 'an install that has not run since the account moved');
  assert.equal(isRetiredDevice({ lastActive: now - DEVICE_XMPP_GRACE_MS + 1000, hasXmpp: false, onXmpp: true, now }), false, 'a fresh sign-in before its first token');
  assert.equal(isRetiredDevice({ lastActive: minutes(11), hasXmpp: false, onXmpp: false, now }), false, 'accounts not moved over keep every device');
  assert.equal(isRetiredDevice({ lastActive: now - DEVICE_IDLE_MS - 1, hasXmpp: false, onXmpp: true, now, connected: true }), false, 'connected now: never retired');
  for (const unknown of [null, undefined, 0, 'x']) assert.equal(isRetiredDevice({ lastActive: unknown, hasXmpp: false, onXmpp: true, now }), false, String(unknown));
  const e2e = read('server/e2e.mjs');
  assert.ok(e2e.includes('.filter((row) => !isRetiredDevice({ lastActive: row.lastActive, hasXmpp: Boolean(row.xmpp), onXmpp: moved, now: at, connected: connected.has(row.deviceId) }))'), 'every device list (sealing, checks, routing) applies it');
});
