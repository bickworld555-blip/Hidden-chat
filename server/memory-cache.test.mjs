// The server's in-memory caches (server/memoryCache.mjs): fewer database queries per message, and never a stale
// answer once something changed — a sign-out, a removed device, a deleted account, a block, a hidden chat, a group
// member leaving or joining, a new disappearing timer all take effect at once, not within the minute.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import WebSocket from 'ws';
import { createMemoryRateLimiter, createTtlCache, invalidateOnWrite } from './memoryCache.mjs';

// Every query the server runs, counted where node:sqlite executes it (installed before the server is loaded).
let queries = 0;
for (const method of ['run', 'get', 'all', 'iterate']) {
  const original = StatementSync.prototype[method];
  StatementSync.prototype[method] = function counted(...args) { queries += 1; return original.apply(this, args); };
}
const { createChatServer } = await import('./index.mjs');

test('entries expire, the least recently used goes first, and a load raced by a clear is not kept', async () => {
  let time = 0;
  const cache = createTtlCache({ ttlMs: 1000, max: 2, now: () => time });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a');
  cache.set('c', 3);
  assert.deepEqual([cache.get('a'), cache.get('b'), cache.get('c')], [1, undefined, 3], 'b was least recently used');
  time = 1000;
  assert.equal(cache.get('a'), undefined, 'expired');
  let release;
  const pending = cache.remember('k', () => new Promise((resolve) => { release = resolve; }));
  cache.clear(); // a write lands while the old value is being read
  release('old');
  assert.equal(await pending, 'old', 'the caller still gets what it read');
  assert.equal(cache.get('k'), undefined, 'but it is not kept');
  assert.equal(await cache.remember('k', async () => 'new'), 'new');
  assert.equal(await cache.remember('k', async () => 'never'), 'new', 'served from memory');
});

test('a write to a watched table clears its caches; reads and bookkeeping writes do not', () => {
  const raw = new DatabaseSync(':memory:');
  raw.exec('CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, last_active_at INTEGER); CREATE TABLE other (x)');
  const cache = createTtlCache();
  const db = invalidateOnWrite(raw, { sessions: { caches: [cache], ignore: [/UPDATE\s+sessions\s+SET\s+last_active_at\s*=\s*\?\s+WHERE/i] } });
  const filled = () => { cache.set('k', 1); return cache; };
  filled(); db.prepare('SELECT * FROM sessions').all();
  assert.equal(cache.get('k'), 1, 'a read keeps it');
  filled(); db.prepare('UPDATE sessions SET last_active_at = ? WHERE token_hash = ?').run(1, 'x');
  assert.equal(cache.get('k'), 1, 'the last-active bookkeeping keeps it');
  filled(); db.prepare('INSERT INTO other(x) VALUES (1)').run();
  assert.equal(cache.get('k'), 1, 'another table keeps it');
  filled(); db.prepare('INSERT INTO sessions(token_hash) VALUES (?)').run('t');
  assert.equal(cache.get('k'), undefined, 'an insert clears it');
  filled(); db.prepare('DELETE FROM sessions WHERE token_hash = ?').run('t');
  assert.equal(cache.get('k'), undefined, 'a delete clears it');
});

test('message limits are counted in memory, per fixed window', async () => {
  let time = 0;
  const limiter = createMemoryRateLimiter({ now: () => time });
  const rules = [{ limit: 3, windowMs: 10_000 }];
  for (let i = 0; i < 3; i += 1) assert.equal(await limiter.hit('messages:ava', rules), 0);
  time = 4000;
  assert.equal(await limiter.hit('messages:ava', rules), 6000, 'the 4th waits for the window to end');
  assert.equal(await limiter.hit('messages:ben', rules), 0, 'per account');
  time = 10_000;
  assert.equal(await limiter.hit('messages:ava', rules), 0, 'a new window starts afresh');
  time = 30_000;
  limiter.sweep();
  assert.equal(limiter.size, 0, 'ended windows are dropped');
});

// --- the real server ---------------------------------------------------------------------------------------------
const PASSWORD = 'Correct-Horse-Battery-42!';
let service;
let directory;
let baseUrl;
let counter = 0;
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-cache-'));
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), dataDirectory: directory });
  baseUrl = `http://127.0.0.1:${(await service.listen()).port}`;
});
after(async () => {
  await service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});
