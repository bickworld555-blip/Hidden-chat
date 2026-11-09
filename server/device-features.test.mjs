// Chat-list previews and unread counts, Media Save, Android Back, phone default sounds, and their native wiring.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chatPreview, unreadFrom } from '../src/store.js';
import { savableMedia } from '../src/mediaSave.js';
import { backStackDepthForTests, handleBack } from '../src/backStack.js';
import { phoneSoundSession, usesPhoneSound } from '../src/phoneSounds.js';
import { DEFAULT_SETTINGS } from '../src/notificationSettings.js';

const root = new URL('../', import.meta.url);
const message = (id, senderId, content, extra = {}) => ({ id, senderId, receiverId: senderId === 'me' ? 'ava' : 'me', timestamp: `2026-11-09T10:0${id}:00Z`, content, status: 'delivered', ...extra });

test('the chat list shows "📷 4 photos" for a run of photos from one person, like WhatsApp', () => {
  const photos = [1, 2, 3, 4].map((n) => message(n, 'ava', `media:p${n}:IMG_${n}.jpg`));
  assert.equal(chatPreview(photos), '📷 4 photos');
  assert.equal(chatPreview(photos.slice(0, 1)), '📷 Photo');
  assert.equal(chatPreview([...photos, message(5, 'me', 'media:p5:mine.jpg')]), '📷 Photo', 'a photo from the other person breaks the run');
  assert.equal(chatPreview([message(1, 'ava', 'media:v1:a.mp4'), message(2, 'ava', 'media:v2:b.mov')]), '🎥 2 videos');
  assert.equal(chatPreview([message(1, 'ava', 'media:p1:a.jpg'), message(2, 'ava', 'media:d1:report.pdf')]), '📄 report.pdf');
  assert.equal(chatPreview([message(1, 'ava', 'Hello')]), 'Hello');
  assert.equal(chatPreview([]), '');
});

test('unread counts come from the read state, so messages that arrived while the app was closed count', () => {
  const history = [
    message(1, 'ava', 'seen', { status: 'read' }),
    message(2, 'ava', 'new one'),
    message(3, 'ava', 'new two', { status: 'sent' }),
    message(4, 'me', 'my reply'),
    message(5, 'ava', 'call:{"mode":"audio"}'),
    message(6, 'ava', 'gone', { deleted: true }),
  ];
  assert.equal(unreadFrom(history, 'ava', 'me'), 2);
  assert.equal(unreadFrom([], 'ava', 'me'), 0);
});

test('Media Save saves photos, files and voice notes, but never view once audio', () => {
  assert.deepEqual(savableMedia('media:abc:holiday.jpg'), { id: 'abc', filename: 'holiday.jpg' });
  assert.deepEqual(savableMedia('voice:v1:12'), { id: 'v1', filename: '' });
  assert.equal(savableMedia('voice:v2:7:once'), null);
  assert.equal(savableMedia('voice-opened:7'), null);
  assert.equal(savableMedia('hello'), null);
});

test('Back closes the newest screen first and reports when nothing is left', () => {
  // The stack is driven by a React hook; here the module contract: empty means "go to the background".
  assert.equal(backStackDepthForTests(), 0);
  assert.equal(handleBack(), false);
});

test('"Default" means the phone\'s own sound only inside the Android app', () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  assert.equal(usesPhoneSound('message', settings, true), true);
  assert.equal(usesPhoneSound('incomingCall', settings, true), true);
  assert.equal(usesPhoneSound('message', settings, false), false, 'browsers keep the built-in default tone');
  settings.messages.tone = 'crystal-bells';
  assert.equal(usesPhoneSound('message', settings, true), false, 'a chosen tone stays the app tone');
  assert.equal(usesPhoneSound('sent', settings, true), false);
  assert.deepEqual(phoneSoundSession(settings), { phoneMessageSound: false, phoneGroupSound: true, phoneRingtone: true });
});

test('the Android app wires Back, picture-in-picture, earpiece calls, phone sounds, badges and Media Save', async () => {
  const read = (file) => readFile(new URL(`android/app/src/main/java/io/github/bickworld555/hiddenchat/${file}`, root), 'utf8');
  const manifest = await readFile(new URL('android/app/src/main/AndroidManifest.xml', root), 'utf8');
  assert.match(manifest, /android:name="\.MainActivity"[\s\S]*android:supportsPictureInPicture="true"/);
  assert.ok(manifest.includes('android.permission.WAKE_LOCK'));
  assert.match(manifest, /WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28"/, 'storage permission only for Android 9 and older');
  const activity = await read('MainActivity.java');
  assert.match(activity, /handleOnBackPressed\(\) \{\s*if \(!HiddenNativePlugin\.emitBack\(\)\) leaveApp\(\);/, 'Back never destroys the app');
  assert.match(activity, /void leaveApp\(\) \{\s*if \(!enterCallPictureInPicture\(\)\) moveTaskToBack\(true\);/, 'Back during a video call opens the floating window');
  assert.ok((await read('HiddenNativePlugin.java')).includes('activity.runOnUiThread(activity::leaveApp);'), "the web app's go-to-background does the same");
  assert.match(activity, /onUserLeaveHint\(\) \{[\s\S]*?enterCallPictureInPicture\(\);/);
  const audio = await read('CallAudio.java');
  assert.ok(audio.includes('speaker = isVideo'), 'voice calls start on the earpiece, video calls on the loudspeaker');
  assert.ok(audio.includes('PROXIMITY_SCREEN_OFF_WAKE_LOCK'));
  const channels = await read('NotificationChannels.java');
  assert.ok(channels.includes('Settings.System.DEFAULT_NOTIFICATION_URI') && channels.includes('Settings.System.DEFAULT_RINGTONE_URI'));
  const alerts = await read('Alerts.java');
  assert.ok(alerts.includes('builder.setNumber(unread)'), 'notifications carry the unread count for the icon badge');
  const saver = await read('MediaSaver.java');
  assert.ok(saver.includes('Environment.DIRECTORY_DOWNLOADS + "/" + ROOT + "/" + folder'));
  for (const folder of ['"Images"', '"Video"', '"Audio"', '"Documents"']) assert.ok(saver.includes(folder), folder);
});
