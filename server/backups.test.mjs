// End-to-end encrypted account backups: the server stores one opaque sealed file per account, hands it back only
// to that account, replaces it on the next upload, and refuses anything that is not a sealed backup.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatServer } from './index.mjs';
import { sealBackup, openBackup } from '../src/backup.js';
import { createRecoveryKey, formatRecoveryKey, normalizeSecret, validSecret } from '../src/cloudBackup.js';

let service;
let directory;
let baseUrl;
let counter = 0;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-backups-'));
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), dataDirectory: directory });
  baseUrl = `http://127.0.0.1:${(await service.listen()).port}`;
});

after(async () => {
  await service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function register() {
  counter += 1;
  const response = await fetch(`${baseUrl}/api/v1/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: `backup${counter}`, dob: '1990-04-12', password: 'Correct-Horse-Battery-42!' }) });
  return response.json();
}

const put = (session, body, kdf = 'recovery-key') => fetch(`${baseUrl}/api/v1/backup`, { method: 'PUT', headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/octet-stream', 'X-Backup-Kdf': kdf }, body });
const info = async (session) => (await fetch(`${baseUrl}/api/v1/backup`, { headers: { Authorization: `Bearer ${session.token}` } })).json();

test('a sealed backup is kept for its account only, replaced by the next one and deleted on request', async () => {
  const alice = await register();
  const bob = await register();
  const key = createRecoveryKey();
  const sealed = await sealBackup({ kind: 'chats', messages: { x: [] }, chats: [] }, key, { rounds: 100_000 });
  assert.equal((await put(alice, sealed)).status, 200);
  const first = await info(alice);
  assert.equal(first.exists, true);
  assert.equal(first.kdf, 'recovery-key');
  assert.deepEqual(await info(bob), { exists: false }, 'another account sees nothing');

  const downloaded = await (await fetch(`${baseUrl}/api/v1/backup/file`, { headers: { Authorization: `Bearer ${alice.token}` } })).text();
  assert.equal(downloaded, sealed, 'handed back unchanged');
  assert.deepEqual((await openBackup(downloaded, key)).messages, { x: [] }, 'only the key opens it');

  assert.equal((await put(alice, await sealBackup({ kind: 'chats', messages: {}, chats: [] }, key, { rounds: 100_000 }))).status, 200);
  assert.equal(readdirSync(join(directory, 'backups')).filter((name) => name.endsWith('.hmbackup')).length, 1, 'the old file is replaced');

  assert.equal((await put(alice, 'plain text, not a backup')).status, 400, 'only sealed backups');
  assert.equal((await fetch(`${baseUrl}/api/v1/backup`, { method: 'DELETE', headers: { Authorization: `Bearer ${alice.token}` } })).status, 204);
  assert.deepEqual(await info(alice), { exists: false });
});

test('a recovery key is 64 digits, shown in groups of four, typed with or without spaces', () => {
  const key = createRecoveryKey();
  assert.match(key, /^\d{64}$/);
  assert.equal(formatRecoveryKey(key).split(' ').length, 16);
  assert.equal(normalizeSecret(formatRecoveryKey(key), 'recovery-key'), key);
  assert.equal(validSecret(key, 'recovery-key'), true);
  assert.equal(validSecret(key.slice(1), 'recovery-key'), false);
  assert.equal(validSecret('short', 'password'), false);
});