async function api(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(baseUrl + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data };
}
async function register(prefix) {
  counter += 1;
  return (await api('/api/v1/auth/register', { method: 'POST', body: { username: `${prefix}${counter}`, dob: '1990-04-12', password: PASSWORD } })).data;
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
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

test('a signed-out device, a removed device and a deleted account are refused at once, cached or not', async () => {
  const ava = await register('cava');
  const second = (await api('/api/v1/auth/login', { method: 'POST', body: { identity: ava.user.username, password: PASSWORD } })).data;
  assert.ok(second?.token, 'a second device signs in');
  // Both sessions are now in the cache.
  assert.equal((await api('/api/v1/contacts', { token: ava.token })).status, 200);
  assert.equal((await api('/api/v1/contacts', { token: second.token })).status, 200);
  assert.equal((await api(`/api/v1/me/sessions/${encodeURIComponent(second.deviceId)}`, { token: ava.token, method: 'DELETE' })).status < 300, true);
  assert.equal((await api('/api/v1/contacts', { token: second.token })).status, 401, 'the removed device is out immediately');
  assert.equal((await api('/api/v1/auth/logout', { token: ava.token, method: 'POST' })).status < 300, true);
  assert.equal((await api('/api/v1/contacts', { token: ava.token })).status, 401, 'signed out immediately');

  const ben = await register('cben');
  assert.equal((await api('/api/v1/contacts', { token: ben.token })).status, 200);
  assert.equal((await api('/api/v1/me', { token: ben.token, method: 'DELETE', body: { password: PASSWORD, confirm: ben.user.username } })).status, 204);
  assert.equal((await api('/api/v1/contacts', { token: ben.token })).status, 401, 'a deleted account is out immediately');
});

test('a new block, a hidden chat and a new disappearing timer apply to the very next message', async () => {
  const ava = await register('bava');
  const ben = await register('bben');
  const [avaSocket, benSocket] = await Promise.all([connect(ava), connect(ben)]);
  const send = (socket, id, receiverId) => socket.send(JSON.stringify({ type: 'message:send', message: { id, receiverId, content: `text ${id}` } }));
  send(benSocket, 'c-1', ava.user.id);
  assert.ok(await avaSocket.waitFor((event) => event.type === 'message:new' && event.message.id === 'c-1'), 'delivered (and every cache warm)');

  // Ava hides the chat; Ben's next message brings it back.
  assert.equal((await api(`/api/v1/chats/${ben.user.id}/delete`, { token: ava.token, method: 'POST' })).status < 300, true);
  send(benSocket, 'c-2', ava.user.id);
  await avaSocket.waitFor((event) => event.message?.id === 'c-2');
  const listed = (await api('/api/v1/contacts', { token: ava.token })).data.find((contact) => contact.id === ben.user.id);
  assert.equal(listed?.hidden, false, 'the hidden chat is linked again');

  // A disappearing timer set now applies to the next message.
  avaSocket.send(JSON.stringify({ type: 'chat:disappearing', peerId: ben.user.id, seconds: 86400 }));
  assert.ok(await avaSocket.waitFor((event) => event.type === 'chat:disappearing' && event.seconds === 86400), 'timer set');
  send(benSocket, 'c-3', ava.user.id);
  const timed = await avaSocket.waitFor((event) => event.message?.id === 'c-3');
  assert.ok(timed?.message?.expiresAt, 'the new timer is on the next message');

  // Ava blocks Ben: his next message and typing stop at once.
  assert.equal((await api(`/api/v1/blocks/${ben.user.id}`, { token: ava.token, method: 'PUT' })).status, 204);
  avaSocket.events.length = 0;
  send(benSocket, 'c-4', ava.user.id);
  benSocket.send(JSON.stringify({ type: 'presence:typing', peerId: ava.user.id, active: true }));
  await settle(400);
  assert.equal(avaSocket.events.some((event) => event.message?.id === 'c-4' || event.type === 'presence:typing'), false, 'nothing reaches Ava');
  avaSocket.close();
  benSocket.close();
});

test('a group member removed stops being heard at once; one added is heard at once', async () => {
  const ava = await register('gava');
  const ben = await register('gben');
  const cal = await register('gcal');
  const group = (await api('/api/v1/groups', { token: ava.token, method: 'POST', body: { name: 'Cache', memberIds: [ben.user.id] } })).data;
  const [avaSocket, benSocket, calSocket] = await Promise.all([connect(ava), connect(ben), connect(cal)]);
  const typing = (socket) => socket.send(JSON.stringify({ type: 'presence:typing', groupId: group.id, active: true }));
  typing(benSocket);
  assert.ok(await avaSocket.waitFor((event) => event.type === 'presence:typing' && event.userId === ben.user.id), 'Ben heard (members cached)');
  assert.equal((await api(`/api/v1/groups/${group.id}/members/${ben.user.id}`, { token: ava.token, method: 'DELETE' })).status < 300, true);
  avaSocket.events.length = 0;
  typing(benSocket);
  await settle(400);
  assert.equal(avaSocket.events.some((event) => event.type === 'presence:typing'), false, 'removed: no longer heard');
  assert.equal((await api(`/api/v1/groups/${group.id}/members`, { token: ava.token, method: 'POST', body: { userId: cal.user.id } })).status < 300, true);
  typing(calSocket);
  assert.ok(await avaSocket.waitFor((event) => event.type === 'presence:typing' && event.userId === cal.user.id), 'added: heard at once');
  for (const socket of [avaSocket, benSocket, calSocket]) socket.close();
});

test('a one-to-one message costs at most 20 database queries once warm, and typing none', async () => {
  const ava = await register('qava');
  const ben = await register('qben');
  const [avaSocket, benSocket] = await Promise.all([connect(ava), connect(ben)]);
  const flow = async (id) => {
    avaSocket.send(JSON.stringify({ type: 'message:send', message: { id, receiverId: ben.user.id, content: `hello ${id}` } }));
    await benSocket.waitFor((event) => event.type === 'message:new' && event.message.id === id);
    await avaSocket.waitFor((event) => event.type === 'message:ack' && event.message.id === id);
    benSocket.send(JSON.stringify({ type: 'message:delivered', messageIds: [id] }));
    benSocket.send(JSON.stringify({ type: 'queue:ack', messageIds: [id], eventIds: [] }));
    benSocket.send(JSON.stringify({ type: 'message:read', messageId: id }));
    await settle(300);
  };
  await flow('q-1'); // warms the caches
  await settle();
  queries = 0;
  await flow('q-2');
  const perMessage = queries;
  queries = 0;
  avaSocket.send(JSON.stringify({ type: 'presence:typing', peerId: ben.user.id, active: true }));
  await benSocket.waitFor((event) => event.type === 'presence:typing');
  const perTyping = queries;
  console.log(`  queries per message (send → delivered → saved → read): ${perMessage}; per typing event: ${perTyping}`);
  assert.ok(perMessage <= 20, `${perMessage} queries`);
  assert.equal(perTyping, 0);
  avaSocket.close();
  benSocket.close();
});
