// The keyboard-open layout, the lock-screen call timer that kept counting after a call, notification text per
// kind of message, and typing that no longer re-renders every message in the chat.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { keyboardOpen, watchKeyboard } from '../src/keyboard.js';
import { notificationPreview } from '../src/store.js';
import { groupNotificationText } from '../src/notificationChannels.js';

const root = new URL('../', import.meta.url);
const source = (path) => readFile(new URL(path, root), 'utf8');
const java = (file) => source(`android/app/src/main/java/io/github/bickworld555/hiddenchat/${file}`);

test('notifications say what arrived: voice note with its length, video, audio, document, GIF, emoji', () => {
  assert.equal(notificationPreview('voice:abc:12'), '🎤 Voice message (0:12)');
  assert.equal(notificationPreview('voice:abc:75.4'), '🎤 Voice message (1:15)');
  assert.equal(notificationPreview('voice:abc:0'), '🎤 Voice message');
  assert.equal(notificationPreview('voice:abc:9:once'), '① Voice message');
  assert.equal(notificationPreview('media:m1:clip.mp4'), '🎥 Video');
  assert.equal(notificationPreview('media:m1:song.MP3'), '🎵 Audio');
  assert.equal(notificationPreview('media:m1:funny.gif'), '🎞️ GIF');
  assert.equal(notificationPreview('media:m1:photo.jpg'), '📷 Photo');
  assert.equal(notificationPreview('media:m1:Invoice 2026.pdf'), '📄 Invoice 2026.pdf');
  assert.equal(notificationPreview('call:{"mode":"video"}'), '📹 Video call');
  assert.equal(notificationPreview('😂❤️'), '😂❤️');
  assert.equal(notificationPreview('Hello'), 'Hello');
  assert.deepEqual(groupNotificationText({ groupName: 'Family', senderName: 'Ava', message: { content: 'voice:x:5' } }), { title: 'Family', body: 'Ava: 🎤 Voice message (0:05)' });
});

test('the background service words notifications the same way', async () => {
  const preview = await java('MessagePreview.java');
  assert.ok(preview.includes('"🎤 Voice message (%d:%02d)"'));
  assert.ok(preview.includes('case "gif": return "🎞️ GIF";') && preview.includes('return "🎵 Audio";') && preview.includes('return "🎥 Video";'));
  const app = await source('src/App.jsx');
  assert.ok(app.includes('body: notificationPreview(event.message.content),'));
  assert.ok(app.includes('Reacted ${event.emoji} to: “${notificationPreview(event.messageContent)}”'), 'reactions quote the message the same way');
});

test('keyboard open is a focused text box plus a clearly shorter visible area', () => {
  assert.equal(keyboardOpen({ focusedEditable: true, viewportHeight: 500, fullHeight: 900 }), true);
  assert.equal(keyboardOpen({ focusedEditable: false, viewportHeight: 500, fullHeight: 900 }), false, 'no box focused');
  assert.equal(keyboardOpen({ focusedEditable: true, viewportHeight: 880, fullHeight: 900 }), false, 'a small change (toolbar) is not a keyboard');

  const listeners = {};
  const classes = new Set();
  const scrolling = { scrollTop: 0 };
  const box = { tagName: 'TEXTAREA' };
  const win = {
    innerHeight: 900,
    visualViewport: { height: 900, addEventListener: (type, fn) => { listeners[`vv:${type}`] = fn; }, removeEventListener() {} },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    removeEventListener() {},
    setTimeout: (fn) => fn(),
    screen: { orientation: { type: 'portrait-primary' } },
    document: { body: {}, activeElement: null, scrollingElement: scrolling, documentElement: { classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) } } },
  };
  watchKeyboard(win);
  assert.equal(classes.has('keyboard-open'), false);
  win.document.activeElement = box;
  win.visualViewport.height = 520;
  win.innerHeight = 520;
  scrolling.scrollTop = 140; // Android panned the page to show the box
  listeners['vv:resize']();
  assert.equal(classes.has('keyboard-open'), true);
  assert.equal(scrolling.scrollTop, 0, 'the header is not pushed off the top');
  win.document.activeElement = win.document.body;
  win.visualViewport.height = 900;
  win.innerHeight = 900;
  listeners.focusout();
  assert.equal(classes.has('keyboard-open'), false);
});

test('with the keyboard up the composer sits right on it and the newest message stays in view', async () => {
  const css = await source('src/styles.css');
  assert.ok(css.includes('html.keyboard-open .app-shell.is-mobile .composer-wrap { padding-bottom: 6px; }'));
  const chat = await source('src/components/ChatWindow.jsx');
  assert.ok(chat.includes('if (justOpened || resized) pinToBottom();'), 'keyboard opening pins at once instead of gliding');
});

test('typing re-renders the composer only: the message list is memoised with stable handlers', async () => {
  const chat = await source('src/components/ChatWindow.jsx');
  const start = chat.indexOf('const messageList = useMemo');
  assert.ok(start > 0);
  const deps = /\}, \[([^\]]*)\]\);/.exec(chat.slice(start))[1].split(',').map((name) => name.trim());
  assert.ok(deps.includes('messages') && deps.includes('selectedIds') && !deps.includes('text'), 'the draft text is not a dependency');
  assert.ok(start < chat.indexOf('<h1>Select a conversation</h1>'), 'hooks come before the early return');
  assert.ok(chat.includes('{messageList}'));
});

