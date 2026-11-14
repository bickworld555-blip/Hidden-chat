// The app's XMPP transport (src/xmpp/transport.js) against a scripted server that answers like ejabberd: sign-in,
// bind, Stream Management (acks, resume, failed resume), queued sends, the legacy answer, and every incoming event,
// including the check that a message's claimed sender owns the address it came from.
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { test } from 'node:test';
import { parseXml, xml, escapeXml, local, child } from '../src/xmpp/stanza.js';
import { deviceLocalpart, XmppTransport } from '../src/xmpp/transport.js';

const HOST = 'chat.hiddenmessenger.com';
const localpartOf = (userId, deviceId) => `d${createHash('sha256').update(`${userId}\n${deviceId}`).digest('hex').slice(0, 40)}`;
const ME = { userId: 'user-me', deviceId: 'phone' };
const MY_JID = `${localpartOf(ME.userId, ME.deviceId)}@${HOST}`;
const flush = () => new Promise((resolve) => setImmediate(resolve));

// A fake WebSocket + ejabberd. `script` decides how the server answers each frame the client sends.
function fakeServer({ resumeWith = null, enable = true } = {}) {
  const sockets = [];
  let smCounter = 0;
  const server = {
    sockets,
    resumeWith,
    createSocket(url) {
      const socket = { url, sent: [], readyState: 0, closed: false };
      socket.send = (frame) => {
        socket.sent.push(String(frame));
        const el = parseXml(String(frame));
        const name = local(el);
        const reply = (markup) => queueMicrotask(() => socket.onmessage?.({ data: String(markup) }));
        if (name === 'open') {
          reply(xml('open', { xmlns: 'urn:ietf:params:xml:ns:xmpp-framing', from: HOST, version: '1.0' }));
          const authed = socket.sent.some((f) => f.startsWith('<auth'));
          reply(authed
            ? xml('stream:features', { 'xmlns:stream': 'http://etherx.jabber.org/streams' }, [xml('bind', { xmlns: 'urn:ietf:params:xml:ns:xmpp-bind' }), xml('sm', { xmlns: 'urn:xmpp:sm:3' })])
            : xml('stream:features', { 'xmlns:stream': 'http://etherx.jabber.org/streams' }, xml('mechanisms', { xmlns: 'urn:ietf:params:xml:ns:xmpp-sasl' }, xml('mechanism', {}, 'PLAIN'))));
        } else if (name === 'auth') {
          const decoded = Buffer.from(el.text, 'base64').toString();
          socket.auth = decoded;
          reply(decoded.endsWith('\0good-token') ? xml('success', { xmlns: 'urn:ietf:params:xml:ns:xmpp-sasl' }) : xml('failure', { xmlns: 'urn:ietf:params:xml:ns:xmpp-sasl' }));
        } else if (name === 'iq' && el.attrs.id === 'bind') {
          reply(xml('iq', { type: 'result', id: 'bind' }, xml('bind', { xmlns: 'urn:ietf:params:xml:ns:xmpp-bind' }, xml('jid', {}, `${MY_JID}/app`))));
        } else if (name === 'enable') {
          smCounter += 1;
          reply(enable ? xml('enabled', { xmlns: 'urn:xmpp:sm:3', id: `sm-${smCounter}`, resume: 'true' }) : xml('failed', { xmlns: 'urn:xmpp:sm:3' }));
        } else if (name === 'resume') {
          socket.resumeRequest = el.attrs;
          reply(server.resumeWith === null ? xml('failed', { xmlns: 'urn:xmpp:sm:3' }) : xml('resumed', { xmlns: 'urn:xmpp:sm:3', h: server.resumeWith, previd: el.attrs.previd }));
        }
      };
      socket.close = () => { if (socket.closed) return; socket.closed = true; queueMicrotask(() => socket.onclose?.()); };
      socket.deliver = (markup) => socket.onmessage?.({ data: String(markup) });
      sockets.push(socket);
      queueMicrotask(() => { socket.readyState = 1; socket.onopen?.(); });
      return socket;
    },
  };
  return server;
}

