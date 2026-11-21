// Speed fixes from the 2026-11-21 S23 benchmark against WhatsApp Business: each one pinned to its code path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const java = (name) => read(`android/app/src/main/java/io/github/bickworld555/hiddenchat/${name}.java`);

test('hang-up hands back to the previous app almost at once; a still-active call is waited for', () => {
  const activity = java('AppActivity');
  assert.match(activity, /HAND_BACK_MS = 200;/);
  assert.match(activity, /if \(MessagingService\.isCallActive\(\) \|\| Alerts\.isRinging\(\)\) \{/);
  assert.match(activity, /HAND_BACK_RETRY_MS = 250;[\s\S]{0,80}HAND_BACK_TRIES = 16;/, 'the same ~4 s allowance for a late "ended"');
  assert.match(activity, /COVER_MIN_MS = 120;/, 'the answer cover leaves as soon as the call screen is up');
});

test('a wake-up push shows the conversation notification at once; the real line replaces it quietly', () => {
  const push = java('PushService');
  assert.match(push, /announceArriving\(context, session, from, groupId\);\s+boolean running = HiddenNativePlugin\.emitXmppWake\(\);/, 'before the app is woken');
  const announce = push.slice(push.indexOf('static void announceArriving'));
  assert.match(announce, /if \(AppActivity\.isVisible\(\)\) return;/);
  assert.match(announce, /lockedChats\(context\)\.contains\(from\)/, 'locked chats never show a name');
  assert.match(announce, /mutedChats\.contains\(from\)/);
  assert.match(announce, /mutedGroups\.contains\(groupId\)/);
  assert.match(announce, /name\.isEmpty\(\)/, 'unknown senders wait for the app');
  const alerts = java('Alerts');
  assert.match(alerts, /if \(early != null\) \{[\s\S]{0,200}kept\.remove\(early\);\s+quiet = true;/);
  assert.match(alerts, /if \(quiet\) builder\.setOnlyAlertOnce\(true\);/, 'no second sound');
  const wake = java('FetchWake');
  assert.match(wake, /if \(fetched\) \{[\s\S]{0,600}Alerts\.settleArriving\(app\)/,'only a completed fetch takes unfilled lines away');
});

test('outgoing calls send the offer before the microphone / camera open', () => {
  const engine = read('src/callEngine.js');
  assert.match(engine, /function openSlots\(mode\) \{[\s\S]{0,200}addTransceiver\('audio', \{ direction: 'sendrecv', streams \}\)/);
  assert.match(engine, /async function fillSlots\(slots, captured\) \{[\s\S]{0,900}await sender\.replaceTrack\(track\);/);
  assert.match(engine, /set\(\{ localStream: stream \}\);\s+localTracksReady = true;/, 'later tracks join the offered stream');
});

test('cold start: the saved account opens at once, its data loads together, and the app code is preloaded', () => {
  const app = read('src/App.jsx');
  const restore = app.slice(app.indexOf('async function restoreSession()'));
  assert.ok(restore.indexOf('setSession(saved);') < restore.indexOf('validateAccount(account).then('), 'server check alongside, not in front');
  assert.match(restore, /if \(fresh === null\) \{ revokedRef\.current\?\.\(\); return; \}/, 'a refused token signs out');
  assert.match(app, /await Promise\.all\(\[hydrateContacts\(userId\), hydratePreferences\(userId\)\]\);\s+await Promise\.all\(\[hydrateMessages\(userId\), hydrateCallLogs\(userId\)\]\);/);
  assert.match(read('vite.config.js'), /rel="modulepreload" crossorigin href="\/\$\{file\}"/);
});

test('chats open with their last screenful first; list photos use a small copy', () => {
  const chat = read('src/components/ChatWindow.jsx');
  assert.match(chat, /const FIRST_PAINT = 30;/);
  assert.match(chat, /useState\(FIRST_PAINT\)/);
  assert.match(chat, /olderAnchorRef\.current = container\.scrollHeight - container\.scrollTop;\s+return RENDER_WINDOW;/, 'the view stays on the same messages');
  const avatar = read('src/avatar.js');
  assert.match(avatar, /AVATAR_THUMB_EDGE = 192;/);
  assert.match(read('src/components/Avatar.jsx'), /decoding="async"/);
  assert.match(read('src/styles.css'), /@media \(hover: hover\) \{ \.wa-row-wrapper:hover/);
});
