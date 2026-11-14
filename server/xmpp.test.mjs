// Phase 2 of the BEAM/XMPP move: per-device ejabberd accounts and short-lived sign-in tokens (server/xmpp.mjs).
// ejabberd's admin API is faked here with the answers the real one gave on the VPS (2026-11-15): register 200, an
// existing account 409 / code 10090, unregister 200 even when absent.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createChatServer } from './index.mjs';
import { createXmpp, localpartFor, signOfflineHook, signXmppToken, xmppConfigFromEnv, XMPP_TOKEN_TTL_SECONDS } from './xmpp.mjs';

const PASSWORD = 'correct horse battery staple';
const SECRET = Buffer.alloc(48, 7).toString('base64url');
const config = xmppConfigFromEnv({ XMPP_JWT_SECRET: SECRET, XMPP_ADMIN_PASSWORD: 'admin-secret' });

// A fake ejabberd admin API: accounts in a Set, every call recorded, failures switchable.
const ejabberd = { accounts: new Set(), calls: [], down: false };
async function fakeEjabberd(url, init) {
  const command = String(url).split('/').pop();
  const body = JSON.parse(init.body);
  ejabberd.calls.push({ command, user: body.user, host: body.host, auth: init.headers.Authorization });
  if (ejabberd.down) throw new TypeError('fetch failed');
  const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  if (command === 'register') {
    if (ejabberd.accounts.has(body.user)) return json(409, { code: 10090, message: 'already registered', status: 'error' });
    ejabberd.accounts.add(body.user);
    return json(200, 'registered');
  }
  if (command === 'unregister') { ejabberd.accounts.delete(body.user); return json(200, ''); }
  if (command === 'kick_user') return json(200, 0);
  if (command === 'registered_users') return json(200, ['admin', ...ejabberd.accounts]);
  return json(404, { status: 'error' });
}

// A fake FCM sender: every push recorded with its target token.
const pushes = [];
const fakePush = { send: async (token, data, options) => { pushes.push({ token, data, options }); return { ok: true }; } };

