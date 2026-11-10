// Group calls through an SFU, prepared: topology choice, config validation and room tokens (server/sfu.mjs,
// src/callTopology.js). No SFU is contacted; the tokens are checked for format and signature.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import express from 'express';
import { createChatServer } from './index.mjs';
import { mintSfuToken, registerSfu, roomForGroup, sfuConfigFromEnv } from './sfu.mjs';
import { MESH_MAX_PARTICIPANTS, SFU_MEDIA_CLIENT, callCapacity, parseTopology, planCall } from '../src/callTopology.js';
import { MAX_CALL_PARTICIPANTS } from '../src/callRoom.js';

const SECRET = 'a-very-long-sfu-api-secret-for-tests-0123456789';

test('SFU config: off unless fully configured, refuses partial or insecure settings', () => {
  assert.equal(sfuConfigFromEnv({}), null);
  assert.throws(() => sfuConfigFromEnv({ SFU_URL: 'wss://sfu.example.com' }), /all required/);
  assert.throws(() => sfuConfigFromEnv({ SFU_URL: 'ws://sfu.example.com', SFU_API_KEY: 'k', SFU_API_SECRET: SECRET }), /wss/);
  assert.throws(() => sfuConfigFromEnv({ SFU_URL: 'wss://sfu.example.com', SFU_API_KEY: 'k', SFU_API_SECRET: 'short' }), /32 characters/);
  assert.throws(() => sfuConfigFromEnv({ SFU_URL: 'wss://sfu.example.com', SFU_API_KEY: 'k', SFU_API_SECRET: SECRET, SFU_MAX_PARTICIPANTS: '2' }), /SFU_MAX_PARTICIPANTS/);
  assert.deepEqual(sfuConfigFromEnv({ SFU_URL: 'wss://sfu.example.com/', SFU_API_KEY: 'key1', SFU_API_SECRET: SECRET }), { url: 'wss://sfu.example.com', apiKey: 'key1', apiSecret: SECRET, maxParticipants: 32 });
});

test('room tokens are HS256 JWTs with a video grant for one room, signed with the API secret', () => {
  const config = { url: 'wss://sfu.example.com', apiKey: 'key1', apiSecret: SECRET, maxParticipants: 32 };
  const token = mintSfuToken(config, { identity: 'u1', name: 'Ann', room: roomForGroup('g1'), now: 1_700_000_000_000 });
  const [header, payload, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'HS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.equal(claims.iss, 'key1');
  assert.equal(claims.sub, 'u1');
  assert.equal(claims.exp - claims.iat, 600);
  assert.deepEqual(claims.video, { room: 'group-g1', roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
  assert.equal(signature, createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url'));
});

test('topology: mesh up to its limit; the SFU only when advertised and the app has an SFU media client', () => {
  assert.equal(MAX_CALL_PARTICIPANTS, MESH_MAX_PARTICIPANTS, 'one owner for the mesh limit');
  assert.equal(SFU_MEDIA_CLIENT, false, 'prepared: no SFU media client in the app yet');
  const none = parseTopology({ sfu: null, meshMaxParticipants: 4 });
  const advertised = parseTopology({ sfu: { url: 'wss://sfu.example.com' }, meshMaxParticipants: 4, sfuMaxParticipants: 32 });
  assert.deepEqual(planCall(none, 8), { topology: 'mesh', capacity: 4 });
  assert.deepEqual(planCall(advertised, 8), { topology: 'mesh', capacity: 4 }, 'without the media client calls stay on mesh');
  assert.deepEqual(planCall(advertised, 3, { mediaClient: true }), { topology: 'mesh', capacity: 4 }, 'small calls stay on mesh');
  assert.deepEqual(planCall(advertised, 8, { mediaClient: true }), { topology: 'sfu', capacity: 32 });
  assert.equal(callCapacity(advertised, { mediaClient: true }), 32);
  assert.equal(callCapacity(advertised), 4);
  assert.equal(parseTopology({ sfu: { url: 'http://x' }, sfuMaxParticipants: 9 }).sfu, null, 'only wss SFUs');
});

test('the server advertises mesh by default; with an SFU it gives members (only) a room token', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-sfu-'));
  const service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), pushSender: null });
  const base = `http://127.0.0.1:${(await service.listen()).port}`;
  const call = async (path, token, method = 'GET', body) => {
    const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  try {
    const register = async (name) => (await fetch(`${base}/api/v1/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, dob: '1990-04-12', password: 'correct horse battery staple' }) })).json();
    const owner = await register('sfuowner');
    const outsider = await register('sfuoutsider');
    assert.deepEqual((await call('/api/v1/calls/topology', owner.token)).body, { sfu: null, meshMaxParticipants: 4 });
    const group = (await call('/api/v1/groups', owner.token, 'POST', { name: 'Big call', memberIds: [] })).body;
    assert.equal((await call(`/api/v1/groups/${group.id}/call-token`, owner.token, 'POST')).status, 404, 'no SFU configured');

    // The same routes with an SFU configured (mounted on a small app sharing the server's database API).
    const app = express();
    const sessions = new Map([[owner.token, { user_id: owner.user.id, user: owner.user }], [outsider.token, { user_id: outsider.user.id, user: outsider.user }]]);
    const requireSession = (request, response, next) => {
      const session = sessions.get((request.get('authorization') ?? '').replace('Bearer ', ''));
      if (!session) return response.status(401).end();
      request.session = session;
      return next();
    };
    const memberships = new Set([`${group.id}:${owner.user.id}`]);
    const db = { prepare: () => ({ get: async (groupId, userId) => (memberships.has(`${groupId}:${userId}`) ? { 1: 1 } : undefined) }) };
    registerSfu({ app, db, requireSession, config: { url: 'wss://sfu.example.com', apiKey: 'key1', apiSecret: SECRET, maxParticipants: 50 } });
    const server = app.listen(0);
    const sfuBase = `http://127.0.0.1:${server.address().port}`;
    try {
      const post = (token) => fetch(`${sfuBase}/api/v1/groups/${group.id}/call-token`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      const granted = await (await post(owner.token)).json();
      assert.equal(granted.room, `group-${group.id}`);
      assert.equal(JSON.parse(Buffer.from(granted.token.split('.')[1], 'base64url')).sub, owner.user.id);
      assert.equal((await post(outsider.token)).status, 404, 'non-members get no token');
      const topology = await (await fetch(`${sfuBase}/api/v1/calls/topology`, { headers: { Authorization: `Bearer ${owner.token}` } })).json();
      assert.deepEqual(topology, { sfu: { url: 'wss://sfu.example.com' }, meshMaxParticipants: 4, sfuMaxParticipants: 50 });
    } finally {
      server.close();
    }
  } finally {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
