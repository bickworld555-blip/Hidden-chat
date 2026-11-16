// Calls as Android phone calls (self-managed Telecom ConnectionService): Android knows when a call rings, is live
// and ends, so headsets, cars and watches can answer, decline, mute and hang up, and SIM calls wait or hold.
import { callUiSource } from './callUiSource.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const source = (path) => readFile(new URL(path, root), 'utf8');
const java = (file) => source(`android/app/src/main/java/io/github/bickworld555/hiddenchat/${file}`);

test('the manifest declares a self-managed calling service and its permissions', async () => {
  const manifest = await source('android/app/src/main/AndroidManifest.xml');
  assert.match(manifest, /android:name="\.CallConnectionService"\s+android:permission="android\.permission\.BIND_TELECOM_CONNECTION_SERVICE"[\s\S]*?<action android:name="android\.telecom\.ConnectionService" \/>/);
  assert.ok(manifest.includes('android.permission.MANAGE_OWN_CALLS'));
  assert.ok(manifest.includes('android.permission.FOREGROUND_SERVICE_PHONE_CALL'));
  assert.ok(manifest.includes('android:foregroundServiceType="specialUse|microphone|camera|phoneCall|dataSync|shortService"'));
  const calls = await java('TelecomCalls.java');
  assert.ok(calls.includes('PhoneAccount.CAPABILITY_SELF_MANAGED'), 'self-managed: our own screens, no calling-account switch to turn on');
});

test('Android hears every step of a call', async () => {
  const alerts = await java('Alerts.java');
  assert.match(alerts, /ringing = true;[\s\S]*?TelecomCalls\.incoming\(context, id, name, video\);/, 'ringing');
  assert.match(alerts, /IncomingCallActivity\.dismiss\(\);[\s\S]*?TelecomCalls\.ringingStopped\(\);/, 'stopped ringing (missed)');
  const service = await java('MessagingService.java');
  assert.ok(service.includes('TelecomCalls.live(context, active, video, name);'), 'live / ended');
  const plugin = await java('HiddenNativePlugin.java');
  assert.match(plugin, /ACTION_ACCEPT\.equals\(intent\.getAction\(\)\)\) \{\s*TelecomCalls\.answered\(\);\s*cancelCallNotification/, 'answered on our screen before the ringing is withdrawn');
  const receiver = await java('CallActionReceiver.java');
  assert.match(receiver, /static void decline\(Context context, String callId\) \{\s*TelecomCalls\.rejected\(\);/);
});

test('what Android does reaches the call: answer, decline, hang up, mute', async () => {
  const connection = await java('CallConnectionService.java');
  assert.match(connection, /public void onAnswer\(\) \{\s*TelecomCalls\.answerFromSystem\(this\);/);
  assert.match(connection, /public void onReject\(\) \{\s*TelecomCalls\.declineFromSystem\(this\);/);
  assert.match(connection, /public void onDisconnect\(\) \{\s*if \(getState\(\) == STATE_RINGING\) TelecomCalls\.declineFromSystem\(this\);\s*else TelecomCalls\.hangUpFromSystem\(this\);/);
  const calls = await java('TelecomCalls.java');
  assert.ok(calls.includes('CallActionReceiver.decline(app, declined.callId);') && calls.includes('CallActionReceiver.hangUp(app);'));
  assert.ok(calls.includes('HiddenNativePlugin.emitCallAction("mute", muted.callId, extra);'));
  const overlay = await callUiSource();
  assert.ok(overlay.includes("else if (action === 'mute' && typeof mutedBySystem === 'boolean') callActionsRef.current?.setMuted(mutedBySystem);"));
});

test('call audio route goes through Telecom while it holds the call (no fight over speaker and earpiece)', () => {
  const dir = new URL('../android/app/src/main/java/io/github/bickworld555/hiddenchat/', import.meta.url);
  const audio = readFileSync(new URL('CallAudio.java', dir), 'utf8');
  const connection = readFileSync(new URL('CallConnectionService.java', dir), 'utf8');
  const telecom = readFileSync(new URL('TelecomCalls.java', dir), 'utf8');
  // Found on the S23: a video call kept going back to the earpiece (Telecom's route), so the other person could not be heard.
  assert.match(audio, /if \(TelecomCalls\.route\(speaker\)\) \{[\s\S]{0,200}return;\s*\}/, 'asked of Telecom first');
  assert.match(audio, /if \(!active \|\| device == null \|\| TelecomCalls\.hasCall\(\)\) return;/, 'never answers Telecom\'s own changes');
  assert.match(connection, /requestCallEndpointChange\(target,/, 'Android 14+: the call endpoint');
  assert.match(connection, /setAudioRoute\(route\)/, 'older Android: the audio route');
  assert.match(connection, /if \(speaker\) return loud != null \? loud : earpiece;/);
  assert.equal((telecom.match(/CallAudio\.telecomReady\(\);/g) ?? []).length, 2, 'routed again once Telecom has the call and when it goes active');
});
