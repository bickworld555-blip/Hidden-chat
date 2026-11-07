import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { androidConfig } from '../scripts/configure-android.mjs';

test('Android shell accepts only an explicit HTTPS app origin and keeps WebView protections enabled', () => {
  const config = androidConfig('https://example.com/');
  assert.equal(config.server.url, 'https://example.com');
  assert.equal(config.server.cleartext, false);
  assert.equal(config.android.allowMixedContent, false);
  assert.equal(config.android.webContentsDebuggingEnabled, false);
  for (const value of [undefined, '', 'http://example.com', 'https://user:pass@example.com', 'https://example.com/app', 'https://example.com/?token=x', 'https://example.com/#x', 'https://localhost', 'https://example.invalid']) {
    assert.throws(() => androidConfig(value));
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
