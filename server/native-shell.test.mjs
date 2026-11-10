import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, test } from 'node:test';
import { nativeAlertsActive, nativeNotify, nativeShell, nativeState, resetNativeStateForTests } from '../src/native.js';
import { NATIVE_SOUNDS, renderTone } from '../scripts/generate-native-sounds.mjs';

const root = new URL('../', import.meta.url);

afterEach(() => {
  delete globalThis.Capacitor;
  delete globalThis.androidBridge;
  resetNativeStateForTests();
});

test('outside the Android shell (or in an APK without the plugin) the bridge does nothing', async () => {
  assert.equal(nativeShell(), false);
  assert.equal(await nativeNotify({ channel: 'group_messages', title: 't', body: 'b' }), null);
  assert.equal(nativeAlertsActive({ visibilityState: 'hidden' }), false);
  globalThis.Capacitor = { isNativePlatform: () => true, isPluginAvailable: (name) => name === 'Other' };
  assert.equal(nativeShell(), false, 'an older APK without HiddenNative keeps the web behaviour');
  globalThis.Capacitor = { isNativePlatform: () => true, isPluginAvailable: (name) => name === 'HiddenNative' };
  assert.equal(nativeShell(), true);
  assert.equal(nativeAlertsActive({ visibilityState: 'hidden' }), false, 'native alerts only once notifications are known to be enabled');
});

test('the three native channel sounds are distinct, valid 16-bit mono WAVs', async () => {
  const files = await Promise.all(NATIVE_SOUNDS.map(({ file }) => readFile(new URL(`android/app/src/main/res/raw/${file}`, root))));
  for (const [index, file] of files.entries()) {
    assert.equal(file.toString('ascii', 0, 4), 'RIFF', NATIVE_SOUNDS[index].file);
    assert.equal(file.toString('ascii', 8, 12), 'WAVE');
    assert.equal(file.readUInt16LE(22), 1, 'mono');
    assert.equal(file.readUInt16LE(34), 16, '16-bit');
    assert.equal(file.readUInt32LE(40), file.length - 44);
  }
  assert.equal(new Set(files.map((file) => file.toString('base64'))).size, 3);
  const ringtone = NATIVE_SOUNDS.find(({ file }) => file === 'incoming_call_ringtone.wav');
  assert.equal(files[2].readUInt32LE(40), Math.ceil(ringtone.tone.period * 44_100) * 2, 'one full ringtone period, looped by the notification');
  assert.deepEqual(renderTone(NATIVE_SOUNDS[0].tone), files[0], 'committed sounds match the generator');
});

test('the Android shell declares the channels, service, call receiver and runtime permissions', async () => {
  const manifest = await readFile(new URL('android/app/src/main/AndroidManifest.xml', root), 'utf8');
  for (const permission of ['POST_NOTIFICATIONS', 'RECORD_AUDIO', 'CAMERA', 'MODIFY_AUDIO_SETTINGS', 'FOREGROUND_SERVICE_SPECIAL_USE', 'USE_FULL_SCREEN_INTENT']) {
    assert.ok(manifest.includes(`android.permission.${permission}`), permission);
  }
  assert.match(manifest, /android:name="\.MessagingService"[\s\S]*foregroundServiceType="specialUse\|microphone\|camera\|phoneCall\|dataSync"/);
  for (const permission of ['FOREGROUND_SERVICE_MICROPHONE', 'FOREGROUND_SERVICE_CAMERA']) assert.ok(manifest.includes(`android.permission.${permission}`), permission);
  assert.match(manifest, /android:name="\.CallActionReceiver"\s+android:exported="false"/);
  const channels = await readFile(new URL('android/app/src/main/java/io/github/bickworld555/hiddenchat/NotificationChannels.java', root), 'utf8');
  for (const id of ['"direct_messages"', '"group_messages"', '"incoming_calls"']) assert.ok(channels.includes(id), id);
  const activity = await readFile(new URL('android/app/src/main/java/io/github/bickworld555/hiddenchat/MainActivity.java', root), 'utf8');
  assert.ok(activity.indexOf('registerPlugin(HiddenNativePlugin.class)') < activity.indexOf('super.onCreate'), 'plugin registered before the bridge starts');
});

test('native calls reach the real Capacitor plugin proxy (which answers `then`, so it must never be awaited)', async () => {
  const calls = [];
  globalThis.androidBridge = { postMessage() {} };
  globalThis.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    isPluginAvailable: (name) => name === 'HiddenNative',
    PluginHeaders: [{ name: 'HiddenNative', methods: [{ name: 'notify', rtype: 'promise' }, { name: 'getState', rtype: 'promise' }] }],
    nativePromise: (pluginName, method, options) => { calls.push(`${pluginName}.${method}`); return Promise.resolve(method === 'getState' ? { notificationsEnabled: true } : { shown: true, options }); },
  };
  assert.deepEqual(await nativeNotify({ channel: 'group_messages', title: 'Family', body: 'Hi' }), { shown: true, options: { channel: 'group_messages', title: 'Family', body: 'Hi' } });
  assert.deepEqual(await nativeState(), { notificationsEnabled: true });
  assert.equal(nativeAlertsActive({ visibilityState: 'hidden' }), true);
  assert.deepEqual(calls, ['HiddenNative.notify', 'HiddenNative.getState']);
});

test('without push (fallback), a swipe-away hands over to the service\'s own background-only connection', async () => {
  const read = (file) => readFile(new URL(`android/app/src/main/java/io/github/bickworld555/hiddenchat/${file}`, root), 'utf8');
  const service = await read('MessagingService.java');
  const relay = await read('NativeRelay.java');
  const activity = await read('MainActivity.java');
  assert.match(service, /public void onTaskRemoved[\s\S]*?if \(isLegacy\(this\)\) NativeRelay\.start\(this\);/, 'swiping away hands over to the native connection');
  assert.ok(service.includes('return legacy ? START_STICKY : START_NOT_STICKY;'), 'Android restarts the always-on service if it kills the process');
  assert.ok(relay.includes('relay.background'), 'the native connection never makes the user "online"');
  assert.ok(relay.includes('"message:delivered"'), 'it confirms delivery (two ticks)');
  assert.match(activity, /onCreate[\s\S]*NativeRelay\.stop\(\)/, 'the open app takes the connection back');
  const gradle = await readFile(new URL('android/app/build.gradle', root), 'utf8');
  assert.ok(gradle.includes('com.squareup.okhttp3:okhttp'));
});
