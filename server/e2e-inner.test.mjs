// What travels inside the encryption arrives: a reply's quoted message id, "forwarded", a status reply and a link
// preview survive sealing on one device and opening on another (src/e2e/client.js innerOf → innerFrom).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatServer } from './index.mjs';
import { createProtocol } from '../src/e2e/protocol.js';
import { buildEnvelope, routingFor } from '../src/e2e/envelope.js';
import { innerFrom, innerOf, openDirectMessage, startE2e, stopE2e } from '../src/e2e/client.js';

const PASSWORD = 'Correct-Horse-Battery-42!';
let service;
let directory;
let baseUrl;
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-e2e-inner-'));
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), dataDirectory: directory });
  baseUrl = `http://127.0.0.1:${(await service.listen()).port}`;
});
after(async () => {
  stopE2e();
  await service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

const memoryStorage = () => {
  const memory = new Map();
  return { get: async (key) => memory.get(key), set: async (key, value) => { memory.set(key, value); }, del: async (key) => { memory.delete(key); } };
};
async function api(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(baseUrl + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return response.json();
}
const register = (username) => api('/api/v1/auth/register', { method: 'POST', body: { username, dob: '1990-04-12', password: PASSWORD } });

test('the payload reader keeps every field the writer puts in, checked, and nothing else', () => {
  const written = innerOf('Sure!', { replyToId: 'm-42', forwarded: true, statusReply: { kind: 'text', text: 'Hi', bg: '#00897b' } });
  assert.deepEqual(innerFrom(JSON.parse(JSON.stringify(written))), written);
  assert.deepEqual(innerFrom({ c: 'x', r: 42, fw: true, extra: 'dropped', sr: { kind: 'bogus' } }), { c: 'x' });
  assert.deepEqual(innerFrom({ c: 'x', r: 'y'.repeat(200) }), { c: 'x' }, 'an oversized id is not a reply');
  assert.equal(innerFrom({ r: 'm-1' }), null, 'no text: not a message');
  assert.equal(innerFrom(null), null);
});

test('a reply sealed on one device opens on the other with its quote, "forwarded" and status reply', async () => {
  const ava = await register('innerava');
  const ben = await register('innerben');
  // Ben's phone: the app's own session (keys published to the server).
  await startE2e({ token: ben.token, userId: ben.user.id, deviceId: ben.deviceId, storage: memoryStorage(), fetchImpl: (path, options) => fetch(baseUrl + path, options) });
  // Ava's phone seals a reply to Ben's message m-42, as the app does (src/e2e/client.js innerOf).
  const protocol = createProtocol({ storage: memoryStorage() });
  await api('/api/v1/e2e/keys', { token: ava.token, method: 'PUT', body: await protocol.prepareUpload({ serverPreKeyCount: 0 }) });
  const devices = (await api(`/api/v1/e2e/users/${ben.user.id}/devices`, { token: ava.token })).devices;
  const claim = async (userId, deviceIds) => (await api(`/api/v1/e2e/users/${userId}/bundles`, { token: ava.token, method: 'POST', body: { deviceIds } })).bundles;
  const seal = async (content, extra) => buildEnvelope(routingFor(content), { sd: ava.deviceId, d: await protocol.encryptForDevices({ [ben.user.id]: devices }, JSON.stringify(innerOf(content, extra)), { claimBundles: claim }) });

  const reply = await openDirectMessage({ id: 'r-1', senderId: ava.user.id, receiverId: ben.user.id, content: await seal('Sure!', { replyToId: 'm-42' }) });
  assert.equal(reply.content, 'Sure!');
  assert.deepEqual(reply.replyTo, { id: 'm-42' }, 'the quoted message travels inside the encryption and arrives');

  const forwarded = await openDirectMessage({ id: 'r-2', senderId: ava.user.id, receiverId: ben.user.id, content: await seal('Look at this', { forwarded: true }) });
  assert.equal(forwarded.forwarded, true);

  const statusReply = await openDirectMessage({ id: 'r-3', senderId: ava.user.id, receiverId: ben.user.id, content: await seal('😍', { statusReply: { kind: 'text', text: 'Beach', bg: '#00897b', reaction: true } }) });
  assert.deepEqual(statusReply.statusReply, { kind: 'text', text: 'Beach', reaction: true, bg: '#00897b' });
  stopE2e();
});