function transport(server, { grant = { transport: 'xmpp', jid: MY_JID, token: 'good-token', websocket: `wss://${HOST}/xmpp-websocket` } } = {}) {
  const events = [];
  const states = [];
  const timers = [];
  const t = new XmppTransport({
    fetchToken: async () => grant,
    onEvent: (event) => events.push(event),
    onState: (state) => states.push(state),
    createSocket: server.createSocket,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {},
    subtle: webcrypto.subtle,
    random: () => 0.5,
  });
  return { t, events, states, timers };
}
async function until(check, label) {
  for (let i = 0; i < 200; i += 1) { if (check()) return; await flush(); }
  throw new Error(`timeout: ${label}`);
}
const sentNames = (socket) => socket.sent.map((frame) => local(parseXml(frame)));

test('stanzas: built XML escapes text and attributes, parses back, and malformed frames are refused', () => {
  const built = String(xml('message', { to: 'a@b', id: `x"<&'` }, [xml('body', {}, 'one < two & "three"'), 'tail']));
  const el = parseXml(built);
  assert.equal(el.attrs.id, `x"<&'`);
  assert.equal(child(el, 'body').text, 'one < two & "three"');
  assert.equal(el.text, 'tail');
  assert.equal(parseXml("<a b='1'><c/>&#x41;&#66;</a>").text, 'AB');
  for (const bad of ['<a>', '<a></b>', 'text', '<a/><b/>', '<a b=1/>', '']) assert.equal(parseXml(bad), null, bad);
  assert.equal(escapeXml(`<'&">`), '&lt;&apos;&amp;&quot;&gt;');
});

test('the device address matches the server\'s derivation', async () => {
  assert.equal(await deviceLocalpart('user-1', 'Dev', webcrypto.subtle), localpartOf('user-1', 'Dev'));
});

test('signs in with the token, binds, enables Stream Management, announces presence and comes online', async () => {
  const server = fakeServer();
  const { t, states } = transport(server);
  await t.connect();
  await until(() => t.state === 'online', 'online');
  const socket = server.sockets[0];
  assert.equal(socket.url, `wss://${HOST}/xmpp-websocket`);
  assert.equal(socket.auth, `\0${MY_JID.split('@')[0]}\0good-token`, 'SASL PLAIN with the device address and token');
  assert.deepEqual(sentNames(socket), ['open', 'auth', 'open', 'iq', 'enable', 'presence', 'active']);
  assert.equal(t.fullJid, `${MY_JID}/app`);
  assert.deepEqual(states, ['connecting', 'online']);
  t.close();
  assert.equal(t.state, 'closed');
});

test('an account not moved over stays on the current path: no socket is opened', async () => {
  const server = fakeServer();
  const { t, states } = transport(server, { grant: { transport: 'legacy' } });
  await t.connect();
  assert.equal(server.sockets.length, 0);
  assert.deepEqual(states, ['connecting', 'legacy']);
});

test('sends wait while offline and go out once online; a refused sign-in closes and retries later', async () => {
  const server = fakeServer();
  const { t, timers } = transport(server);
  t.sendSealed({ id: 'm1', to: [`${localpartOf('peer', 'p1')}@${HOST}`], envelope: 'e2e2:text|{"v":2}', sender: ME });
  await t.connect();
  await until(() => t.state === 'online', 'online');
  const message = server.sockets[0].sent.map((f) => parseXml(f)).find((el) => local(el) === 'message');
  assert.equal(message.attrs.id, 'm1');
  const hm = child(message, 'hm', 'urn:hiddenmessenger:1');
  assert.deepEqual([hm.attrs.u, hm.attrs.d], [ME.userId, ME.deviceId]);
  assert.equal(Buffer.from(hm.text, 'base64').toString(), 'e2e2:text|{"v":2}', 'the sealed envelope, untouched');
  assert.ok(child(message, 'request', 'urn:xmpp:receipts') && child(message, 'store', 'urn:xmpp:hints'));
  t.close();

  const refused = fakeServer();
  const bad = transport(refused, { grant: { transport: 'xmpp', jid: MY_JID, token: 'stale', websocket: 'wss://x/xmpp-websocket' } });
  await bad.t.connect();
  await until(() => bad.t.state === 'offline' && bad.timers.length > 0, 'retry scheduled');
  assert.ok(bad.timers.at(-1).ms >= 800 && bad.timers.at(-1).ms <= 1200, 'first retry after about a second');
  bad.t.close();
  void timers;
});

