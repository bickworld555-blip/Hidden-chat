// Over-the-air web updates: the server stores and serves signed bundles and refuses unsigned or incomplete ones; the
// app and the Android shell share one native API number and one public key; the shell verifies, rolls back and
// serves the background page from the confirmed copy.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import express from 'express';
import { registerOtaUpdates, verifyOtaManifest } from './otaUpdates.mjs';
import { NATIVE_API, OTA_PUBLIC_KEY, parseOtaPayload } from '../src/otaConfig.js';
import { otaOrigin, startOtaUpdates } from '../src/otaUpdates.js';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const testKey = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const signed = (payload, key = privateKey) => ({ payload, signature: sign('sha256', Buffer.from(payload), key).toString('base64') });
const bundle = (version, files) => JSON.stringify({ version, nativeApi: 1, createdAt: Date.now(), files });

let directory;
let server;
let base;
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-ota-'));
  const app = express();
  const requireAdmin = (request, response, next) => (request.get('x-test-admin') === 'yes' ? next() : response.status(403).end());
  registerOtaUpdates({ app, dataDirectory: directory, requireAdmin, publicKey: testKey });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

test('a bundle is published only when signed and complete, and phones fetch files by hash', async () => {
  const admin = { 'x-test-admin': 'yes' };
  assert.equal((await fetch(`${base}/ota/manifest.json`)).status, 404, 'nothing published yet');
  const index = Buffer.from('<!doctype html><title>v2</title>');
  const script = Buffer.from('console.log("v2")');
  const files = [{ path: 'index.html', sha256: sha(index), size: index.length }, { path: 'assets/app.js', sha256: sha(script), size: script.length }];
  const payload = bundle('2026.11.17-a', files);

  assert.equal((await fetch(`${base}/api/admin/v1/ota/files/${sha(index)}`, { method: 'PUT', body: index })).status, 403, 'admins only');
  assert.equal((await fetch(`${base}/api/admin/v1/ota/files/${sha(script)}`, { method: 'PUT', headers: admin, body: index })).status, 400, 'bytes must match the hash');
  assert.equal((await fetch(`${base}/api/admin/v1/ota/files/${sha(index)}`, { method: 'PUT', headers: admin, body: index })).status, 204);
  const incomplete = await fetch(`${base}/api/admin/v1/ota/manifest`, { method: 'PUT', headers: { ...admin, 'Content-Type': 'application/json' }, body: JSON.stringify(signed(payload)) });
  assert.equal(incomplete.status, 409, 'every file must be on the server first');
  assert.equal((await fetch(`${base}/api/admin/v1/ota/files/${sha(script)}`, { method: 'HEAD', headers: admin })).status, 404);
  assert.equal((await fetch(`${base}/api/admin/v1/ota/files/${sha(script)}`, { method: 'PUT', headers: admin, body: script })).status, 204);
  const forged = await fetch(`${base}/api/admin/v1/ota/manifest`, { method: 'PUT', headers: { ...admin, 'Content-Type': 'application/json' }, body: JSON.stringify(signed(payload, other)) });
  assert.equal(forged.status, 400, 'signed with another key: refused');
  const ok = await fetch(`${base}/api/admin/v1/ota/manifest`, { method: 'PUT', headers: { ...admin, 'Content-Type': 'application/json' }, body: JSON.stringify(signed(payload)) });
  assert.deepEqual([ok.status, await ok.json()], [200, { version: '2026.11.17-a', files: 2 }]);

  const manifest = await fetch(`${base}/ota/manifest.json`);
  assert.equal(manifest.headers.get('cache-control'), 'no-cache');
  const served = await manifest.json();
  assert.equal(verifyOtaManifest(served, testKey).version, '2026.11.17-a', 'what phones get verifies with the key');
  const file = await fetch(`${base}/ota/files/${sha(script)}`);
  assert.equal(Buffer.from(await file.arrayBuffer()).toString(), 'console.log("v2")');
  assert.match(file.headers.get('cache-control'), /immutable/);
  assert.equal((await fetch(`${base}/ota/files/${'0'.repeat(64)}`)).status, 404);
  assert.equal((await fetch(`${base}/ota/files/..%2Fmanifest.json`)).status, 400);
});

