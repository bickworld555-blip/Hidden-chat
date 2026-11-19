// The background page's relay fetch (src/background/relayFetch.js): what a relay account's phone does when a push wakes
// it with the app closed. It connects as a background device, hands each waiting message to the page (open, store,
// notify with the real text, receipt, ack), and ends once the server goes quiet. Seen on the S23 (2026-11-19): before
// this, the background page stopped at "not-on-xmpp" and every message showed as "🔒 Message".
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { relayFetch } from '../src/background/relayFetch.js';

function fakeSocket() {
  const socket = { sent: [], closed: false, send(data) { this.sent.push(JSON.parse(data)); }, close() { this.closed = true; } };
  socket.emit = (event) => socket.onmessage?.({ data: JSON.stringify(event) });
  return socket;
}

test('relay fetch: background device, every waiting message handled in order, ends quiet once the server is done', async () => {
  const socket = fakeSocket();
  let protocols = [];
  const handled = [];
  const done = relayFetch({
    token: 'tok', url: 'wss://example.test/ws', idleMs: 40, maxMs: 2000,
    createSocket: (url, offered) => { protocols = offered; return socket; },
    handle: async (event, send) => { await new Promise((resolve) => setTimeout(resolve, 5)); handled.push(event.message.id); send({ type: 'message:delivered', messageIds: [event.message.id] }); },
  });
  assert.ok(protocols.includes('relay.auth.tok') && protocols.includes('relay.background'), 'a background device: it never makes the person online');
  socket.emit({ type: 'connection:ready' });
  for (const id of ['m1', 'm2', 'm3', 'm4', 'm5']) socket.emit({ type: 'message:new', message: { id } });
  socket.emit({ type: 'group:message', message: { id: 'g1', groupId: 'grp' } });
  socket.emit({ type: 'presence:update', userId: 'x' });
  assert.equal(await done, 'quiet');
  assert.deepEqual(handled, ['m1', 'm2', 'm3', 'm4', 'm5', 'g1'], 'all five back-to-back messages and the group message, in order');
  assert.deepEqual(socket.sent.map((event) => event.messageIds[0]), ['m1', 'm2', 'm3', 'm4', 'm5', 'g1'], 'a receipt for each');
  assert.equal(socket.closed, true);
});

test('relay fetch: no connection is "offline" (Android then shows the sealed notice), and the app opening stops it', async () => {
  const dead = fakeSocket();
  const offline = relayFetch({ token: 't', url: 'wss://x/ws', createSocket: () => dead, handle: async () => {}, idleMs: 20, maxMs: 500 });
  dead.onerror?.();
  assert.equal(await offline, 'offline');
  const live = fakeSocket();
  const stop = { onStop: null };
  const stopped = relayFetch({ token: 't', url: 'wss://x/ws', createSocket: () => live, handle: async () => {}, idleMs: 1000, maxMs: 5000, stop });
  live.emit({ type: 'connection:ready' });
  stop.onStop();
  assert.equal(await stopped, 'stopped');
});

test('the background page uses the relay fetch for relay accounts and acknowledges only what it stored', () => {
  const page = readFileSync(new URL('../src/background/main.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(!page.includes("if (!session) return 'not-on-xmpp';"), 'no longer gives up on relay accounts');
  assert.ok(page.includes('const reason = await relayFetch({'));
  assert.ok(page.includes("if (saved && acknowledgeable(message) && !attachmentToKeep(event?.message?.content)) send({ type: 'queue:ack', messageIds: [message.id], eventIds: [] });"));
  assert.ok(page.includes("return reason === 'quiet' ? 'done' : `relay: ${reason}`;"), 'only a complete fetch lets Android skip the sealed notice');
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.ok(app.includes("apiFetch('/api/v1/push/relay-wake'"), 'the app tells the server it can be woken');
  // Seen on the S23 (second run): a wake-up only pinged the old socket (8 s to call it dead) and told Android it was done
  // after 6 s, so the app slept before reconnecting and the sealed notice came instead. Now it reconnects at once and
  // reports done only once what waited has arrived and been handled.
  assert.ok(app.includes('Promise.resolve(client?.reconnectNow?.() ?? client?.wake?.())'), 'a woken app reconnects at once');
  assert.ok(app.includes('Date.now() - Math.max(lastRealtimeEventRef.current, relayWakeRef.current.extendedAt, started) < RELAY_WAKE_QUIET_MS'), 'and waits until nothing more arrives');
  assert.ok(!app.includes('RELAY_WAKE_SETTLE_MS'));
  const realtime = readFileSync(new URL('../src/realtime.js', import.meta.url), 'utf8');
  assert.ok(realtime.includes('reconnectNow({ timeoutMs = 10_000 } = {}) {') && realtime.includes("old.close(4001, 'push wake')"), 'without first asking a socket Android may have cut');
});

test('back-to-back wake-ups make one fetch in the app, kept going by each push; the background fetch is a relay.fetch device', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.ok(app.includes('relayWakeRef.current.extendedAt = Date.now();\n        if (relayWakeRef.current.running) return;') || app.includes('relayWakeRef.current.extendedAt = Date.now();\r\n        if (relayWakeRef.current.running) return;'), 'a later push extends the running fetch');
  assert.ok(app.includes('Math.max(lastRealtimeEventRef.current, relayWakeRef.current.extendedAt, started) < RELAY_WAKE_QUIET_MS'));
  assert.ok(app.includes("nativeBackgroundFetchDone(connected ? 'quiet' : 'relay')"), 'Android hears "done" only when the one fetch ends: quiet after a fresh connection brought everything');
  // Seen in the desktop→S23 run: the app posted the real notification before the push arrived, and 8 s later the sealed
  // notice replaced it (Android counted only notifications after the push). A completed fetch now says "quiet".
  assert.ok(app.includes('connected = opened === true;'));
  // Calls: no server round trip before ringing someone already in the chat list.
  assert.ok(app.includes('if (sessionToken && !targetChat) {'), 'no wait for someone already in the chat list');
  const fetch = readFileSync(new URL('../src/background/relayFetch.js', import.meta.url), 'utf8');
  assert.ok(fetch.includes("'relay.background', 'relay.fetch']"));
});
