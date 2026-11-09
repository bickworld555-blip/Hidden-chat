// Status wording and kinds, the WhatsApp-style "Send to…" sections, the lock-screen ringing loop fix, and
// reaction notifications from the background service.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { statusKind, statusTime } from '../src/statusApi.js';
import { shareSections } from '../src/shareTarget.js';

const root = new URL('../', import.meta.url);
const source = (path) => readFile(new URL(path, root), 'utf8');
const java = (file) => source(`android/app/src/main/java/io/github/bickworld555/hiddenchat/${file}`);

test('status times read like WhatsApp\'s and each status knows what it is', () => {
  const now = new Date(2026, 10, 9, 17, 30);
  assert.equal(statusTime(new Date(2026, 10, 9, 17, 29, 40).toISOString(), now), 'Just now');
  assert.equal(statusTime(new Date(2026, 10, 9, 17, 18).toISOString(), now), '12 minutes ago');
  assert.equal(statusTime(new Date(2026, 10, 9, 9, 5).toISOString(), now), 'Today, 9:05 am');
  assert.equal(statusTime(new Date(2026, 10, 8, 21, 40).toISOString(), now), 'Yesterday, 9:40 pm');
  assert.deepEqual(statusKind('Good morning'), { kind: 'text', text: 'Good morning' });
  assert.deepEqual(statusKind('media:abc:IMG_1.JPG'), { kind: 'image', mediaId: 'abc', filename: 'IMG_1.JPG' });
  assert.deepEqual(statusKind('media:v1:clip.mp4'), { kind: 'video', mediaId: 'v1', filename: 'clip.mp4' });
});

test('"Send to…" lists frequently contacted, recent chats, groups, then other contacts', () => {
  const chats = [
    { id: 'panna', name: 'Panna', lastActivityAt: '2026-11-09T17:00:00Z' },
    { id: 'farzana', username: 'farzana', lastActivityAt: '2026-11-09T11:00:00Z' },
    { id: 'rana', username: 'rana', lastActivityAt: null },
  ];
  const messages = { farzana: [1, 2, 3].map((n) => ({ id: `f${n}`, senderId: 'me', content: 'hi' })) };
  const groups = [{ id: 'dj', name: 'Dj' }];
  const sections = shareSections({ chats, groups, messages, userId: 'me' });
  assert.deepEqual(sections.map((section) => [section.title, section.items.map((item) => `${item.kind}:${item.id}`)]), [
    ['Frequently contacted', ['chat:farzana']],
    ['Recent chats', ['chat:panna']],
    ['Groups', ['group:dj']],
    ['Other contacts', ['chat:rana']],
  ]);
  assert.deepEqual(shareSections({ chats, groups, messages, userId: 'me', query: 'dj' }).map((section) => section.id), ['groups']);
});

test('Android: a ringing call stays over the lock screen while the app shows it (no flashing loop)', async () => {
  const alerts = await java('Alerts.java');
  assert.match(alerts, /static boolean isRinging\(\) \{\s*return ringing \|\| appRinging;/);
  const plugin = await java('HiddenNativePlugin.java');
  assert.ok(plugin.includes('Alerts.setAppRinging('));
  const overlay = await source('src/components/CallOverlay.jsx');
  assert.match(overlay, /if \(!nativeShell\(\) \|\| !ringingIncoming\) return undefined;\s*nativeSetCallRinging\(true\);\s*return \(\) => \{ nativeSetCallRinging\(false\); \};/);
  assert.ok(overlay.includes("onNative('pictureInPicture', () => { resume();"), 'paused call video restarts in the floating window');
});

test('Android: reactions to my messages notify even with the app closed', async () => {
  const relay = await java('NativeRelay.java');
  assert.match(relay, /"message:reaction"\.equals\(type\)[\s\S]*?session\.userId\.equals\(event\.optString\("messageSenderId"\)\)[\s\S]*?Alerts\.showMessage/);
  const app = await source('src/App.jsx');
  assert.ok(app.includes("event.messageSenderId === userId"));
});
