// Apps older than the current wire version are refused (426) over HTTP and on the realtime socket; the current app
// (src/clientVersion.js) gets through, and so do browser-fetched avatars and health checks.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createChatServer } from './index.mjs';
import { CURRENT_CLIENT_PROTOCOL, minimumClientProtocol } from './clientGate.mjs';
import { CLIENT_HEADER, CLIENT_PROTOCOL, CLIENT_SUBPROTOCOL } from '../src/clientVersion.js';

let service;
let directory;
let baseUrl;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-gate-'));
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), dataDirectory: directory, minClientProtocol: CURRENT_CLIENT_PROTOCOL });
  baseUrl = `http://127.0.0.1:${(await service.listen()).port}`;
});

after(async () => {
  await service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

const register = (headers) => fetch(`${baseUrl}/api/v1/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify({ username: `gate${Math.random().toString(36).slice(2, 8)}`, dob: '1990-04-12', password: 'Correct-Horse-Battery-42!' }),
});

test('the app and the server agree on the current version; production refuses older apps by default', () => {
  assert.equal(CLIENT_PROTOCOL, CURRENT_CLIENT_PROTOCOL);
  assert.equal(minimumClientProtocol({ NODE_ENV: 'production' }), CURRENT_CLIENT_PROTOCOL);
  assert.equal(minimumClientProtocol({ DATABASE_URL: 'postgresql://x' }), CURRENT_CLIENT_PROTOCOL);
  assert.equal(minimumClientProtocol({}), 0, 'local development is open');
  assert.equal(minimumClientProtocol({ NODE_ENV: 'production', RELAY_MIN_CLIENT: '0' }), 0, 'an operator can open it again');
});

test('an old app is told to update; the current app gets through', async () => {
  const old = await register({});
  assert.equal(old.status, 426);
  assert.equal((await old.json()).code, 'update_required');
  const current = await register({ [CLIENT_HEADER]: String(CLIENT_PROTOCOL) });
  assert.equal(current.status, 201);
  const session = await current.json();
  assert.equal((await fetch(`${baseUrl}/api/v1/ready`)).status === 426, false, 'health checks stay open');
  assert.notEqual((await fetch(`${baseUrl}/api/v1/users/${session.user.id}/avatar`)).status, 426, 'avatars load in <img> tags');

  const open = (protocols) => new Promise((resolve) => {
    const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/ws', protocols);
    socket.once('open', () => { socket.close(); resolve('open'); });
    socket.once('unexpected-response', (_request, response) => resolve(response.statusCode));
    socket.once('error', () => resolve('error'));
  });
  assert.equal(await open([`relay.auth.${session.token}`, 'relay.v1']), 426, 'old app: no realtime');
  assert.equal(await open([`relay.auth.${session.token}`, 'relay.v1', CLIENT_SUBPROTOCOL]), 'open');
});