let directory;
let service;
let baseUrl;
let disabledService;
let disabledUrl;
let counter = 0;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-xmpp-'));
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), pushSender: fakePush, xmppConfig: config, xmppFetch: fakeEjabberd });
  baseUrl = `http://127.0.0.1:${(await service.listen()).port}`;
  disabledService = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'off.sqlite'), pushSender: null, xmppConfig: xmppConfigFromEnv({}), xmppFetch: fakeEjabberd });
  disabledUrl = `http://127.0.0.1:${(await disabledService.listen()).port}`;
});
after(async () => {
  await service?.close();
  await disabledService?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function api(path, { token, method = 'GET', body, base = baseUrl } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
}
async function account(base = baseUrl) {
  counter += 1;
  const username = `xmpp${counter}${Date.now().toString(36).slice(-4)}`;
  const registered = (await api('/api/v1/auth/register', { method: 'POST', base, body: { username, dob: '1990-04-12', password: PASSWORD } })).body;
  const second = (await api('/api/v1/auth/login', { method: 'POST', base, body: { identity: username, password: PASSWORD } })).body;
  return { username, user: registered.user, token: registered.token, otherToken: second.token };
}
const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString());

test('a device address is "d" + 40 hex, the same every time, different per device and per account', () => {
  const a = localpartFor('user-1', 'Device-A');
  assert.match(a, /^d[0-9a-f]{40}$/);
  assert.equal(localpartFor('user-1', 'Device-A'), a);
  assert.notEqual(localpartFor('user-1', 'device-a'), a, 'ids that differ only in case still get different addresses');
  assert.notEqual(localpartFor('user-2', 'Device-A'), a);
  assert.ok(!a.includes('user-1'), 'ejabberd never sees the raw ids');
});

test('the sign-in token is an HS256 JWT ejabberd can verify with the shared key, valid for 10 minutes', () => {
  const { token, expiresAt } = signXmppToken({ secret: SECRET, jid: 'dabc@chat.hiddenmessenger.com', nowMs: 1_800_000_000_000 });
  const [header, payload, signature] = token.split('.');
  assert.deepEqual(decode(header), { alg: 'HS256', typ: 'JWT' });
  assert.deepEqual(decode(payload), { jid: 'dabc@chat.hiddenmessenger.com', iat: 1_800_000_000, exp: 1_800_000_000 + XMPP_TOKEN_TTL_SECONDS });
  assert.equal(signature, createHmac('sha256', Buffer.from(SECRET, 'base64url')).update(`${header}.${payload}`).digest('base64url'));
  assert.equal(expiresAt, (1_800_000_000 + XMPP_TOKEN_TTL_SECONDS) * 1000);
});

test('a device gets its own account before its first token, and later tokens reuse it', async () => {
  const alice = await account();
  ejabberd.calls.length = 0;
  const first = await api('/api/v1/xmpp/token', { method: 'POST', token: alice.token });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.match(first.body.jid, /^d[0-9a-f]{40}@chat\.hiddenmessenger\.com$/);
  assert.equal(first.body.websocket, 'wss://chat.hiddenmessenger.com/xmpp-websocket');
  assert.equal(decode(first.body.token.split('.')[1]).jid, first.body.jid);
  assert.ok(first.body.expiresAt > Date.now());
  const localpart = first.body.jid.split('@')[0];
  assert.ok(ejabberd.accounts.has(localpart), 'the account exists on ejabberd, so messages can wait for this device');
  assert.deepEqual(ejabberd.calls.map((call) => [call.command, call.host]), [['register', 'chat.hiddenmessenger.com']]);
  assert.equal(ejabberd.calls[0].auth, `Basic ${Buffer.from('admin@chat.hiddenmessenger.com:admin-secret').toString('base64')}`);

  const again = await api('/api/v1/xmpp/token', { method: 'POST', token: alice.token });
  assert.equal(again.body.jid, first.body.jid);
  assert.equal(ejabberd.calls.length, 1, 'no second registration');

  const otherDevice = await api('/api/v1/xmpp/token', { method: 'POST', token: alice.otherToken });
  assert.notEqual(otherDevice.body.jid, first.body.jid, 'each signed-in device has its own address');
});

test('an account that already exists on ejabberd (a retry, or two first requests at once) counts as created', async () => {
  // A store with no record of the device, while ejabberd already has its account: register answers 409 / 10090.
  const rows = new Map();
  const db = { prepare: (sql) => ({
    get: async (userId, deviceId) => (sql.startsWith('SELECT localpart FROM xmpp_accounts WHERE') ? rows.get(`${userId}/${deviceId}`) : undefined),
    run: async (...args) => { if (sql.startsWith('INSERT')) rows.set(`${args[0]}/${args[1]}`, { localpart: args[2] }); },
    all: async () => [],
  }) };
  const xmpp = createXmpp({ db, config, fetchImpl: fakeEjabberd });
  const expected = localpartFor('u-retry', 'dev-1');
  ejabberd.accounts.add(expected);
  ejabberd.calls.length = 0;
  assert.equal(await xmpp.ensureAccount('u-retry', 'dev-1'), expected);
  assert.deepEqual(ejabberd.calls.map((call) => call.command), ['register'], 'one attempt, the conflict accepted');
  assert.deepEqual(rows.get('u-retry/dev-1'), { localpart: expected }, 'and remembered, so the next token needs no call');
  await xmpp.ensureAccount('u-retry', 'dev-1');
  assert.equal(ejabberd.calls.length, 1);
});

test('signing a device out kicks and removes its account; other devices keep theirs', async () => {
  const carol = await account();
  const phone = (await api('/api/v1/xmpp/token', { method: 'POST', token: carol.token })).body.jid.split('@')[0];
  const laptop = (await api('/api/v1/xmpp/token', { method: 'POST', token: carol.otherToken })).body.jid.split('@')[0];
  ejabberd.calls.length = 0;
  assert.equal((await api('/api/v1/auth/logout', { method: 'POST', token: carol.otherToken })).status, 204);
  const deadline = Date.now() + 3000;
  while (ejabberd.accounts.has(laptop) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(!ejabberd.accounts.has(laptop), 'the signed-out device lost its account');
  assert.ok(ejabberd.accounts.has(phone), 'the other device still has its account');
  const commands = ejabberd.calls.filter((call) => call.user === laptop).map((call) => call.command);
  assert.deepEqual(commands, ['kick_user', 'unregister'], 'its live connection is closed before the account goes');
  // Signing in again later makes a fresh account.
  const back = (await api('/api/v1/auth/login', { method: 'POST', body: { identity: carol.username, password: PASSWORD } })).body;
  const fresh = (await api('/api/v1/xmpp/token', { method: 'POST', token: back.token })).body.jid.split('@')[0];
  assert.ok(ejabberd.accounts.has(fresh));
});

test('when ejabberd is unreachable the device gets a clear 502 and no token', async () => {
  const dave = await account();
  ejabberd.down = true;
  try {
    const response = await api('/api/v1/xmpp/token', { method: 'POST', token: dave.token });
    assert.equal(response.status, 502);
    assert.equal(response.body.token, undefined);
    assert.match(response.body.error, /not reachable/);
  } finally {
    ejabberd.down = false;
  }
  assert.equal((await api('/api/v1/xmpp/token', { method: 'POST', token: dave.token })).status, 200, 'works once it is back');
});

test('without the XMPP secrets the endpoint says so, and it always needs a signed-in device', async () => {
  const erin = await account(disabledUrl);
  const off = await api('/api/v1/xmpp/token', { method: 'POST', token: erin.token, base: disabledUrl });
  assert.equal(off.status, 503);
  assert.equal(off.body.enabled, false);
  assert.equal((await api('/api/v1/xmpp/token', { method: 'POST' })).status, 401);
});

test('a server still starting (migrations running) answers API calls and sockets with 503 + Retry-After; probes stay up', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { createServer } = await import('node:net');
  const port = await new Promise((resolve) => { const probe = createServer().listen(0, '127.0.0.1', () => { const { port: free } = probe.address(); probe.close(() => resolve(free)); }); });
  const dir = mkdtempSync(join(tmpdir(), 'relay-start-'));
  const raw = new DatabaseSync(join(dir, 'db.sqlite'));
  let release;
  raw.migrate = () => new Promise((resolve) => { release = () => resolve(false); });
  const starting = createChatServer({ port, host: '127.0.0.1', database: raw, migrate: true, pushSender: null, xmppConfig: config, xmppFetch: fakeEjabberd });
  const listening = starting.listen();
  const url = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 100 && !release; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(release, 'startup reached the migration step');
    const busy = await fetch(`${url}/api/v1/xmpp/token`, { method: 'POST' });
    assert.equal(busy.status, 503);
    assert.equal(busy.headers.get('retry-after'), '2');
    assert.equal((await busy.json()).starting, true);
    assert.equal((await fetch(`${url}/api/v1/health`)).status, 200, 'the health probe still answers');
    const { WebSocket } = await import('ws');
    const upgradeStatus = await new Promise((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      socket.on('unexpected-response', (_request, response) => resolve(response.statusCode));
      socket.on('error', () => resolve('error'));
      socket.on('open', () => { socket.close(); resolve('opened'); });
    });
    assert.equal(upgradeStatus, 503, 'socket upgrades wait for startup too');
  } finally {
    release?.();
  }
  await listening;
  assert.notEqual((await fetch(`${url}/api/v1/auth/availability?username=someone`)).status, 503, 'once started, requests go through');
  await starting.close();
  rmSync(dir, { recursive: true, force: true });
});

