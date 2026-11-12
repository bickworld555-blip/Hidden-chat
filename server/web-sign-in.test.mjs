// On a computer Hidden Messenger opens only by linking with the phone (QR code): a browser, or the desktop app that
// loads the website, cannot sign in with a password or create an account. The Android app can.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatServer } from './index.mjs';
import { webPasswordSignInAllowed } from './clientGate.mjs';
import { BUNDLED_APP_ORIGIN } from '../scripts/configure-android.mjs';
import { companionOnly } from '../src/companion.js';

const PASSWORD = 'Correct-Horse-Battery-42!';
let service;
let directory;
let baseUrl;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-web-sign-in-'));
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), dataDirectory: directory, webPasswordSignIn: false });
  baseUrl = `http://127.0.0.1:${(await service.listen()).port}`;
});

after(async () => {
  await service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

const post = (path, body, origin) => fetch(baseUrl + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
  body: JSON.stringify(body),
});

test('production refuses password sign-in from browsers by default; a developer can allow it', () => {
  assert.equal(webPasswordSignInAllowed({ NODE_ENV: 'production' }), false);
  assert.equal(webPasswordSignInAllowed({ DATABASE_URL: 'postgres://x' }), false);
  assert.equal(webPasswordSignInAllowed({}), true);
  assert.equal(webPasswordSignInAllowed({ NODE_ENV: 'production', RELAY_WEB_PASSWORD_SIGNIN: '1' }), true);
  assert.equal(webPasswordSignInAllowed({ RELAY_WEB_PASSWORD_SIGNIN: '0' }), false);
});

test('the sign-in screen offers only the QR code outside the Android app (except a development build)', () => {
  assert.equal(companionOnly({ native: false, development: false }), true);
  assert.equal(companionOnly({ native: true, development: false }), false);
  assert.equal(companionOnly({ native: false, development: true }), false);
});

test('a browser cannot create an account or sign in with a password; the Android app can', async () => {
  const webOrigin = 'http://localhost:5173';
  const refused = await post('/api/v1/auth/register', { username: 'webuser', dob: '1990-04-12', password: PASSWORD }, webOrigin);
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).code, 'link_with_phone');

  const created = await post('/api/v1/auth/register', { username: 'phoneuser', dob: '1990-04-12', password: PASSWORD }, BUNDLED_APP_ORIGIN);
  assert.equal(created.status, 201);
  const login = await post('/api/v1/auth/login', { identity: 'phoneuser', password: PASSWORD }, webOrigin);
  assert.equal(login.status, 403);
  assert.equal((await post('/api/v1/auth/login', { identity: 'phoneuser', password: PASSWORD }, BUNDLED_APP_ORIGIN)).status, 200);
  assert.equal((await post('/api/v1/auth/login', { identity: 'phoneuser', password: PASSWORD })).status, 200, 'not a browser (no Origin)');
});