test('several devices go as one <fanout>; direct (g=0) and group (g=1) are told apart', async () => {
  const server = fakeServer();
  const { t } = transport(server);
  await t.connect();
  await until(() => t.state === 'online', 'online');
  const a = `${localpartOf('peer', 'p1')}@${HOST}`;
  const b = `${localpartOf('peer', 'p2')}@${HOST}`;
  t.sendSealed({ id: 'm2', to: [a, b, a], envelope: 'e2e2:text|{}', sender: ME });
  t.sendSealed({ id: 'g1', to: [a], envelope: 'e2e2:text|{}', sender: ME, group: true });
  const fanouts = server.sockets[0].sent.map((f) => parseXml(f)).filter((el) => child(el, 'fanout'));
  assert.equal(fanouts.length, 2);
  const direct = child(fanouts[0], 'fanout');
  assert.equal(fanouts[0].attrs.to, HOST, 'addressed to the server, which splits it');
  assert.deepEqual([direct.attrs.g, direct.attrs.u, direct.attrs.d], ['0', ME.userId, ME.deviceId]);
  assert.deepEqual(direct.children.map((item) => item.attrs.to), [a.split('@')[0], b.split('@')[0]], 'each device once');
  assert.equal(child(fanouts[1], 'fanout').attrs.g, '1');
  t.close();
});

test('Stream Management: acknowledged stanzas are forgotten; after a drop the session resumes and resends the rest', async () => {
  const server = fakeServer();
  const { t, timers } = transport(server);
  await t.connect();
  await until(() => t.state === 'online', 'online');
  const to = `${localpartOf('peer', 'p1')}@${HOST}`;
  for (const id of ['s1', 's2', 's3']) t.sendSealed({ id, to: [to], envelope: `e2e2:text|${id}`, sender: ME });
  server.sockets[0].deliver(xml('a', { xmlns: 'urn:xmpp:sm:3', h: '2' }));
  assert.deepEqual(t.sm.unacked.length, 1, 's3 is still unacknowledged');
  // The server asks how much we have handled: nothing yet.
  server.sockets[0].deliver(xml('r', { xmlns: 'urn:xmpp:sm:3' }));
  assert.match(server.sockets[0].sent.at(-1), /<a xmlns="urn:xmpp:sm:3" h="0"\/>/);

  server.resumeWith = '2';              // the server got s1 and s2 before the drop
  server.sockets[0].close();
  await until(() => t.state === 'offline' && timers.length > 0, 'retry scheduled');
  timers.at(-1).fn();
  await until(() => t.state === 'online', 'back online');
  const second = server.sockets[1];
  assert.equal(second.resumeRequest.previd, 'sm-1', 'resumes the same session');
  const resent = second.sent.map((f) => parseXml(f)).filter((el) => local(el) === 'message').map((el) => el.attrs.id);
  assert.deepEqual(resent, ['s3'], 'only what the server had not acknowledged');
  assert.ok(!sentNames(second).includes('presence'), 'a resumed session keeps its presence');
  t.close();
});

test('a failed resume starts a fresh session and still resends what was never acknowledged', async () => {
  const server = fakeServer();
  const { t, timers } = transport(server);
  await t.connect();
  await until(() => t.state === 'online', 'online');
  t.sendSealed({ id: 'lost', to: [`${localpartOf('peer', 'p1')}@${HOST}`], envelope: 'e2e2:text|x', sender: ME });
  server.resumeWith = null;             // the server forgot the session
  server.sockets[0].close();
  await until(() => timers.length > 0, 'retry');
  timers.at(-1).fn();
  await until(() => t.state === 'online', 'online again');
  const names = sentNames(server.sockets[1]);
  assert.deepEqual(names.slice(0, 6), ['open', 'auth', 'open', 'resume', 'iq', 'enable']);
  assert.ok(server.sockets[1].sent.some((f) => f.includes('id="lost"')), 'the unacknowledged message goes again');
  t.close();
});

