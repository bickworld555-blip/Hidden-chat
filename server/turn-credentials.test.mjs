// Per-user, expiring TURN credentials (coturn use-auth-secret): one shared TURN username let a few calls fill the
// whole app's allocation quota (coturn answered 486 "Allocation Quota Reached"), so after a Wi-Fi <-> mobile data switch
// the ICE restart found no relay and the video froze (seen live on the S23, 2026-11-15).
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createChatServer } from './index.mjs';
import { xmppConfigFromEnv } from './xmpp.mjs';
import { normalizeIceServers, TURN_CREDENTIAL_TTL_SECONDS } from '../src/rtc.js';

const SECRET = 'n1I1-TNwCOlQ4OmNrrGKuN44fOYhOMHHESXT4emqyRQBrSx1SGNXSKNN58JpVk00';
let service;
let directory;
let baseUrl;
const saved = {};

before(async () => {
  for (const name of ['RELAY_TURN_URL', 'RELAY_TURN_USERNAME', 'RELAY_TURN_CREDENTIAL']) saved[name] = process.env[name];
  process.env.RELAY_TURN_URL = 'turn:relay.example:3478?transport=udp,turns:relay.example:5349?transport=tcp';
  process.env.RELAY_TURN_USERNAME = 'shared';
  process.env.RELAY_TURN_CREDENTIAL = 'shared-secret';
  directory = mkdtempSync(join(tmpdir(), 'relay-turn-'));
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), pushSender: null,
    xmppConfig: xmppConfigFromEnv({ XMPP_JWT_SECRET: SECRET, XMPP_ADMIN_PASSWORD: 'x' }), xmppFetch: async () => new Response('[]') });
  baseUrl = `http://127.0.0.1:${(await service.listen()).port}`;
});
after(async () => {
  await service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
  for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
});

test('each user gets their own TURN credentials, first, valid for a day; the shared ones stay behind them', async () => {
  const register = await fetch(`${baseUrl}/api/v1/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'turnperson', dob: '1990-04-12', password: 'Correct-Horse-Battery-42!' }) });
  const user = await register.json();
  const before = Math.floor(Date.now() / 1000);
  const { iceServers } = await (await fetch(`${baseUrl}/api/v1/rtc-config`, { headers: { Authorization: `Bearer ${user.token}` } })).json();
  const turn = iceServers.filter((server) => [].concat(server.urls).some((url) => url.startsWith('turn')));
  assert.equal(turn.length, 2, 'personal, then shared');
  const [expiry, owner] = turn[0].username.split(':');
  assert.equal(owner, user.user.id, 'the username names the user: the relay counts the quota per person');
  assert.ok(Number(expiry) >= before + TURN_CREDENTIAL_TTL_SECONDS - 5 && Number(expiry) <= before + TURN_CREDENTIAL_TTL_SECONDS + 5, 'expires in a day');
  // The relay's secret is derived from the XMPP key, which the VPS holds too (deploy/coturn/README.md).
  const relaySecret = createHmac('sha256', Buffer.from(SECRET, 'base64url')).update('hm-turn-rest-v1').digest('hex');
  assert.equal(turn[0].credential, createHmac('sha1', relaySecret).update(turn[0].username).digest('base64'), 'coturn use-auth-secret');
  assert.deepEqual([turn[1].username, turn[1].credential], ['shared', 'shared-secret']);
  assert.deepEqual([].concat(turn[0].urls), [].concat(turn[1].urls), 'the same relay');
});

test('the same relay with other credentials is kept as another server; exact repeats are dropped', () => {
  const servers = normalizeIceServers([
    { urls: ['turn:a:3478'], username: '1:u', credential: 'x' },
    { urls: ['turn:a:3478'], username: 'shared', credential: 'y' },
    { urls: ['turn:a:3478'], username: 'shared', credential: 'y' },
    { urls: 'stun:s:3478' }, { urls: 'stun:s:3478' },
  ]);
  assert.deepEqual(servers.map((server) => server.username ?? 'stun'), ['1:u', 'shared', 'stun']);
});
