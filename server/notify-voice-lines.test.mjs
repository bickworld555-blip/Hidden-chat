// Multi-line messages, view once voice playback, and WhatsApp-style Android notifications (photo, stacked lines,
// Reply / Mark as read / Mute, missed calls with Call back / Message).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const source = (path) => readFile(new URL(path, root), 'utf8');
const java = (name) => source(`android/app/src/main/java/io/github/bickworld555/hiddenchat/${name}`);

test('lines typed with Enter stay on their own lines in chat bubbles', async () => {
  const css = await source('src/styles.css');
  assert.match(css, /\.text-with-meta > p, \.groups-message-text \{ white-space: pre-wrap; \}/);
});

test('a view once voice note that was claimed but not heard is kept for a retry, not lost', async () => {
  const rich = await source('src/components/RichMessages.jsx');
  assert.ok(rich.includes('const heldOnce = new Map()'), 'claimed audio is held in memory until it plays through');
  assert.match(rich, /audio\.play\(\)\.then\([\s\S]*?\.catch\(\(\) => \{ setState\('ready'\)/, 'a refused play() leaves it ready for one more tap');
  assert.match(rich, /onended = \(\) => \{[\s\S]*?releaseHeld\(messageId\)/, 'released once it has played to the end');
});

test('Android message notifications show the photo, the latest lines and Reply / Mark as read / Mute', async () => {
  const alerts = await java('Alerts.java');
  assert.ok(alerts.includes('new NotificationCompat.MessagingStyle('), 'conversation style with stacked lines');
  assert.ok(alerts.includes('builder.setLargeIcon(photo)'), "the sender's photo");
  for (const label of ['"Reply"', '"Mark as read"', '"Mute"']) assert.ok(alerts.includes(label), label);
  const receiver = await java('MessageActionReceiver.java');
  assert.ok(receiver.includes('RelaySession.mute(context, open)'), 'Mute is quiet at once, also with the app closed');
  const push = await java('PushService.java');
  assert.ok(push.includes('Avatars.pathFor(from)'));
});

test('a call that stops ringing unanswered becomes a missed-call notification with Call back and Message', async () => {
  const alerts = await java('Alerts.java');
  assert.ok(alerts.includes('"Missed voice call"') && alerts.includes('" missed calls"'));
  assert.ok(alerts.includes('"Call back"') && alerts.includes('"Message"'));
  const relay = await java('NativeRelay.java');
  assert.match(relay, /"answered-elsewhere"\.equals\(signal\.optString\("reason"\)\)\) Alerts\.cancelIncomingCall\(context\);\s*else Alerts\.missedCall\(context\);/,
    'answered on another device is not missed');
  const overlay = await source('src/components/CallOverlay.jsx');
  assert.ok(overlay.includes("snapshot.endReason !== 'answered-elsewhere'") && overlay.includes('nativeCancelIncomingCall({ missed: missedByPeer })'));
  const app = await source('src/App.jsx');
  assert.ok(app.includes("onNative('callBack'"), 'Call back places the call');
});
