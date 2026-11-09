// Sharing into Hidden Messenger from other apps, tappable links, the ongoing-call notification's Hang up, the video
// call self-view hand-over, and the voice note "played" colours.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { firstLink, splitLinks } from '../src/links.js';
import { parseShare, shareSteps, shareSummary } from '../src/shareTarget.js';

const root = new URL('../', import.meta.url);
const source = (path) => readFile(new URL(path, root), 'utf8');
const java = (file) => source(`android/app/src/main/java/io/github/bickworld555/hiddenchat/${file}`);

test('links in message text are found without swallowing the punctuation after them', () => {
  assert.deepEqual(splitLinks('Watch https://youtu.be/abc123. So good!'), [
    { text: 'Watch ' },
    { text: 'https://youtu.be/abc123', href: 'https://youtu.be/abc123' },
    { text: '. So good!' },
  ]);
  assert.deepEqual(splitLinks('www.facebook.com/reel/42'), [{ text: 'www.facebook.com/reel/42', href: 'https://www.facebook.com/reel/42' }]);
  assert.deepEqual(splitLinks('see (https://en.wikipedia.org/wiki/Go_(game))'), [
    { text: 'see (' },
    { text: 'https://en.wikipedia.org/wiki/Go_(game))', href: 'https://en.wikipedia.org/wiki/Go_(game))' },
  ]);
  assert.deepEqual(splitLinks('no links here'), [{ text: 'no links here' }]);
  assert.equal(splitLinks('a https://x.io b https://y.io').filter((part) => part.href).length, 2);
  assert.equal(firstLink('Reel by lyrics https://www.facebook.com/share/r/1Ab/'), 'https://www.facebook.com/share/r/1Ab/');
  assert.equal(splitLinks('javascript:alert(1)').some((part) => part.href), false, 'only web links become tappable');
});

test('a shared link, text or files become a share with a one-line summary', () => {
  assert.equal(parseShare(null), null);
  assert.equal(parseShare({ text: '  ', files: [] }), null, 'nothing to send');
  const reel = parseShare({ text: 'https://www.facebook.com/share/r/1Ab/', subject: '2M views · Reel by lyrics', files: [] });
  assert.equal(reel.text, '2M views · Reel by lyrics\nhttps://www.facebook.com/share/r/1Ab/', 'a bare link keeps the title the app gave it');
  assert.equal(shareSummary(parseShare({ text: 'https://youtu.be/abc', files: [] })), '🔗 youtu.be/abc');
  const withTitle = parseShare({ text: 'Look at this https://youtu.be/abc', subject: 'Look at this', files: [] });
  assert.equal(withTitle.text, 'Look at this https://youtu.be/abc', 'no repeated title');
  const photos = parseShare({ text: '', files: [0, 1, 2].map((index) => ({ index, name: `IMG_${index}.jpg`, mimeType: 'image/jpeg', size: 1000 })) });
  assert.equal(shareSummary(photos), '📷 3 photos');
  assert.equal(shareSummary(parseShare({ files: [{ index: 0, name: 'report.pdf', mimeType: 'application/pdf', size: 9 }] })), '📄 report.pdf');
  assert.equal(shareSummary(parseShare({ files: [{ index: 0, name: 'a.jpg', mimeType: 'image/jpeg' }, { index: 1, name: 'b.mp4', mimeType: 'video/mp4' }] })), '📄 2 files');
  const mixed = parseShare({ text: 'caption', files: [{ index: 0, name: 'clip.mp4', mimeType: 'video/mp4', size: 5 }, { index: -1 }] });
  assert.equal(mixed.files.length, 1, 'malformed file entries are dropped');
  assert.deepEqual(shareSteps(mixed).map((step) => step.kind), ['file', 'text'], 'files first, then the caption');
});

test('Android: share sheet entry, link opening, and Hang up on the ongoing-call notification', async () => {
  const manifest = await source('android/app/src/main/AndroidManifest.xml');
  assert.match(manifest, /android\.intent\.action\.SEND"[\s\S]*?android:mimeType="text\/plain"[\s\S]*?android:mimeType="image\/\*"/);
  assert.ok(manifest.includes('android.intent.action.SEND_MULTIPLE'));
  const plugin = await java('HiddenNativePlugin.java');
  assert.match(plugin, /SharedContent\.isShare\(intent\)[\s\S]*notifyListeners\("shareReceived"/, 'shared content reaches the web app, retained until it listens');
  assert.ok(plugin.includes('public void readSharedChunk') && plugin.includes('public void openExternal'));
  assert.match(plugin, /"http"\.equals\(scheme\) && !"https"\.equals\(scheme\)/, 'only web links are handed to other apps');
  const service = await java('MessagingService.java');
  assert.ok(service.includes('CallStyle.forOngoingCall(caller, hangUpIntent)'), 'WhatsApp-style ongoing call with Hang up');
  assert.ok(service.includes('setUsesChronometer(true)') && service.includes('"Ongoing video call"') && service.includes('"Ongoing voice call"'));
  const receiver = await java('CallActionReceiver.java');
  assert.match(receiver, /ACTION_HANGUP\.equals[\s\S]*emitCallAction\("hangup"/);
  const overlay = await source('src/components/CallOverlay.jsx');
  assert.ok(overlay.includes("action === 'hangup'"), 'the web app ends the WebRTC call on Hang up');
});

test('video calls start on your own camera and hand the full screen to the other person once they answer', async () => {
  const overlay = await source('src/components/CallOverlay.jsx');
  assert.match(overlay, /const remoteJoined = Boolean\(remoteStream\) && \(remoteVideoLive \|\| status === 'connected' \|\| status === 'reconnecting'\);/);
  assert.match(overlay, /const selfFull = swapped \|\| !remoteJoined;/);
  assert.ok(overlay.includes("wa-video-tile ${selfFull ? 'is-full' : 'is-pip'}"));
});

test('voice notes are green until played, then blue for both people', async () => {
  const voice = await source('src/components/VoiceMessage.jsx');
  assert.ok(voice.includes("played ? 'is-played' : 'is-unplayed'"));
  assert.ok(voice.includes('if (!played) onPlayed?.();'));
  const chat = await source('src/components/ChatWindow.jsx');
  assert.match(chat, /onPlayed=\{mine \? undefined : \(\) => \{\s*shared\.send\?\.\(\{ type: 'message:played'/, 'only the recipient reports playing');
  const css = await source('src/styles.css');
  assert.ok(css.includes('.voice-row.is-played .voice-badge, .voice-row.is-played .voice-thumb { background: #53bdeb; }'));
});
