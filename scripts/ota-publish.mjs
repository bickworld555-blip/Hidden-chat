#!/usr/bin/env node
// Publishes the Android web build (dist-android) as an over-the-air update (server/otaUpdates.mjs, OtaUpdates.java).
//
//   ANDROID_APP_URL=https://hiddenmessenger.com npm run android:web      # build the bundle first
//   ADMIN_USERNAME=… ADMIN_PASSWORD=… node scripts/ota-publish.mjs [--dry-run] [--version <v>] [--origin <url>] [--dir dist-android]
//
// The manifest is signed with the OTA private key (OTA_SIGNING_KEY, default ~/.hidden-messenger/ota-signing-key.pem),
// which must stay on the publisher's machine: phones accept only bundles signed with it. Only files the server does
// not have yet are uploaded (so the 29 MB MediaPipe models go up once). Phones use the bundle from their next start.
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { execSync } from 'node:child_process';
import { NATIVE_API, OTA_PUBLIC_KEY, parseOtaPayload } from '../src/otaConfig.js';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const dryRun = args.includes('--dry-run');
const dir = resolve(option('dir', 'dist-android'));
const origin = option('origin', process.env.OTA_ORIGIN || 'https://hiddenmessenger.com').replace(/\/$/, '');
let gitSha = 'local';
try { gitSha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); } catch {}
const version = option('version', `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}-${gitSha}`);
const keyPath = process.env.OTA_SIGNING_KEY || join(homedir(), '.hidden-messenger', 'ota-signing-key.pem');

function walk(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const full = join(folder, entry.name);
    return entry.isDirectory() ? walk(full) : entry.isFile() ? [full] : [];
  });
}

const files = walk(dir).map((full) => {
  const bytes = readFileSync(full);
  return { path: relative(dir, full).split(sep).join('/'), sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, full };
}).sort((a, b) => a.path.localeCompare(b.path));

const payload = JSON.stringify({ version, nativeApi: NATIVE_API, createdAt: Date.now(), files: files.map(({ path, sha256, size }) => ({ path, sha256, size })) });
if (!parseOtaPayload(payload)) throw new Error('The bundle does not meet the OTA rules (paths, sizes, index.html): see src/otaConfig.js.');

const privateKey = createPrivateKey(readFileSync(keyPath));
if (createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64') !== OTA_PUBLIC_KEY) {
  throw new Error(`${keyPath} is not the key whose public half is built into the app (src/otaConfig.js OTA_PUBLIC_KEY).`);
}
const signature = sign('sha256', Buffer.from(payload, 'utf8'), privateKey).toString('base64');
const total = files.reduce((sum, file) => sum + file.size, 0);
console.log(`OTA ${version}: ${files.length} files, ${(total / 1048576).toFixed(1)} MB, native API ${NATIVE_API} → ${origin}`);
if (dryRun) process.exit(0);

const username = process.env.ADMIN_USERNAME;
const password = process.env.ADMIN_PASSWORD;
if (!username || !password) throw new Error('Set ADMIN_USERNAME and ADMIN_PASSWORD (the admin console sign-in).');
const login = await fetch(`${origin}/api/admin/v1/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-HM-Admin': '1' }, body: JSON.stringify({ username, password }) });
if (!login.ok) throw new Error(`Admin sign-in failed: HTTP ${login.status}`);
const cookie = login.headers.get('set-cookie')?.split(';')[0];
const admin = { Cookie: cookie, 'X-HM-Admin': '1' };

let uploaded = 0;
for (const file of files) {
  const present = await fetch(`${origin}/api/admin/v1/ota/files/${file.sha256}`, { method: 'HEAD', headers: admin });
  if (present.status === 200) continue;
  const put = await fetch(`${origin}/api/admin/v1/ota/files/${file.sha256}`, { method: 'PUT', headers: { ...admin, 'Content-Type': 'application/octet-stream' }, body: readFileSync(file.full) });
  if (!put.ok) throw new Error(`Upload of ${file.path} failed: HTTP ${put.status} ${await put.text()}`);
  uploaded += 1;
  console.log(`  uploaded ${file.path} (${(file.size / 1024).toFixed(0)} KB)`);
}
const published = await fetch(`${origin}/api/admin/v1/ota/manifest`, { method: 'PUT', headers: { ...admin, 'Content-Type': 'application/json' }, body: JSON.stringify({ payload, signature }) });
if (!published.ok) throw new Error(`Publishing the manifest failed: HTTP ${published.status} ${await published.text()}`);
console.log(`Published ${version} (${uploaded} new file${uploaded === 1 ? '' : 's'} uploaded). Phones use it from their next start.`);
