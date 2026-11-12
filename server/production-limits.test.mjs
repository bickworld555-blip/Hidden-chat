// Production hardening: abuse limits (messages per account, new accounts per network address), operations alerts,
// and replies/forwards kept inside the encryption so the server does not learn them.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createChatServer } from './index.mjs';
import { DatabaseSync } from 'node:sqlite';
import { abuseLimitsFromEnv, clientAddress, createSharedRateLimiter, ensureRateLimitSchema } from './abuse.mjs';
import { alertWebhookFromEnv, createAlerts, serverErrorWatch } from './monitoring.mjs';
import { innerOf, openedFrom } from '../src/e2e/client.js';
import { resolveQuote } from '../src/replies.js';
import { buildEnvelope } from '../src/e2e/envelope.js';
import { createProtocol } from '../src/e2e/protocol.js';

const PASSWORD = 'Correct-Horse-Battery-42!';
const sent = [];
let service;
let directory;
let baseUrl;
let counter = 0;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-limits-'));
  service = createChatServer({
    port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), dataDirectory: directory,
    abuseLimits: { trustProxyHops: 1, messages: [{ limit: 3, windowMs: 60_000 }], signups: [{ limit: 2, windowMs: 3_600_000 }] },
    alerts: createAlerts({ url: 'https://alerts.example/hook', fetchImpl: async (url, init) => { sent.push(JSON.parse(init.body).text); return new Response('ok'); } }),
  });
  baseUrl = `http://127.0.0.1:${(await service.listen()).port}`;
});
after(async () => {
  await service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

const register = (address) => {
  counter += 1;
  return fetch(`${baseUrl}/api/v1/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': address },
    body: JSON.stringify({ username: `lim${counter}`, dob: '1990-04-12', password: PASSWORD }),
  });
};

test('limits are on in production and configurable; off in development and tests', () => {
  assert.equal(abuseLimitsFromEnv({}), null);
  assert.equal(abuseLimitsFromEnv({ NODE_ENV: 'production', RELAY_ABUSE_LIMITS: '0' }), null);
  const prod = abuseLimitsFromEnv({ NODE_ENV: 'production', RELAY_TRUST_PROXY_HOPS: '2', RELAY_SIGNUPS_PER_HOUR: '5' });
  assert.equal(prod.trustProxyHops, 2);
  assert.equal(prod.signups[0].limit, 5);
  assert.equal(prod.messages[0].limit, 30);
});

test("the client's address is counted from the right of X-Forwarded-For, past the trusted proxies only", () => {
  const request = (xff, socket = '10.0.0.9') => ({ headers: { 'x-forwarded-for': xff }, socket: { remoteAddress: socket } });
  assert.equal(clientAddress(request('1.1.1.1'), 1), '1.1.1.1');
  assert.equal(clientAddress(request('6.6.6.6, 1.1.1.1'), 1), '1.1.1.1', 'a forged entry on the left is ignored');
  assert.equal(clientAddress(request('6.6.6.6, 1.1.1.1, 172.16.0.2'), 2), '1.1.1.1', 'behind a CDN and a proxy');
  assert.equal(clientAddress(request(''), 1), null);
  assert.equal(clientAddress(request(''), 0), '10.0.0.9');
});

test('the counters are shared through the database, by window, under a hashed key', async () => {
  const db = new DatabaseSync(':memory:');
  ensureRateLimitSchema(db);
  let at = 0;
  const limiter = createSharedRateLimiter({ db, secret: 'test-secret', now: () => at });
  const other = createSharedRateLimiter({ db, secret: 'test-secret', now: () => at }); // another server process
  const rules = [{ limit: 2, windowMs: 1000 }];
  assert.equal(await limiter.hit('signups:203.0.113.9', rules), 0);
  assert.equal(await other.hit('signups:203.0.113.9', rules), 0);
  assert.equal(await limiter.hit('signups:203.0.113.9', rules), 1000, 'the third, counted across both');
  assert.equal(await limiter.hit('signups:198.51.100.1', rules), 0, 'another key has its own count');
  const keys = db.prepare('SELECT key FROM rate_limit_hits').all().map((row) => row.key).join(' ');
  assert.equal(keys.includes('203.0.113.9'), false, 'no address is stored');
  at = 1000;
  assert.equal(await limiter.hit('signups:203.0.113.9', rules), 0, 'a new window');
  at = 3 * 24 * 60 * 60 * 1000;
  await limiter.sweep();
  assert.equal(db.prepare('SELECT count(*) AS count FROM rate_limit_hits').get().count, 0, 'ended windows are deleted');
});

test('one network address can create only so many accounts; another address is not affected', async () => {
  assert.equal((await register('203.0.113.7')).status, 201);
  assert.equal((await register('203.0.113.7')).status, 201);
  const third = await register('203.0.113.7');
  assert.equal(third.status, 429);
  assert.equal((await third.json()).code, 'rate_limited');
  assert.ok(Number(third.headers.get('retry-after')) > 0);
  assert.equal((await register('198.51.100.4')).status, 201);
});

test('an account sending too fast is told to wait, in groups and in one-to-one chats', async () => {
  const ava = await (await register('192.0.2.1')).json();
  const ben = await (await register('192.0.2.2')).json();
  const group = await (await fetch(`${baseUrl}/api/v1/groups`, { method: 'POST', headers: { Authorization: `Bearer ${ava.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Limits', memberIds: [ben.user.id] }) })).json();
  const post = () => fetch(`${baseUrl}/api/v1/groups/${group.id}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${ben.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'hi' }) });
  for (let i = 0; i < 3; i += 1) assert.ok((await post()).status < 300);
  assert.equal((await post()).status, 429);

  const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/ws', [`relay.auth.${ava.token}`, 'relay.v1']);
  const events = [];
  socket.on('message', (raw) => events.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  for (let i = 0; i < 4; i += 1) socket.send(JSON.stringify({ type: 'message:send', message: { id: `rl-${i}`, receiverId: ben.user.id, content: `m${i}` } }));
  for (let i = 0; i < 60 && !events.some((event) => event.code === 'rate_limited'); i += 1) await new Promise((r) => setTimeout(r, 25));
  const limited = events.find((event) => event.code === 'rate_limited');
  assert.equal(limited?.messageId, 'rl-3');
  assert.equal(events.filter((event) => event.type === 'message:ack').length, 3);
  socket.close();
});

test('alerts go to the webhook at most once per kind per quarter hour; a burst of server errors sends one', async () => {
  assert.equal(alertWebhookFromEnv({ ALERT_WEBHOOK_URL: 'http://plain.example' }), null, 'https only');
  const posted = [];
  let at = 0;
  const alerts = createAlerts({ url: 'https://hooks.example/x', now: () => at, fetchImpl: async (_url, init) => { posted.push(JSON.parse(init.body)); return new Response('ok'); } });
  assert.equal(await alerts.send('crash', 'one'), true);
  assert.equal(await alerts.send('crash', 'two'), false, 'quiet period');
  at = 16 * 60 * 1000;
  assert.equal(await alerts.send('crash', 'three'), true);
  assert.deepEqual(Object.keys(posted[0]).sort(), ['content', 'text'], 'Slack and Discord field names');

  const watch = serverErrorWatch(alerts, { now: () => at, burst: { count: 3, windowMs: 60_000 } });
  const fake = () => { const handlers = {}; return { statusCode: 500, on: (name, fn) => { handlers[name] = fn; }, fire: () => handlers.finish() }; };
  for (let i = 0; i < 3; i += 1) { const response = fake(); watch({ method: 'GET', route: { path: '/api/v1/x' } }, response, () => {}); response.fire(); }
  await new Promise((r) => setTimeout(r, 10));
  assert.match(posted.at(-1).text, /3 server errors/);
});

test('the readiness check answers 503 and alerts when the database is down', async () => {
  const original = service.db.ready;
  service.db.ready = async () => { throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' }); };
  try {
    const response = await fetch(`${baseUrl}/api/v1/ready`);
    assert.equal(response.status, 503);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(sent.some((text) => /database is not answering \(ECONNREFUSED\)/.test(text)));
  } finally {
    service.db.ready = original;
  }
});

test('replies and forwards travel inside the encryption; the server stores neither for a sealed message', async () => {
  const inner = innerOf('see you there', { replyToId: 'msg-1', forwarded: true });
  assert.deepEqual(openedFrom(inner, null), { content: 'see you there', e2e: true, replyTo: { id: 'msg-1' }, forwarded: true });

  const ava = await (await register('192.0.2.10')).json();
  const ben = await (await register('192.0.2.11')).json();
  const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/ws', [`relay.auth.${ava.token}`, 'relay.v1']);
  const events = [];
  socket.on('message', (raw) => events.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.send(JSON.stringify({ type: 'message:send', message: { id: 'plain-1', receiverId: ben.user.id, content: 'first' } }));
  await new Promise((r) => setTimeout(r, 150));
  // A really sealed message that, as an old app would, also names its quote and forward outside: neither is kept.
  const memory = new Map();
  const protocol = createProtocol({ storage: { get: async (k) => memory.get(k), set: async (k, v) => { memory.set(k, v); }, del: async (k) => { memory.delete(k); } } });
  await fetch(`${baseUrl}/api/v1/e2e/keys`, { method: 'PUT', headers: { Authorization: `Bearer ${ben.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(await (createProtocol({ storage: { get: async () => undefined, set: async () => {}, del: async () => {} } })).prepareUpload({ serverPreKeyCount: 0 })) });
  const api = async (path, init = {}) => (await fetch(baseUrl + path, { ...init, headers: { Authorization: `Bearer ${ava.token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } })).json();
  const devices = (await api(`/api/v1/e2e/users/${ben.user.id}/devices`)).devices;
  const d = await protocol.encryptForDevices({ [ben.user.id]: devices }, JSON.stringify(innerOf('quoted reply', { replyToId: 'plain-1', forwarded: true })), {
    claimBundles: async (userId, deviceIds) => (await api(`/api/v1/e2e/users/${userId}/bundles`, { method: 'POST', body: JSON.stringify({ deviceIds }) })).bundles,
  });
  const sealed = buildEnvelope('text', { sd: ava.deviceId, d });
  const stored = (id) => service.db.prepare('SELECT reply_to_id AS replyToId, forwarded FROM messages WHERE id = ?').get(id);
  socket.send(JSON.stringify({ type: 'message:send', message: { id: 'sealed-1', receiverId: ben.user.id, content: sealed, replyTo: { id: 'plain-1' }, forwarded: true } }));
  for (let i = 0; i < 40 && !stored('sealed-1'); i += 1) await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual({ ...stored('sealed-1') }, { replyToId: null, forwarded: 0 }, 'stored, without the quote link or forward mark');
  socket.send(JSON.stringify({ type: 'message:send', message: { id: 'plain-2', receiverId: ben.user.id, content: 'second', replyTo: { id: 'plain-1' } } }));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(stored('plain-2').replyToId, 'plain-1', 'an unsealed record keeps its quote as before');
  socket.close();
});

test("a quote is shown from this device's own copy of the quoted message", () => {
  const messages = [{ id: 'q1', senderId: 'ben', content: 'Dinner at eight?' }, { id: 'q2', senderId: 'me', content: 'gone', deleted: true }];
  assert.deepEqual(resolveQuote({ id: 'q1' }, messages), { id: 'q1', senderId: 'ben', content: 'Dinner at eight?' });
  assert.equal(resolveQuote({ id: 'q2' }, messages).deleted, true);
  assert.equal(resolveQuote({ id: 'zz', senderId: 'ben', content: 'e2e2:text|{}' }, messages).content, 'Original message not on this device');
  assert.equal(resolveQuote(null, messages), null);
});
