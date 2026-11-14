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
import { createXmpp, localpartFor, signXmppToken, xmppConfigFromEnv, XMPP_TOKEN_TTL_SECONDS } from './xmpp.mjs';

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
  return json(404, { status: 'error' });
}

let directory;
let service;
let baseUrl;
let disabledService;
let disabledUrl;
let counter = 0;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-xmpp-'));
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), pushSender: null, xmppConfig: config, xmppFetch: fakeEjabberd });
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
