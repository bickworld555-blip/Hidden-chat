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

test('chats open with their last screenful first; loaded photos show at once', () => {
  const chat = read('src/components/ChatWindow.jsx');
  assert.match(chat, /const FIRST_PAINT = 30;/);
  assert.match(chat, /useState\(FIRST_PAINT\)/);
  assert.match(chat, /olderAnchorRef\.current = container\.scrollHeight - container\.scrollTop;\s+return RENDER_WINDOW;/, 'the view stays on the same messages');
  assert.match(read('src/avatar.js'), /const known = ready\.get\(key\);\s+if \(known\) \{ setResolved\(known\); return undefined; \}/, 'loaded photos show in the first frame');
  assert.match(read('src/components/Avatar.jsx'), /decoding="async"/);
  assert.match(read('src/styles.css'), /@media \(hover: hover\) \{ \.wa-row-wrapper:hover/);
});

test('the local database opens with a raw SQLCipher key: new phones from the start, older ones switched once, safely', () => {
  const key = java('DatabaseKey');
  assert.match(key, /return "x'" \+ hex \+ "'";/, 'the same 256 bits in raw form');
  assert.match(key, /if \(opens\(db, secret\)\) \{[\s\S]{0,300}copy\(db, backup\);[\s\S]{0,80}rekey\(db, secret, rawKey\);[\s\S]{0,300}if \(!opens\(db, rawKey\)\) \{\s+if \(!opens\(db, secret\)\) copy\(backup, db\);/, 'backed up, checked before the new key is stored, restored if neither key opens it');
  assert.match(key, /else if \(!opens\(db, rawKey\)\)/, 'an interrupted switch is finished next start');
  assert.ok(key.indexOf('rekey(db, secret, rawKey)') < key.indexOf('putString(SECRET, rawKey).commit()'), 'the secret changes only after the database');
  assert.match(java('BackgroundSql'), /DatabaseKey\.ensureRaw\(context\);\s+if \(!sqlite\.isDatabase/);
  assert.match(java('HiddenNativePlugin'), /public void prepareDatabase\(PluginCall call\) \{\s+DatabaseKey\.ensureRaw\(getContext\(\)\);/);
  const db = read('src/sqliteMessageDb.js');
  assert.match(db, /return `x'\$\{Array\.from\(bytes/);
  assert.match(db, /await prepareKey\(\);\s+const sqlite = new SQLiteConnection\(CapacitorSQLite\);\s+if \(!\(await sqlite\.isSecretStored\(\)\)/);
});

test('the answer cover can hang up before the web call screen is up', () => {
  const activity = java('AppActivity');
  assert.match(activity, /end\.setContentDescription\("End call"\);/);
  assert.match(activity, /CallActionReceiver\.endOnServer\(app, endCallId, "hang-up"\);\s+CallActionReceiver\.hangUp\(app\);/);
});

test('Android 14+ calls go through the transactional calling API (no post-call screen from the call-screening app)', () => {
  const telecom = java('TelecomCalls');
  assert.match(telecom, /@androidx\.annotation\.ChecksSdkIntAtLeast\(api = 34\)\s+static boolean transactional\(\) \{\s+return Build\.VERSION\.SDK_INT >= 34;/);
  for (const event of ['incoming', 'live', 'answered', 'rejected', 'ringingStopped', 'endAll']) {
    assert.ok(telecom.includes(`if (transactional()) { TransactionalCalls.${event}(`), `${event} is handed over`);
  }
  assert.match(telecom, /if \(transactional\(\)\) return TransactionalCalls\.route\(speaker\);/);
  assert.match(telecom, /if \(transactional\(\)\) return TransactionalCalls\.hasCall\(\);/);
  const calls = java('TransactionalCalls');
  assert.match(calls, /CAPABILITY_SELF_MANAGED \| PhoneAccount\.CAPABILITY_SUPPORTS_TRANSACTIONAL_OPERATIONS/);
  assert.match(calls, /telecom\.addCall\(attributes, executor\(\),/);
  assert.match(calls, /unregisterPhoneAccount\(TelecomCalls\.handle\(app\)\)/, 'one calling account');
  // Headset / car / watch keep working: answer, decline or hang up, mute.
  assert.match(calls, /public void onAnswer\(int videoState, @NonNull Consumer<Boolean> done\) \{[\s\S]{0,400}TelecomCalls\.answerInApp\(context, id\);/);
  assert.match(calls, /if \(wasRinging\) CallActionReceiver\.decline\(context, id\);\s+else CallActionReceiver\.hangUp\(context\);/);
  assert.match(calls, /public void onMuteStateChanged\(boolean muted\) \{[\s\S]{0,400}emitCallAction\("mute", id, extra\)/);
  // A call that ended while Android was still adding it is ended when it arrives.
  assert.match(calls, /if \(call != generation \|\| endWhenAdded\) \{\s+\/\/[^\n]*\n\s+added\.disconnect\(/);
  // No orphan left on the status bar.
  assert.match(calls, /dropping a call the app no longer has/);
});
