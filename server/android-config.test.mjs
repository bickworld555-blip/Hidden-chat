import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ANDROID_WEB_DIR, BUNDLED_APP_ORIGIN, androidConfig, bundledCsp } from '../scripts/configure-android.mjs';
import { verifyBundle } from '../scripts/build-android-web.mjs';

test('Android app runs its bundled web assets only: no remote server.url, strict CSP, API origin validated', async () => {
  const config = androidConfig('https://example.com/');
  assert.equal(config.server.url, undefined, 'never loads the app from a website');
  assert.equal(config.webDir, ANDROID_WEB_DIR);
  assert.deepEqual(config.server, { androidScheme: 'https', hostname: 'localhost', cleartext: false });
  assert.equal(`${config.server.androidScheme}://${config.server.hostname}`, BUNDLED_APP_ORIGIN, 'the origin the server allows');
  assert.equal(config.android.allowMixedContent, false);
  assert.equal(config.android.webContentsDebuggingEnabled, false);
  for (const value of [undefined, '', 'http://example.com', 'https://user:pass@example.com', 'https://example.com/app', 'https://example.com/?token=x', 'https://example.com/#x', 'https://localhost', 'https://example.invalid']) {
    assert.throws(() => androidConfig(value));
  }
  const csp = bundledCsp('https://example.com');
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval';/, 'scripts only from the APK');
  assert.ok(csp.includes('https://example.com wss://example.com'), 'network to the app server');
  assert.ok(csp.includes("object-src 'none'") && csp.includes("frame-src 'none'"));
  const server = await readFile(new URL('./index.mjs', import.meta.url), 'utf8');
  assert.ok(server.includes('configuredOrigins.includes(origin) || origin === BUNDLED_APP_ORIGIN'), 'the bundled app may call the API in production');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['android:sync'], 'npm run android:configure && npm run android:web && cap sync android');
});

test('bundle check refuses remote code, missing files, a missing CSP and the website service worker', () => {
  const folder = mkdtempSync(join(tmpdir(), 'bundle-'));
  try {
    mkdirSync(join(folder, 'assets'));
    writeFileSync(join(folder, 'assets', 'app.js'), 'console.log(1)');
    const page = (body) => writeFileSync(join(folder, 'index.html'), `<html><head><meta http-equiv="Content-Security-Policy" content="x">${body}</head></html>`);
    page('<script type="module" src="/assets/app.js"></script>');
    assert.equal(verifyBundle(folder).scripts, 1);
    page('<script src="https://cdn.example.com/x.js"></script>');
    assert.throws(() => verifyBundle(folder), /remote code/);
    page('<script src="/assets/missing.js"></script>');
    assert.throws(() => verifyBundle(folder), /missing file/);
    writeFileSync(join(folder, 'index.html'), '<html><script src="/assets/app.js"></script></html>');
    assert.throws(() => verifyBundle(folder), /Content-Security-Policy/);
    page('<script type="module" src="/assets/app.js"></script>');
    writeFileSync(join(folder, 'sw.js'), '');
    assert.throws(() => verifyBundle(folder), /service worker/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('Android manifest declares camera, microphone and foreground location without cleartext or backup', async () => {
  const manifest = await readFile(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8');
  for (const permission of ['INTERNET', 'CAMERA', 'RECORD_AUDIO', 'MODIFY_AUDIO_SETTINGS', 'ACCESS_COARSE_LOCATION', 'ACCESS_FINE_LOCATION']) {
    assert.ok(manifest.includes(`android.permission.${permission}`));
  }
  assert.ok(manifest.includes('android:allowBackup="false"'));
  assert.ok(manifest.includes('android:usesCleartextTraffic="false"'));
  const gradle = await readFile(new URL('../android/app/build.gradle', import.meta.url), 'utf8');
  assert.ok(gradle.includes('signingConfig signingConfigs.release'));
  assert.ok(gradle.includes("throw new GradleException('Release APK requires"));
  assert.ok(gradle.includes("System.getenv('ANDROID_VERSION_CODE')"));
});

test('APK workflow tests the app, signs release output and verifies its signature before upload', async () => {
  const workflow = await readFile(new URL('../.github/workflows/build-apk.yml', import.meta.url), 'utf8');
  for (const contract of ['npm ci', 'npm test', 'npm run build', 'npm run android:sync', 'assembleRelease', 'verify --verbose', 'actions/upload-artifact@v4', 'ANDROID_KEYSTORE_BASE64', 'if-no-files-found: error']) {
    assert.ok(workflow.includes(contract), `Missing workflow requirement: ${contract}`);
  }
});

test('Android SDK setup overrides deprecated defaults with the declared SDK packages', async () => {
  const workflow = await readFile(new URL('../.github/workflows/build-apk.yml', import.meta.url), 'utf8');
  const sdk = await readFile(new URL('../android/variables.gradle', import.meta.url), 'utf8');
  const setup = workflow.match(/- uses: android-actions\/setup-android@v3\r?\n\s+with:\r?\n\s+packages: '([^']+)'/);
  assert.ok(setup, 'SDK setup must explicitly override the action default packages');
  const packages = setup[1].split(/\s+/);
  assert.deepEqual(packages, ['platform-tools', 'platforms;android-36', 'build-tools;36.0.0']);
  assert.ok(!packages.includes('tools'), 'The deprecated tools package must not be requested');
  assert.match(sdk, /compileSdkVersion = 36\b/);
  assert.match(sdk, /targetSdkVersion = 36\b/);
  assert.ok(!workflow.includes('run: sdkmanager'), 'SDK installation is owned by the setup action');
});