test('bundle rules: plain relative paths, hashes, sizes, an index page', () => {
  const file = (path) => ({ path, sha256: 'a'.repeat(64), size: 1 });
  assert.ok(parseOtaPayload(bundle('v1', [file('index.html'), file('assets/x.js'), file('mediapipe/wasm/a.wasm')])));
  for (const bad of ['../x', 'a/../b', '/abs', 'a//b', 'a\\b', './x', 'a/./b']) {
    assert.equal(parseOtaPayload(bundle('v1', [file('index.html'), file(bad)])), null, bad);
  }
  assert.equal(parseOtaPayload(bundle('v1', [file('app.js')])), null, 'no index.html');
  assert.equal(parseOtaPayload(bundle('v 1', [file('index.html')])), null, 'bad version');
  assert.equal(parseOtaPayload(bundle('v1', [file('index.html'), file('index.html')])), null, 'duplicate path');
  assert.equal(parseOtaPayload('{not json'), null);
});

test('the app and the Android shell share the native API number, the key and the rules', () => {
  const java = readFileSync(new URL('../android/app/src/main/java/io/github/bickworld555/hiddenchat/OtaUpdates.java', import.meta.url), 'utf8');
  assert.ok(java.includes(`static final int NATIVE_API = ${NATIVE_API};`));
  assert.ok(java.includes(`static final String PUBLIC_KEY = "${OTA_PUBLIC_KEY}";`));
  assert.ok(java.includes('Signature.getInstance("SHA256withECDSA")'), 'the shell verifies the signature itself');
  assert.match(java, /if \(boots < 2\) \{[\s\S]*?\/\/ Started with this bundle before and it never confirmed/, 'a bundle that never confirmed is rolled back');
  assert.ok(java.includes('if (p.getLong("apk", -2) != installed)'), 'a new APK starts from its own code');
  assert.ok(java.includes('return info.lastUpdateTime;'), 'every build is versionCode 1: the install time tells APKs apart');
  assert.ok(java.includes('copyIfMatches(') && java.includes('download(origin + "/ota/files/" + sha'), 'only changed files are downloaded');
  const activity = readFileSync(new URL('../android/app/src/main/java/io/github/bickworld555/hiddenchat/AppActivity.java', import.meta.url), 'utf8');
  assert.ok(activity.indexOf('OtaUpdates.beforeBridge(this);') < activity.indexOf('super.onCreate(savedInstanceState);'), 'before the bridge picks the copy');
  const headless = readFileSync(new URL('../android/app/src/main/java/io/github/bickworld555/hiddenchat/HeadlessRunner.java', import.meta.url), 'utf8');
  assert.ok(headless.includes('OtaUpdates.confirmedDir(appContext)'), 'the background page runs the same code');
});

test('the app confirms its start, checks for updates later, and never during a call', async () => {
  assert.equal(otaOrigin(() => 'https://hiddenmessenger.com/api/'), 'https://hiddenmessenger.com');
  assert.equal(otaOrigin(() => 'http://insecure.example/api/'), null, 'HTTPS only');
  assert.equal(otaOrigin(() => '/api/'), null);
  const stop = startOtaUpdates({ shell: () => false });
  assert.equal(typeof stop, 'function', 'a browser: nothing to do');
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /startOtaUpdates\(\{ busy: \(\) => Boolean\(callRef\.current && !TERMINAL_STATUSES\.includes\(callRef\.current\.status\)\) \}\)/);
});

test('the app shell refuses a bundle made before the web code built into the APK', () => {
  // A bundle published on 20 Nov 2026 stayed on the server; every APK built after it downloaded it 20 s after its
  // first start and ran that older web code from the second start on.
  const shell = readFileSync(new URL('../android/app/src/main/java/io/github/bickworld555/hiddenchat/OtaUpdates.java', import.meta.url), 'utf8');
  assert.match(shell, /if \(payload\.optLong\("createdAt", 0\) <= bundledBuiltAt\(context\)\) return "older-than-app";/);
  assert.ok(shell.indexOf('return "older-than-app"') < shell.indexOf('File part = new File'), 'decided before anything is downloaded');
  assert.match(shell, /BUILD_STAMP = "build\.json"/);
  const build = readFileSync(new URL('../scripts/build-android-web.mjs', import.meta.url), 'utf8');
  assert.match(build, /export const BUILD_STAMP = 'build\.json';/);
  assert.match(build, /writeFileSync\(join\(outDir, BUILD_STAMP\), JSON\.stringify\(\{ builtAt: Date\.now\(\) \}\)/);
});
