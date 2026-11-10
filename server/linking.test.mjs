// Linking a browser by QR code (server/linking.mjs, src/linking.js): the session is handed over once, only with
// the QR's secret or the typed code; the history travels encrypted to the browser's key.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createChatServer } from './index.mjs';
import { openHistory, parseLinkQr, sealHistory } from '../src/linking.js';

let directory;
let service;
let base;
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-link-'));
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), pushSender: null });
  base = `http://127.0.0.1:${(await service.listen()).port}`;
});
after(async () => {
  await service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function api(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function browserKey() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, publicKey: btoa(String.fromCharCode(...raw)) };
}

test('scanning the QR links the browser as a new device and moves the history end to end', async () => {
  const phone = (await api('/api/v1/auth/register', { method: 'POST', body: { username: 'linker', dob: '1990-04-12', password: 'correct horse battery staple' } })).body;
  const key = await browserKey();
  const link = (await api('/api/v1/link/requests', { method: 'POST', body: { publicKey: key.publicKey, deviceName: 'Chrome on Windows' } })).body;
  assert.match(link.code, /^[A-Z2-9]{8}$/);
  const qr = `hmlink:1:${link.id}:${link.secret}:${key.publicKey}`;
  assert.deepEqual(parseLinkQr(qr), { id: link.id, secret: link.secret, publicKey: key.publicKey });
  assert.equal(parseLinkQr('https://evil.example/x'), null);

  // The browser waits; the phone looks the request up and approves it.
  const waiting = api(`/api/v1/link/requests/${link.id}?secret=${link.secret}`);
  assert.equal((await api('/api/v1/link/lookup', { token: phone.token, method: 'POST', body: { id: link.id, secret: 'x'.repeat(22) } })).status, 404, 'a wrong secret finds nothing');
  assert.equal((await api('/api/v1/link/lookup', { token: phone.token, method: 'POST', body: { id: link.id, secret: link.secret } })).body.deviceName, 'Chrome on Windows');
  const approved = await api(`/api/v1/link/requests/${link.id}/approve`, { token: phone.token, method: 'POST', body: { secret: link.secret } });
  assert.deepEqual([approved.status, approved.body.historyKey], [200, key.publicKey]);
  const handed = (await waiting).body;
  assert.equal(handed.status, 'approved');
  assert.equal(handed.session.user.id, phone.user.id);
  assert.notEqual(handed.session.deviceId, phone.deviceId, 'a new device of the same account');
  assert.equal((await api('/api/v1/me', { token: handed.session.token })).status, 200);
  assert.equal((await api(`/api/v1/link/requests/${link.id}?secret=${link.secret}`)).body.session, undefined, 'the session is handed over only once');
  assert.equal((await api(`/api/v1/link/requests/${link.id}/approve`, { token: phone.token, method: 'POST', body: { secret: link.secret } })).status, 404, 'a used code cannot link again');

  // History: sealed on the phone to the browser's key; the server relays only ciphertext.
  const snapshot = { kind: 'chats', chats: [{ id: 'peer' }], messages: { peer: [{ id: 'm1', timestamp: '2026-11-11T00:00:00.000Z', content: 'secret history' }] } };
  const sealed = await sealHistory(snapshot, key.publicKey);
  assert.equal(JSON.stringify(sealed).includes('secret history'), false);
  assert.equal((await api(`/api/v1/link/requests/${link.id}/history`, { token: phone.token, method: 'PUT', body: sealed })).status, 204);
  const relayed = await api(`/api/v1/link/requests/${link.id}/history?secret=${link.secret}`);
  assert.deepEqual(await openHistory(relayed.body, key.privateKey), snapshot);
  assert.equal((await api(`/api/v1/link/requests/${link.id}/history?secret=${link.secret}`)).status, 404, 'fetched once, then forgotten');
});

test('the typed code links without history; other accounts cannot upload history to someone else’s link', async () => {
  const phone = (await api('/api/v1/auth/register', { method: 'POST', body: { username: 'coder', dob: '1990-04-12', password: 'correct horse battery staple' } })).body;
  const other = (await api('/api/v1/auth/register', { method: 'POST', body: { username: 'intruder', dob: '1990-04-12', password: 'correct horse battery staple' } })).body;
  const key = await browserKey();
  const link = (await api('/api/v1/link/requests', { method: 'POST', body: { publicKey: key.publicKey } })).body;
  const typed = `${link.code.slice(0, 4)}-${link.code.slice(4).toLowerCase()}`;
  const found = (await api('/api/v1/link/lookup', { token: phone.token, method: 'POST', body: { code: typed } })).body;
  assert.equal(found.id, link.id);
  const approved = (await api(`/api/v1/link/requests/${link.id}/approve`, { token: phone.token, method: 'POST', body: { code: typed } })).body;
  assert.equal(approved.historyKey, null, 'no history over the code path: the key did not come out of band');
  const sealed = await sealHistory({ kind: 'chats', chats: [], messages: {} }, key.publicKey);
  assert.equal((await api(`/api/v1/link/requests/${link.id}/history`, { token: other.token, method: 'PUT', body: sealed })).status, 404);
  assert.equal((await api('/api/v1/link/requests', { method: 'POST', body: { publicKey: 'not-a-key' } })).status, 201, 'a browser without a key can still link (no history)');
});