// --- Reachability and the offline wake-up hook ------------------------------------------------------------------

const PUSH_KEY = Buffer.alloc(32, 9).toString('base64');
async function withKeysAndPush(token, pushToken) {
  // A device with end-to-end keys (so it is in device lists) and a push registration (so it can be woken).
  const { createProtocol } = await import('../src/e2e/protocol.js');
  const memory = new Map();
  const protocol = createProtocol({ storage: { get: async (k) => memory.get(k), set: async (k, v) => { memory.set(k, v); }, del: async (k) => { memory.delete(k); } } });
  assert.equal((await api('/api/v1/e2e/keys', { method: 'PUT', token, body: await protocol.prepareUpload({ serverPreKeyCount: 0 }) })).status < 300, true);
  assert.equal((await api('/api/v1/push/devices', { method: 'POST', token, body: { token: pushToken, key: PUSH_KEY, platform: 'android' } })).status, 200);
}
const hook = (body, { secret = SECRET, signature } = {}) => {
  const raw = JSON.stringify(body);
  return fetch(`${baseUrl}/api/v1/xmpp/offline`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hm-signature': signature ?? signOfflineHook(secret, raw) }, body: raw });
};

test('device lists show which devices are reachable over XMPP, so senders can route during the move', async () => {
  const frank = await account();
  const viewer = await account();
  await withKeysAndPush(frank.token, `fcm-frank-phone-${'x'.repeat(30)}`);
  await withKeysAndPush(frank.otherToken, `fcm-frank-laptop-${'x'.repeat(30)}`);
  const before = (await api(`/api/v1/e2e/users/${frank.user.id}/devices`, { token: viewer.token })).body.devices;
  assert.equal(before.length, 2);
  assert.ok(before.every((device) => device.xmpp === undefined), 'nobody has signed in to XMPP yet');
  const jid = (await api('/api/v1/xmpp/token', { method: 'POST', token: frank.token })).body.jid;
  const after = (await api(`/api/v1/e2e/users/${frank.user.id}/devices`, { token: viewer.token })).body.devices;
  assert.deepEqual(after.map((device) => device.xmpp).filter(Boolean), [jid], 'only the device that signed in to XMPP has an address');
});

test('the offline hook wakes exactly the device whose message waits, once per burst; forged or stale calls are refused', async () => {
  const gina = await account();
  await withKeysAndPush(gina.token, `fcm-gina-phone-${'y'.repeat(30)}`);
  await withKeysAndPush(gina.otherToken, `fcm-gina-tablet-${'y'.repeat(30)}`);
  const localpart = (await api('/api/v1/xmpp/token', { method: 'POST', token: gina.token })).body.jid.split('@')[0];
  const ts = Math.floor(Date.now() / 1000);
  pushes.length = 0;

  assert.equal((await hook({ to: localpart, ts }, { signature: 'f'.repeat(64) })).status, 401, 'a forged signature');
  assert.equal((await hook({ to: localpart, ts }, { secret: Buffer.alloc(48, 1).toString('base64url') })).status, 401, 'another key');
  assert.equal((await hook({ to: localpart, ts: ts - 3600 })).status, 400, 'an old request (replay)');
  assert.equal((await hook({ to: 'admin', ts })).status, 400, 'not a device address');
  assert.equal(pushes.length, 0);

  const woken = await hook({ to: localpart, ts });
  assert.equal(woken.status, 202);
  assert.equal((await woken.json()).pushed, 1);
  assert.deepEqual(pushes.map((push) => push.token), [`fcm-gina-phone-${'y'.repeat(30)}`], 'only that device, not the tablet');
  assert.ok(pushes[0].data.enc && pushes[0].data.iv, 'the wake-up is encrypted for the device like every push');
  assert.deepEqual(pushes[0].options, { collapseKey: 'xmpp-wake', ttlSeconds: 86_400 });

  const again = await (await hook({ to: localpart, ts })).json();
  assert.deepEqual(again, { pushed: 0, coalesced: true }, 'a second message seconds later does not push again');
  assert.equal((await (await hook({ to: `d${'0'.repeat(40)}`, ts })).json()).pushed, 0, 'an unknown device is ignored');
});

test('deleting a user removes every one of its device accounts on ejabberd', async () => {
  const hana = await account();
  const phone = (await api('/api/v1/xmpp/token', { method: 'POST', token: hana.token })).body.jid.split('@')[0];
  const laptop = (await api('/api/v1/xmpp/token', { method: 'POST', token: hana.otherToken })).body.jid.split('@')[0];
  assert.equal((await api('/api/v1/account/delete', { method: 'POST', body: { username: hana.username, password: PASSWORD, confirm: 'DELETE' } })).status < 300, true);
  const deadline = Date.now() + 3000;
  while ((ejabberd.accounts.has(phone) || ejabberd.accounts.has(laptop)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(!ejabberd.accounts.has(phone) && !ejabberd.accounts.has(laptop), 'no account is left behind on ejabberd');
});

test('the mirror sweep removes accounts ejabberd has but the table does not, and restores missing ones', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT, device_id TEXT)');
  const { ensureXmppSchema } = await import('./xmpp.mjs');
  ensureXmppSchema(db);
  const fake = { accounts: new Set(), calls: [] };
  const fetchImpl = async (url, init) => {
    const command = String(url).split('/').pop(); const body = JSON.parse(init.body); fake.calls.push(`${command}:${body.user ?? ''}`);
    const json = (status, value) => new Response(JSON.stringify(value), { status });
    if (command === 'registered_users') return json(200, ['admin', ...fake.accounts]);
    if (command === 'register') { fake.accounts.add(body.user); return json(200, 'ok'); }
    if (command === 'unregister') { fake.accounts.delete(body.user); return json(200, ''); }
    return json(200, 0);
  };
  const xmpp = createXmpp({ db, config, fetchImpl, log: { warn() {} } });
  db.prepare("INSERT INTO sessions VALUES ('t1', 'u1', 'live')").run();
  const live = await xmpp.ensureAccount('u1', 'live');
  const orphan = `d${'a'.repeat(40)}`;
  fake.accounts.add(orphan);                       // on ejabberd, no row (a crash, a restore)
  fake.accounts.delete(live);                      // a signed-in device whose account went missing
  await xmpp.reconcile({ mirror: true });
  assert.ok(!fake.accounts.has(orphan), 'the orphan is removed');
  assert.ok(fake.accounts.has(live), 'the live device gets its account back');
  assert.ok(!fake.calls.some((call) => call.endsWith(':admin')), 'the admin account is never touched');
  assert.deepEqual(fake.calls.filter((call) => call.startsWith('unregister:')), [`unregister:${orphan}`], 'only the orphan is removed');
  // A failed creation leaves no row behind, so the sweep cannot mistake anything.
  const failing = createXmpp({ db, config, fetchImpl: async () => new Response('{}', { status: 500 }), log: { warn() {} } });
  await assert.rejects(() => failing.ensureAccount('u2', 'dev'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM xmpp_accounts WHERE user_id = ?').get('u2').n, 0);
});