test('a call that ended never leaves its timer on the lock screen', async () => {
  const service = await java('MessagingService.java');
  assert.match(service, /static void endOrphanedCall\(Context context, String why\) \{\s*if \(!callActive\) return;[\s\S]*?setCall\(context, false, false, null\);\s*CallAudio\.stop\(context\);/);
  assert.ok(service.includes('if (active || callActive) TelecomCalls.live(context, active, video, name);'), 'a stray "no call" does not drop a ringing call');
  const activity = await java('MainActivity.java');
  assert.ok(activity.includes('if (!isChangingConfigurations()) MessagingService.endOrphanedCall(this, "screen closed");'), 'app swiped away mid-call');
  const plugin = await java('HiddenNativePlugin.java');
  assert.match(plugin, /onPageStarted\(android\.webkit\.WebView webView\) \{\s*MessagingService\.endOrphanedCall\(getContext\(\), "page reloaded"\);/);
  const receiver = await java('CallActionReceiver.java');
  assert.match(receiver, /postDelayed\(\s*\(\) -> MessagingService\.endOrphanedCall\(app, "hang-up not confirmed"\), 2500\);/, 'Hang up on the notification always ends it');
  const app = await source('src/App.jsx');
  assert.match(app, /if \(!nativeShell\(\) \|\| call\) return undefined;\s*const sync = \(\) => \{ if \(document\.visibilityState === 'visible'\) nativeSetCallActive\(false\); \};/, 'opening the app with no call clears a stale one');
});

test('watchdogs: no Android call or call notification outlives the call in the app', async () => {
  const service = await java('MessagingService.java');
  assert.match(service, /if \(!MainActivity\.isAlive\(\)\) \{\s*endOrphanedCall\(context, "no screen holds the call"\);/, 'live call with no app screen ends');
  assert.ok(service.includes('else androidx.core.app.NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID);'), 'call notification cancelled even with no service running');
  const calls = await java('TelecomCalls.java');
  assert.ok(calls.includes('boolean backed = state == Connection.STATE_RINGING ? Alerts.isRinging() || MessagingService.isCallActive() : MessagingService.isCallActive();'));
  assert.ok(calls.includes('end(state == Connection.STATE_RINGING ? DisconnectCause.MISSED : DisconnectCause.LOCAL);'));
  assert.ok(calls.includes('main.postDelayed(check, CHECK_INTERVAL_MS);'), 'started for every new connection');
});

test('hard reset when a call ends: call notification deleted, Android call destroyed, heartbeat backstop', async () => {
  const service = await java('MessagingService.java');
  assert.ok(service.includes('private static final int CALL_NOTIFICATION_ID = 1002;'), 'the call notification has its own id');
  assert.ok(service.includes('if (!callActive) androidx.core.app.NotificationManagerCompat.from(this).cancel(CALL_NOTIFICATION_ID);'), 'deleted, not turned back into "Connected"');
  assert.match(service, /static void hardReset\(Context context, String why\) \{[\s\S]*?TelecomCalls\.endAll\(\);\s*CallAudio\.stop\(context\);\s*androidx\.core\.app\.NotificationManagerCompat\.from\(context\)\.cancel\(CALL_NOTIFICATION_ID\);/);
  assert.ok(service.includes('endOrphanedCall(context, "the app stopped confirming the call");'));
  const calls = await java('TelecomCalls.java');
  assert.match(calls, /static void endAll\(\) \{[\s\S]*?end\(DisconnectCause\.LOCAL\);/);
  assert.match(calls, /ending\.setDisconnected\(new DisconnectCause\(cause\)\);\s*ending\.destroy\(\);/);
  const overlay = await source('src/components/CallOverlay.jsx');
  assert.ok(overlay.includes('useEffect(() => { if (nativeShell() && terminal) nativeEndCall(); }, [terminal]);'), 'the moment the call ends');
  assert.ok(overlay.includes('useEffect(() => () => { if (nativeShell()) nativeEndCall(); }, []);'), 'and when the call screen closes');
  assert.ok(overlay.includes('const timer = setInterval(() => nativeCallHeartbeat(), CALL_HEARTBEAT_MS);'));
});

test('Telecom asking for the ringing screen opens it on a locked or dark phone', async () => {
  const connection = await java('CallConnectionService.java');
  assert.match(connection, /public void onShowIncomingCallUi\(\) \{[\s\S]*?TelecomCalls\.showCallScreen\(\);/);
  const alerts = await java('Alerts.java');
  assert.match(alerts, /static void showCallScreenIfAway\(Context context\) \{[\s\S]*?if \(!locked && !dark\) return;[\s\S]*?context\.startActivity\(new Intent\(show\)\);/);
  assert.match(alerts, /ringing = false;\s*ringingCallId = null;\s*lastCallScreen = null;/, 'never reopened after the call stopped ringing');
  assert.ok(alerts.includes('.setFullScreenIntent(showIntent, true)'), 'the full-screen notification stays the main route');
});
