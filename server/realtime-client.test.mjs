// The app's chat connection notices a dead socket by itself (src/realtime.js): a phone switching between Wi-Fi and
// mobile data keeps its old socket "open" while nothing gets through. A fake socket and fake timers stand in.
import test, { beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

class FakeSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static all = [];
  constructor(url, protocols) {
    super();
    Object.assign(this, { url, protocols, readyState: FakeSocket.CONNECTING, sent: [], closedWith: null });
    FakeSocket.all.push(this);
  }
  send(frame) { this.sent.push(JSON.parse(frame)); }
  // A dead network: close() starts the handshake, but no 'close' event ever comes back.
  close(code) { this.closedWith = code ?? 1000; this.readyState = FakeSocket.CLOSING; }
  open() { this.readyState = FakeSocket.OPEN; this.dispatchEvent(new Event('open')); }
  receive(event) { this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(event) })); }
  serverClose(code = 1006) { this.readyState = FakeSocket.CLOSED; this.dispatchEvent(Object.assign(new Event('close'), { code, reason: '' })); }
}

const connection = new EventTarget();
globalThis.WebSocket = FakeSocket;
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
globalThis.window = Object.assign(new EventTarget(), {
  setTimeout: (...args) => setTimeout(...args),
  clearTimeout: (timer) => clearTimeout(timer),
});
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true, connection }, configurable: true });
globalThis.location = { href: 'https://hiddenmessenger.com/' };

const { RealtimeClient, ACK_TIMEOUT_MS, PING_INTERVAL_MS, PONG_TIMEOUT_MS, STATE_DEBOUNCE_MS } = await import('../src/realtime.js');

let states;
let client;
let now;
const latest = () => FakeSocket.all.at(-1);
const advance = (ms) => { now += ms; mock.timers.tick(ms); };

function start() {
  states = [];
  client = new RealtimeClient('token', () => {}, (state) => states.push(state));
  client.connect();
  latest().open();
  return latest();
}

beforeEach(() => {
  client?.close();                                   // a failed test must not leave its listeners behind
  FakeSocket.all = [];
  now = 1_000_000;
  mock.timers.reset();
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
});

test('a socket that stops answering is replaced within a ping and a pong timeout, and the outbox replays', () => {
  const first = start();
  let replays = 0;
  client.onReady = () => { replays += 1; };
  advance(PING_INTERVAL_MS);
  assert.deepEqual(first.sent.at(-1), { type: 'client:ping' });
  first.receive({ type: 'pong' });
  advance(PONG_TIMEOUT_MS);
  assert.equal(FakeSocket.all.length, 1, 'a socket that answers stays');
  advance(PING_INTERVAL_MS);                        // the network silently goes away: the next ping gets nothing
  advance(PONG_TIMEOUT_MS);
  assert.equal(first.closedWith, 4000, 'abandoned without waiting for its closing handshake');
  assert.equal(FakeSocket.all.length, 2, 'a new socket opens at once');
  latest().open();
  assert.equal(replays, 1, 'the outbox goes out again on the new socket');
  assert.deepEqual(states, ['connecting', 'online'], 'a drop healed within seconds never showed as Connecting');
  client.close();
});

test('a message with no acknowledgement checks the socket at once instead of waiting for the next ping', () => {
  const socket = start();
  client.send({ type: 'message:send', message: { id: 'm1', content: 'hi' } });
  advance(ACK_TIMEOUT_MS);
  assert.deepEqual(socket.sent.at(-1), { type: 'client:ping' });
  advance(PONG_TIMEOUT_MS);
  assert.equal(FakeSocket.all.length, 2, 'no answer: reconnected');
  client.close();
});

test('an acknowledged message needs no check', () => {
  const socket = start();
  client.send({ type: 'message:send', message: { id: 'm2', content: 'hi' } });
  socket.receive({ type: 'message:ack', message: { id: 'm2' } });
  advance(ACK_TIMEOUT_MS);
  assert.ok(!socket.sent.some((event) => event.type === 'client:ping'));
  client.close();
});

test('a network change checks the socket at once and a dead one is replaced', () => {
  const socket = start();
  connection.dispatchEvent(new Event('change'));      // Wi-Fi -> mobile data
  assert.deepEqual(socket.sent.at(-1), { type: 'client:ping' });
  advance(PONG_TIMEOUT_MS);
  assert.equal(FakeSocket.all.length, 2);
  client.close();
});

test('a drop that lasts is shown after a short delay, and reconnects back off after the first try', () => {
  const socket = start();
  socket.serverClose();
  assert.equal(FakeSocket.all.length, 1, 'the first retry is scheduled, not synchronous');
  advance(0);
  assert.equal(FakeSocket.all.length, 2, 'the first retry is immediate');
  latest().serverClose();
  advance(STATE_DEBOUNCE_MS);
  assert.ok(['connecting', 'offline'].includes(states.at(-1)), 'still down after the debounce: shown');
  client.close();
});

test('a signed-out session stops at once and says so', () => {
  const socket = start();
  let revoked = false;
  client.onRevoked = () => { revoked = true; };
  socket.serverClose(4001);
  assert.equal(states.at(-1), 'offline');
  assert.ok(revoked);
  advance(PING_INTERVAL_MS * 3);
  assert.equal(FakeSocket.all.length, 1, 'never reconnects');
});