test('incoming: messages from their true sender, receipts, read markers, typing, fan-out acks and errors', async () => {
  const server = fakeServer();
  const { t, events } = transport(server);
  await t.connect();
  await until(() => t.state === 'online', 'online');
  const peer = { userId: 'user-peer', deviceId: 'tablet' };
  const peerJid = `${localpartOf(peer.userId, peer.deviceId)}@${HOST}`;
  const socket = server.sockets[0];
  const sealed = (from, u, d) => xml('message', { from: `${from}/app`, id: 'in1', type: 'chat' }, [
    xml('hm', { xmlns: 'urn:hiddenmessenger:1', v: '1', u, d }, Buffer.from('e2e2:text|{"v":2}').toString('base64')),
    xml('delay', { xmlns: 'urn:xmpp:delay', stamp: '2026-11-15T10:00:00Z' }),
  ]);
  socket.deliver(sealed(peerJid, peer.userId, peer.deviceId));
  socket.deliver(sealed(peerJid, 'someone-else', peer.deviceId));     // claims another user's identity
  socket.deliver(xml('message', { from: `${peerJid}/app` }, xml('received', { xmlns: 'urn:xmpp:receipts', id: 'm1' })));
  socket.deliver(xml('message', { from: `${peerJid}/app` }, xml('displayed', { xmlns: 'urn:xmpp:chat-markers:0', id: 'm1' })));
  socket.deliver(xml('message', { from: `${peerJid}/app`, type: 'chat' }, xml('composing', { xmlns: 'http://jabber.org/protocol/chatstates' })));
  socket.deliver(xml('message', { from: HOST }, xml('fanout-ack', { xmlns: 'urn:hiddenmessenger:fanout:1', id: 'm2', n: '2' })));
  socket.deliver(xml('message', { from: peerJid, id: 'm9', type: 'error' }, xml('error', { type: 'cancel' }, xml('not-allowed', { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' }))));
  await until(() => events.length === 7, 'all events');
  assert.deepEqual(events[0], { type: 'message', id: 'in1', from: `${peerJid}/app`, userId: peer.userId, deviceId: peer.deviceId, envelope: 'e2e2:text|{"v":2}', group: false, groupId: null, sentAt: '2026-11-15T10:00:00Z' });
  assert.deepEqual(events[1], { type: 'rejected', id: 'in1', from: `${peerJid}/app`, reason: 'sender' });
  assert.deepEqual(events.slice(2).map((e) => e.type), ['receipt', 'displayed', 'chatstate', 'fanout-ack', 'error']);
  assert.equal(events[5].delivered, 2);
  assert.equal(events[6].condition, 'not-allowed');
  assert.equal(t.sm.inbound, 7, 'every stanza counted for the server\'s acks');
  t.close();
});

test('receipts, read markers, typing and background state are the standard stanzas', async () => {
  const server = fakeServer();
  const { t } = transport(server);
  await t.connect();
  await until(() => t.state === 'online', 'online');
  const to = `${localpartOf('peer', 'p1')}@${HOST}/app`;
  t.sendReceipt(to, 'm1');
  t.sendDisplayed(to, 'm1');
  t.sendChatState(to, 'composing');
  assert.equal(t.sendChatState(to, 'dancing'), false);
  t.setActive(false);
  const tail = server.sockets[0].sent.slice(-4).map((f) => parseXml(f));
  assert.equal(child(tail[0], 'received', 'urn:xmpp:receipts').attrs.id, 'm1');
  assert.equal(child(tail[1], 'displayed', 'urn:xmpp:chat-markers:0').attrs.id, 'm1');
  assert.ok(child(tail[2], 'composing') && child(tail[2], 'no-store', 'urn:xmpp:hints'));
  assert.equal(local(tail[3]), 'inactive');
  t.close();
});

// --- The app's XMPP session (src/xmpp/session.js) -----------------------------------------------------------------

import { startXmppSession } from '../src/xmpp/session.js';

function sessionHarness({ transportAnswer = 'xmpp', targets = { targets: ['d1@h', 'd2@h'], complete: true, sender: ME } } = {}) {
  const delivered = [];
  const legacy = [];
  const fake = { state: 'online', sent: [], connects: 0, connect() { this.connects += 1; }, sendChatState(to, state, opts) { this.sent.push(['chatstate', to, state, opts?.kind ?? null]); }, sendSealed(args) { this.sent.push(['sealed', args]); }, sendReceipt(to, id) { this.sent.push(['receipt', to, id]); }, sendDisplayed(to, id) { this.sent.push(['displayed', to, id]); }, setActive() {}, close() {} };
  let options;
  const start = () => startXmppSession({
    sessionToken: 't', userId: ME.userId, deliver: (event) => delivered.push(event), legacySend: (event) => legacy.push(event),
    targetsFor: async (peerId, opts) => (opts?.peerOnly ? { ...targets, targets: targets.targets.slice(0, 1) } : targets),
    userForAddress: (address) => (String(address).startsWith('dpeer@h') ? 'user-peer' : null),
    fetchImpl: async (path) => new Response(JSON.stringify(path.endsWith('/transport') ? { enabled: true, transport: transportAnswer } : {}), { status: 200 }),
    createTransport: (opts) => { options = opts; return fake; },
  });
  return { start, delivered, legacy, fake, options: () => options };
}
const envelopeFrom = (deviceId) => `e2e2:text|${JSON.stringify({ v: 2, sd: deviceId, d: {} })}`;

test('session: an account not moved over never starts one', async () => {
  const h = sessionHarness({ transportAnswer: 'legacy' });
  assert.equal(await h.start(), null);
});

test('session: a sealed message goes over XMPP only when every target device is reachable, else the current path', async () => {
  const h = sessionHarness();
  const session = await h.start();
  const event = { type: 'message:send', message: { id: 'm1', receiverId: 'peer', content: envelopeFrom('phone') } };
  assert.equal(session.route(event), true);
  await flush();
  assert.equal(h.fake.sent[0][0], 'sealed');
  assert.deepEqual(h.fake.sent[0][1].to, ['d1@h', 'd2@h']);
  assert.equal(h.delivered[0].type, 'message:ack', 'one tick, as today');
  assert.equal(h.legacy.length, 0);

  const partial = sessionHarness({ targets: { targets: ['d1@h'], complete: false, sender: ME } });
  const s2 = await partial.start();
  s2.route(event);
  await flush();
  assert.equal(partial.fake.sent.length, 0);
  assert.deepEqual(partial.legacy, [event], 'a device without XMPP: the server reaches every device');
  assert.equal(s2.route({ type: 'chat:disappearing', peerId: 'p', seconds: 5 }), false, 'other events stay on the current connection');
});

test('session: a refusal from ejabberd resends the message through the current path', async () => {
  const h = sessionHarness();
  const session = await h.start();
  const event = { type: 'message:send', message: { id: 'm7', receiverId: 'peer', content: envelopeFrom('phone') } };
  session.route(event);
  await flush();
  h.options().onEvent({ type: 'error', id: 'm7', condition: 'not-allowed' });
  assert.deepEqual(h.legacy, [event]);
});

test('session: incoming messages need the envelope to name the sending device; receipts and reads flow both ways', async () => {
  const h = sessionHarness();
  const session = await h.start();
  const { onEvent } = h.options();
  onEvent({ type: 'message', id: 'in1', from: 'dpeer@h/app', userId: 'user-peer', deviceId: 'tablet', envelope: envelopeFrom('tablet'), sentAt: '2026-11-15T10:00:00Z' });
  onEvent({ type: 'message', id: 'in2', from: 'dpeer@h/app', userId: 'user-peer', deviceId: 'tablet', envelope: envelopeFrom('another-device') });
  assert.equal(h.delivered.length, 1, 'an envelope from another device is dropped');
  assert.deepEqual(h.delivered[0], { type: 'message:new', message: { id: 'in1', senderId: 'user-peer', receiverId: ME.userId, content: envelopeFrom('tablet'), timestamp: '2026-11-15T10:00:00Z', status: 'sent' } });

  // The early "delivered" is not sent for XMPP messages: the receipt waits until the message is stored (queue:ack).
  assert.equal(session.route({ type: 'message:delivered', messageIds: ['in1', 'legacy-1'] }), true);
  assert.ok(!h.fake.sent.some((item) => item[0] === 'receipt'), 'no receipt before local storage');
  assert.deepEqual(h.legacy.at(-1), { type: 'message:delivered', messageIds: ['legacy-1'] }, 'messages that came the old way are acknowledged the old way');
  assert.equal(session.route({ type: 'queue:ack', messageIds: ['in1', 'legacy-2'], eventIds: [] }), true);
  assert.deepEqual(h.fake.sent.at(-1), ['receipt', 'dpeer@h/app', 'in1'], 'stored (attachment included): now the receipt');
  assert.deepEqual(h.legacy.at(-1), { type: 'queue:ack', messageIds: ['legacy-2'], eventIds: [] });
  assert.equal(session.route({ type: 'message:read', messageId: 'in1' }), true);
  assert.deepEqual(h.fake.sent.at(-1), ['displayed', 'dpeer@h/app', 'in1']);
  assert.equal(session.route({ type: 'message:read', messageId: 'legacy-1' }), false);

  onEvent({ type: 'receipt', id: 'mine-1' });
  onEvent({ type: 'displayed', id: 'mine-1' });
  assert.deepEqual(h.delivered.slice(-2), [{ type: 'message:status', messageId: 'mine-1', status: 'delivered' }, { type: 'message:status', messageId: 'mine-1', status: 'read' }]);
});

test("session: typing goes to the contact's devices over XMPP and comes back as presence:typing; wake-up reconnects", async () => {
  const h = sessionHarness();
  const session = await h.start();
  assert.equal(session.route({ type: 'presence:typing', peerId: 'peer', active: true, kind: 'recording' }), true);
  await flush();
  assert.deepEqual(h.fake.sent.at(-1), ['chatstate', 'd1@h', 'composing', 'recording'], "the contact's devices only, with the activity");
  session.route({ type: 'presence:typing', peerId: 'peer', active: false });
  await flush();
  assert.equal(h.fake.sent.at(-1)[2], 'paused');
  assert.equal(session.route({ type: 'presence:typing', groupId: 'g1', active: true }), false, 'group typing stays on the current connection');

  const { onEvent } = h.options();
  onEvent({ type: 'chatstate', from: 'dpeer@h/app', state: 'composing', kind: 'typing' });
  onEvent({ type: 'chatstate', from: 'dstranger@h/app', state: 'composing', kind: 'typing' });
  assert.deepEqual(h.delivered.filter((e) => e.type === 'presence:typing'), [{ type: 'presence:typing', userId: 'user-peer', active: true, kind: 'typing' }], 'unknown devices are ignored');

  h.fake.state = 'offline';
  session.wake();
  assert.equal(h.fake.connects, 1, 'a wake-up push reconnects a dropped connection');
  h.fake.state = 'online';
  session.wake();
  assert.equal(h.fake.connects, 1, 'an open connection is left alone');
});

test('session: when XMPP is down, everything takes the current path at once', async () => {
  const h = sessionHarness();
  const session = await h.start();
  h.fake.state = 'connecting';
  for (const event of [
    { type: 'message:send', message: { id: 'x1', receiverId: 'peer', content: envelopeFrom('phone') } },
    { type: 'presence:typing', peerId: 'peer', active: true },
    { type: 'queue:ack', messageIds: ['a'], eventIds: [] },
  ]) assert.equal(session.route(event), false, `${event.type} goes the current way while XMPP is not online`);
});

test('transport: a recording voice note travels as composing + activity and is read back', async () => {
  const server = fakeServer();
  const { t, events } = transport(server);
  await t.connect();
  await until(() => t.state === 'online', 'online');
  t.sendChatState('dpeer@h/app', 'composing', { kind: 'recording' });
  const sent = parseXml(server.sockets[0].sent.at(-1));
  assert.ok(child(sent, 'composing') && child(sent, 'activity', 'urn:hiddenmessenger:1').attrs.kind === 'recording');
  server.sockets[0].deliver(String(sent).replace ? server.sockets[0].sent.at(-1).replace('to="dpeer@h/app"', 'from="dpeer@h/app"') : '');
  await until(() => events.length === 1, 'chatstate');
  assert.deepEqual(events[0], { type: 'chatstate', from: 'dpeer@h/app', state: 'composing', kind: 'recording' });
  t.close();
});

test('transport: call signals travel live-only in <call>, group fan-outs carry gid and mh, group copies report their group', async () => {
  const server = fakeServer();
  const { t, events } = transport(server);
  await t.connect();
  await until(() => t.state === 'online', 'online');
  t.sendCall('dpeer@h/app', { callId: 'c1', mode: 'video', signalId: 's1' }, { type: 'ice', candidate: { candidate: 'a=1' } });
  const callStanza = parseXml(server.sockets[0].sent.at(-1));
  const call = child(callStanza, 'call', 'urn:hiddenmessenger:call:1');
  assert.deepEqual([call.attrs.id, call.attrs.mode, call.attrs.sid, JSON.parse(call.text).type], ['c1', 'video', 's1', 'ice']);
  assert.ok(child(callStanza, 'no-store', 'urn:xmpp:hints'), 'never stored');
  t.sendSealed({ id: 'g1', to: ['d1@h', 'd2@h'], envelope: 'e2e2:text|{}', sender: ME, group: true, groupId: 'grp-1', membersHash: 'mh-1' });
  const fan = child(parseXml(server.sockets[0].sent.at(-1)), 'fanout');
  assert.deepEqual([fan.attrs.g, fan.attrs.gid, fan.attrs.mh], ['1', 'grp-1', 'mh-1']);

  const peer = { userId: 'user-peer', deviceId: 'tab' };
  const peerJid = `${localpartOf(peer.userId, peer.deviceId)}@${HOST}`;
  server.sockets[0].deliver(xml('message', { from: `${peerJid}/app`, id: 'gm1', type: 'chat' }, xml('hm', { xmlns: 'urn:hiddenmessenger:1', v: '1', g: '1', gid: 'grp-1', u: peer.userId, d: peer.deviceId }, Buffer.from('e2e2:text|{}').toString('base64'))));
  server.sockets[0].deliver(xml('message', { from: `${peerJid}/app`, type: 'chat', id: 's9' }, xml('call', { xmlns: 'urn:hiddenmessenger:call:1', id: 'c1', mode: 'audio', sid: 's9' }, JSON.stringify({ type: 'media', video: false }))));
  await until(() => events.length === 2, 'events');
  assert.deepEqual([events[0].group, events[0].groupId], [true, 'grp-1']);
  assert.deepEqual(events[1], { type: 'call', from: `${peerJid}/app`, callId: 'c1', mode: 'audio', roomId: null, signalId: 's9', signal: { type: 'media', video: false } });
  t.close();
});

test("session calls: the server keeps the call's life; once both addresses are known the other signals go direct", async () => {
  const h = sessionHarness();
  h.fake.fullJid = 'dme0000000000000000000000000000000000000000@h/app';
  h.fake.sendCall = (to, meta, signal) => { h.fake.sent.push(['call', to, meta, signal]); return true; };
  const session = await h.start();
  const peerAddress = `d${'a'.repeat(40)}@h/app`;
  const callEvent = (signal, extra = {}) => ({ type: 'call:signal', callId: 'call-1', mode: 'video', targetId: 'user-peer', signalId: crypto.randomUUID(), signal, ...extra });

  // Before the other side is known everything (and the first offer) goes through the server, with our address.
  assert.equal(session.route(callEvent({ type: 'ice', candidate: {} })), false);
  assert.equal(session.route(callEvent({ type: 'offer', sdp: 'v=0' })), true);
  assert.equal(h.legacy.at(-1).signal.x, h.fake.fullJid);
  // The callee's answer arrives through the server with its address.
  session.observe({ type: 'call:signal', from: 'user-peer', callId: 'call-1', signal: { type: 'answer', sdp: 'v=0', x: peerAddress } });
  assert.equal(session.route(callEvent({ type: 'ice', candidate: { candidate: 'c' } })), true);
  assert.deepEqual(h.fake.sent.at(-1).slice(0, 2), ['call', peerAddress]);
  assert.equal(session.route(callEvent({ type: 'offer', sdp: 'restart' })), true, 'an ICE-restart offer goes direct too');
  assert.equal(h.fake.sent.at(-1)[3].sdp, 'restart');

  // Incoming direct signals are only taken from that device.
  const { onEvent } = h.options();
  onEvent({ type: 'call', from: peerAddress, callId: 'call-1', mode: 'video', signalId: 'x1', signal: { type: 'ice', candidate: {} } });
  onEvent({ type: 'call', from: `d${'b'.repeat(40)}@h/app`, callId: 'call-1', mode: 'video', signalId: 'x2', signal: { type: 'ice' } });
  const calls = h.delivered.filter((e) => e.type === 'call:signal');
  assert.deepEqual(calls.map((e) => [e.from, e.signalId]), [['user-peer', 'x1']]);

  // A refusal goes through the server; the end always does, and forgets the call.
  const refused = callEvent({ type: 'media', video: false }, { signalId: 'sig-refused' });
  session.route(refused);
  onEvent({ type: 'error', id: 'sig-refused', condition: 'not-allowed' });
  assert.equal(h.legacy.at(-1), refused);
  assert.equal(session.route(callEvent({ type: 'end', reason: 'ended' })), false);
  assert.equal(session.route(callEvent({ type: 'ice', candidate: {} })), false, 'after the end nothing goes direct');
});

test('session groups: all member devices on XMPP -> one fan-out; otherwise the server; nobody reached -> server resend', async () => {
  const h = sessionHarness();
  let groupTargets = { targets: ['d1@h', 'd2@h'], complete: true, sender: ME };
  const session = await startXmppSession({
    sessionToken: 't', userId: ME.userId, deliver: (e) => h.delivered.push(e), legacySend: (e) => h.legacy.push(e),
    targetsFor: async () => ({ targets: [], complete: false, sender: ME }), groupTargetsFor: async () => groupTargets,
    fetchImpl: async () => new Response(JSON.stringify({ transport: 'xmpp' }), { status: 200 }),
    createTransport: (opts) => { h.opts = opts; return h.fake; },
  });
  const envelope = `e2e2:text|${JSON.stringify({ v: 2, sd: 'phone', mh: 'hash-1', g: {} })}`;
  let resent = 0;
  const row = await session.sendGroup({ groupId: 'grp-1', messageId: 'gm-1', envelope, fallback: () => { resent += 1; } });
  assert.deepEqual([row.id, row.groupId, row.content], ['gm-1', 'grp-1', envelope]);
  const sealed = h.fake.sent.at(-1)[1];
  assert.deepEqual([sealed.group, sealed.groupId, sealed.membersHash, sealed.to], [true, 'grp-1', 'hash-1', ['d1@h', 'd2@h']]);
  h.opts.onEvent({ type: 'fanout-ack', id: 'gm-1', delivered: 0 });
  assert.equal(resent, 1, 'nobody reached (stale hash, no right to post): sent through the server');
  h.opts.onEvent({ type: 'fanout-ack', id: 'gm-1', delivered: 0 });
  assert.equal(resent, 1, 'once');

  groupTargets = { targets: ['d1@h'], complete: false, sender: ME };
  assert.equal(await session.sendGroup({ groupId: 'grp-1', messageId: 'gm-2', envelope }), null, 'a member device not on XMPP: the server path');

  h.opts.onEvent({ type: 'message', id: 'in-g', from: 'dpeer@h/app', userId: 'user-peer', deviceId: 'tablet', envelope: `e2e2:text|${JSON.stringify({ v: 2, sd: 'tablet', mh: 'h', g: {} })}`, group: true, groupId: 'grp-1', sentAt: '2026-11-15T10:00:00Z' });
  const incoming = h.delivered.find((e) => e.type === 'group:message');
  assert.deepEqual([incoming.message.id, incoming.message.groupId, incoming.message.senderId, incoming.message.createdAt], ['in-g', 'grp-1', 'user-peer', Date.parse('2026-11-15T10:00:00Z')]);
});
