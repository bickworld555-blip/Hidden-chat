// The chat list's picture for the next cold start (src/launchSnapshot.js, LaunchSnapshot.java): when it may be taken
// and kept. The picture shows names and last messages, so the rules are the feature.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { launchSnapshotState } from '../src/launchSnapshot.js';

const plain = { signedIn: true, listScreen: true, listPlain: true, overlays: 0, inCall: false, locked: false, appLock: false, screenSecurity: false };
const java = (name) => readFileSync(new URL(`../android/app/src/main/java/io/github/bickworld555/hiddenchat/${name}.java`, import.meta.url), 'utf8');

test('the picture is taken only of the plain chat list', () => {
  assert.deepEqual(launchSnapshotState(plain), { onShow: true, allowed: true });
  for (const change of [{ listScreen: false }, { listPlain: false }, { overlays: 1 }, { inCall: true }, { locked: true }]) {
    assert.deepEqual(launchSnapshotState({ ...plain, ...change }), { onShow: false, allowed: true }, JSON.stringify(change));
  }
});

test('app lock, screen security or no account: no picture is kept at all', () => {
  for (const change of [{ appLock: true }, { screenSecurity: true }, { signedIn: false }]) {
    assert.deepEqual(launchSnapshotState({ ...plain, ...change }), { onShow: false, allowed: false }, JSON.stringify(change));
  }
  assert.deepEqual(launchSnapshotState(), { onShow: false, allowed: false });
});

test('the phone deletes the picture on sign-out, with screen security, and when the app says it may not be kept', () => {
  assert.match(java('HiddenNativePlugin'), /public void clearSession[\s\S]{0,900}LaunchSnapshot\.delete\(getContext\(\)\)/);
  assert.match(java('AppSecurity'), /if \(enabled\) LaunchSnapshot\.delete\(activity\)/);
  assert.match(java('LaunchSnapshot'), /if \(!mayKeep\) delete\(context\)/);
});

test('the picture is encrypted with a Keystore-sealed key and never written without one', () => {
  const source = java('LaunchSnapshot');
  assert.match(source, /AES\/GCM\/NoPadding/);
  assert.match(source, /SecureStore\.seal\(/);
  assert.doesNotMatch(source, /sealOrKeep/);
  assert.match(source, /getNoBackupFilesDir/);
});

test('the picture is shown only on a start from the app icon and never with screen security', () => {
  const source = java('LaunchSnapshot');
  assert.match(source, /static void preload[\s\S]{0,300}!launcherStart\(activity\.getIntent\(\)\) \|\| AppSecurity\.secureScreen\(activity\)/);
  assert.match(source, /static void capture[\s\S]{0,400}!listOnShow \|\| !allowed \|\| overlay != null \|\| AppSecurity\.secureScreen\(activity\)/);
});

test('the list reports the locked folder as not plain', () => {
  const list = readFileSync(new URL('../src/components/ChatsList.jsx', import.meta.url), 'utf8');
  assert.match(list, /const plainList = !showLocked && !lockPrompt && !showArchived/);
});
