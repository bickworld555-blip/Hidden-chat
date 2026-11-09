// Full HD video calls, ringing calls over the lock screen, and the floating video window on every phone.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { VIDEO_MAX_BITRATE, VIDEO_MAX_FRAMERATE, mediaConstraints, videoConstraints } from '../src/rtc.js';
import { missingCallAccess } from '../src/callAccess.js';

const root = new URL('../', import.meta.url);
const source = (path) => readFile(new URL(path, root), 'utf8');
const java = (file) => source(`android/app/src/main/java/io/github/bickworld555/hiddenchat/${file}`);

test('video calls ask the camera for Full HD at 30 fps with a bitrate that can carry it', async () => {
  assert.deepEqual(videoConstraints('user'), {
    facingMode: 'user',
    width: { ideal: 1920, max: 1920 },
    height: { ideal: 1080, max: 1080 },
    frameRate: { ideal: 30, max: 30 },
  });
  assert.equal(mediaConstraints('video', 'environment').video.height.ideal, 1080);
  assert.equal(mediaConstraints('audio').video, false, 'voice calls never open the camera');
  assert.ok(VIDEO_MAX_BITRATE >= 3_000_000, `1080p30 needs a few Mbit/s, cap is ${VIDEO_MAX_BITRATE}`);
  assert.equal(VIDEO_MAX_FRAMERATE, 30);
  const engine = await source('src/callEngine.js');
  assert.ok(engine.includes("params.degradationPreference = 'balanced'"), 'congestion does not drop straight to a blurry resolution');
});

test('the app asks for the Android switches calls need, only when they are off', () => {
  assert.deepEqual(missingCallAccess(null), []);
  assert.deepEqual(missingCallAccess({ fullScreenCalls: true, pictureInPicture: true }), []);
  assert.deepEqual(missingCallAccess({ fullScreenCalls: false, pictureInPicture: true }), ['fullScreen']);
  assert.deepEqual(missingCallAccess({ fullScreenCalls: false, pictureInPicture: false }), ['fullScreen', 'pictureInPicture']);
  assert.deepEqual(missingCallAccess({ sdk: 30 }), [], 'older shells that do not report the switches are not nagged');
});

test('Android: ringing calls show over the lock screen at once and stay there while the call lasts', async () => {
  const activity = await java('MainActivity.java');
  assert.match(activity, /super\.onCreate\(savedInstanceState\);[\s\S]*getBooleanExtra\(Alerts\.EXTRA_CALL, false\)\) applyCallWindow\(true\)/, 'before the web app loads');
  assert.match(activity, /onNewIntent[\s\S]*applyCallWindow\(true\)/);
  assert.ok(activity.includes('setShowWhenLocked(overLock)') && activity.includes('setTurnScreenOn(overLock)'));
  assert.ok(activity.includes('FLAG_KEEP_SCREEN_ON'));
  assert.match(activity, /return Alerts\.isRinging\(\) \|\| MessagingService\.isCallActive\(\);/);
  const plugin = await java('HiddenNativePlugin.java');
  assert.match(plugin, /handleOnStop\(\) \{[\s\S]*?if \(!MainActivity\.wantsCallWindow\(\)\) setCallWindow\(false\);/, 'a call that opened the app behind the lock screen is not hidden again');
  assert.ok(plugin.includes('notifications.canUseFullScreenIntent()'), 'Android 14+ full-screen permission is checked');
  assert.ok(plugin.includes('Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT'));
  const alerts = await java('Alerts.java');
  assert.ok(alerts.includes('.setFullScreenIntent(showIntent, true)'));
  assert.match(alerts, /ringing = true;\s*\/\/[^\n]*\n\s*MainActivity\.callWindowChanged\(\);/);
});

test('Android: Home during a video call opens the floating window even where auto-enter is ignored', async () => {
  const activity = await java('MainActivity.java');
  assert.match(activity, /onUserLeaveHint\(\) \{[\s\S]*?isVideoCallActive\(\) && Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.O && !isInPictureInPictureMode\(\)[\s\S]*?enterPictureInPictureMode/);
  const plugin = await java('HiddenNativePlugin.java');
  assert.ok(plugin.includes('AppOpsManager.OPSTR_PICTURE_IN_PICTURE'), 'a phone that has picture-in-picture switched off is detected');
});
