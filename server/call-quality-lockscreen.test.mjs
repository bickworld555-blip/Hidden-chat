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

test('call switches that are off show as a quiet Calls-tab row, never a popup', async () => {
  assert.deepEqual(missingCallAccess(null), []);
  assert.deepEqual(missingCallAccess({ fullScreenCalls: true, pictureInPicture: true }), []);
  assert.deepEqual(missingCallAccess({ fullScreenCalls: false, pictureInPicture: true }), ['fullScreen']);
  assert.deepEqual(missingCallAccess({ fullScreenCalls: false, pictureInPicture: false }), ['fullScreen', 'pictureInPicture']);
  assert.deepEqual(missingCallAccess({ sdk: 30 }), [], 'older shells that do not report the switches are not nagged');
  assert.deepEqual(missingCallAccess({ fullScreenCalls: false, overlay: false, pictureInPicture: true }), ['fullScreen'], 'no "Display over other apps" prompt');
  const app = await source('src/App.jsx');
  assert.ok(!app.includes('CallAccessSheet'), 'no call-settings popup at startup');
  assert.ok((await source('src/components/CallsView.jsx')).includes('<CallAccessNotice />'));
});

test('Android asks only for what a feature uses, when it is used (WhatsApp-style)', async () => {
  const manifest = await source('android/app/src/main/AndroidManifest.xml');
  for (const unused of ['SEND_SMS', 'READ_CALL_LOG', 'READ_PHONE_STATE', 'READ_PHONE_NUMBERS', 'CALL_PHONE', 'ANSWER_PHONE_CALLS', 'GET_ACCOUNTS', 'READ_PROFILE', 'WRITE_CONTACTS', 'READ_MEDIA_IMAGES', 'READ_MEDIA_VIDEO', 'READ_MEDIA_AUDIO', 'NEARBY_WIFI_DEVICES']) {
    assert.ok(!manifest.includes(`android.permission.${unused}"`), `${unused} is not declared`);
  }
  const plugin = await source('android/app/src/main/java/io/github/bickworld555/hiddenchat/HiddenNativePlugin.java');
  const startup = plugin.slice(plugin.indexOf('void requestStartupPermissions'), plugin.indexOf('startupPermissionsDone(PluginCall'));
  assert.ok(startup.includes('requestPermissionForAlias("notifications"') && !startup.includes('requestPermissionForAliases'), 'first launch: the notification prompt only');
  assert.ok(!(await source('src/components/PermissionsSheet.jsx')).includes('nativeRequestStartupPermissions'), 'no custom permission list in the app');
});

test('Android: ringing calls show over the lock screen at once and stay there while the call lasts', async () => {
  const activity = await java('AppActivity.java');
  assert.match(activity, /super\.onCreate\(savedInstanceState\);[\s\S]*getBooleanExtra\(Alerts\.EXTRA_CALL, false\)\) applyCallWindow\(true\)/, 'before the web app loads');
  assert.match(activity, /onNewIntent[\s\S]*applyCallWindow\(true\)/);
  assert.ok(activity.includes('setShowWhenLocked(overLock)') && activity.includes('setTurnScreenOn(overLock)'));
  assert.ok(activity.includes('FLAG_KEEP_SCREEN_ON'));
  assert.match(activity, /return Alerts\.isRinging\(\) \|\| MessagingService\.isCallActive\(\);/);
  const plugin = await java('HiddenNativePlugin.java');
  assert.match(plugin, /handleOnStop\(\) \{[\s\S]*?if \(!AppActivity\.wantsCallWindow\(\)\) setCallWindow\(false\);/, 'a call that opened the app behind the lock screen is not hidden again');
  assert.ok(plugin.includes('notifications.canUseFullScreenIntent()'), 'Android 14+ full-screen permission is checked');
  assert.ok(plugin.includes('Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT'));
  const alerts = await java('Alerts.java');
  assert.ok(alerts.includes('.setFullScreenIntent(showIntent, true)'));
  assert.match(alerts, /ringing = true;\s*ringingCallId = id;\s*\/\/[^\n]*\n\s*TelecomCalls\.incoming\(context, id, name, video\);\s*AppActivity\.callRinging\(context\);\s*wakeScreen\(context\);\s*\/\/[^\n]*\n\s*AppActivity\.callWindowChanged\(\);/);
  // The full-screen call is native (no black screen while the web app loads) and the screen lights even where
  // full-screen notifications are switched off; both end when the call stops ringing.
  assert.ok(alerts.includes('Intent show = IncomingCallActivity.intent(context, id, name, video, avatar);'));
  assert.ok(!alerts.includes('canDrawOverlays'), 'no "Display over other apps" route');
  const permissions = await source('android/app/src/main/AndroidManifest.xml');
  assert.ok(!permissions.includes('SYSTEM_ALERT_WINDOW') && !permissions.includes('REQUEST_IGNORE_BATTERY_OPTIMIZATIONS'), 'only standard permissions, like WhatsApp');
  assert.ok((await java('IncomingCallActivity.java')).includes('connection.setRequestProperty("Authorization", "Bearer " + token);'), "the caller's photo is loaded");
  assert.match(alerts, /SCREEN_BRIGHT_WAKE_LOCK\s*\|\s*android\.os\.PowerManager\.ACQUIRE_CAUSES_WAKEUP/);
  assert.match(alerts, /ringing = false;\s*ringingCallId = null;\s*lastCallScreen = null;\s*releaseScreen\(\);\s*IncomingCallActivity\.dismiss\(\);/);
  const incoming = await java('IncomingCallActivity.java');
  assert.ok(incoming.includes('setShowWhenLocked(true);') && incoming.includes('setTurnScreenOn(true);') && incoming.includes('FLAG_KEEP_SCREEN_ON'));
  assert.ok(incoming.includes('.setAction(Alerts.ACTION_ACCEPT)'), 'Accept opens the app straight into the call');
  assert.ok(incoming.includes('.setAction(CallActionReceiver.ACTION_REJECT)'), 'Decline rejects without unlocking');
  const manifest = await source('android/app/src/main/AndroidManifest.xml');
  assert.match(manifest, /android:name="\.IncomingCallActivity"[\s\S]*?android:showWhenLocked="true"[\s\S]*?android:turnScreenOn="true"/);
});

test('Android: Home during a video call opens the floating window even where auto-enter is ignored', async () => {
  const activity = await java('AppActivity.java');
  assert.match(activity, /onUserLeaveHint\(\) \{[\s\S]*?enterCallPictureInPicture\(\);/);
  assert.match(activity, /boolean enterCallPictureInPicture\(\) \{\s*if \(!MessagingService\.isVideoCallActive\(\) \|\| Build\.VERSION\.SDK_INT < Build\.VERSION_CODES\.O\) return false;[\s\S]*?enterPictureInPictureMode\(pipParams\(this, false\)\)/);
  const plugin = await java('HiddenNativePlugin.java');
  assert.ok(plugin.includes('AppOpsManager.OPSTR_PICTURE_IN_PICTURE'), 'a phone that has picture-in-picture switched off is detected');
});
