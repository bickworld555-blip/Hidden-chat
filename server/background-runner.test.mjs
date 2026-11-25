// The background page (src/background/main.js, android BackgroundHost.java): its inbox, the end-to-end lock, and
// that its key opening and bridge never touch the app's encrypted records or database.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { importInbox, inboxKey } from '../src/backgroundInbox.js';
import { holdE2eLock } from '../src/e2eLock.js';

test('inbox keys sort in arrival order', () => {
  const keys = [inboxKey('m1', 1000), inboxKey('m2', 1000), inboxKey('m3', 999)];
  assert.deepEqual([...keys].sort(), [keys[2], keys[0], keys[1]]);
});

test('importing the inbox: all handled, saved to disk, only then removed; unreadable dropped, a failed one kept', async () => {
  const rows = new Map([['2-b', 'broken'], ['1-a', 'good-1'], ['3-c', 'fails'], ['4-d', 'good-2']]);
  const order = [];
  const imported = await importInbox({
    target: 'inbox',
    read: async () => [...rows.entries()],
    remove: async (key) => { order.push(`remove ${key}`); rows.delete(key); },
    open: async (sealed) => { if (sealed === 'broken') throw new Error('Keystore key changed'); return JSON.stringify({ id: sealed }); },
    handle: async (event) => { if (event.id === 'fails') throw new Error('handler failed'); order.push(`handle ${event.id}`); },
    commit: async () => { order.push('commit'); },
  });
  assert.equal(imported, 2);
  assert.deepEqual(order, ['handle good-1', 'remove 2-b', 'handle good-2', 'commit', 'remove 1-a', 'remove 4-d'],
    'in arrival order; the unreadable one dropped at once; the imported ones removed only after commit');
  assert.deepEqual([...rows.keys()], ['3-c'], 'the one whose handler failed stays for the next start');

  // Saving failed: nothing is removed (imported again next time; the store merges by id).
  const again = new Map([['1-a', 'good-1']]);
  await assert.rejects(importInbox({
    target: 'inbox', read: async () => [...again.entries()], remove: async (key) => again.delete(key),
    open: async (sealed) => JSON.stringify({ id: sealed }), handle: async () => {}, commit: async () => { throw new Error('disk full'); },
  }));
  assert.deepEqual([...again.keys()], ['1-a']);
});

// A fake Web Locks manager: one holder at a time, queued requests, ifAvailable.
function fakeLocks() {
  let holder = null;
  const queue = [];
  const grant = () => {
    if (holder || !queue.length) return;
    holder = queue.shift();
    Promise.resolve(holder.run()).finally(() => { holder = null; grant(); });
  };
  return {
    request(name, optionsOrCallback, maybeCallback) {
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
      const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
      if (options.ifAvailable && holder) return Promise.resolve(callback(null));
      return new Promise((resolve) => {
        queue.push({ run: async () => { const result = await callback({ name }); resolve(result); return result; } });
        grant();
      });
    },
  };
}

test('the app takes the end-to-end lock and keeps it; a page holding it makes the app wait; outside the phone app nothing', async () => {
  assert.equal(await holdE2eLock({ native: false, locks: fakeLocks() }), false, 'a browser does not use it');
  const locks = fakeLocks();
  let pageDone;
  // The background page holds the lock while it finishes a message.
  locks.request('hm-e2e', { ifAvailable: true }, () => new Promise((resolve) => { pageDone = resolve; }));
  let appHas = null;
  const app = holdE2eLock({ native: true, locks, timeoutMs: 5000 }).then((value) => { appHas = value; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(appHas, null, 'the app waits while the page works');
  pageDone();
  await app;
  assert.equal(appHas, true, 'then the app has it');
  // While the app holds it, a background page does not run.
  let page = 'not asked';
  await locks.request('hm-e2e', { ifAvailable: true }, (lock) => { page = lock ? 'ran' : 'skipped'; });
  assert.equal(page, 'skipped');
});

test('background key opening publishes nothing; the page writes the app database only as the database module does, and the records only through the outbox rule', () => {
  const client = readFileSync(new URL('../src/e2e/client.js', import.meta.url), 'utf8');
  const opener = client.slice(client.indexOf('export function openE2eForBackground'), client.indexOf('export function replayE2eEvent'));
  // Without the app's records the page keeps its own in memory; with them they come from backgroundSecureStorage (read only but the outbox).
  assert.ok(opener.includes('records: records ?? { get: async (key) => memory.get(key)'), 'records stay in the page memory unless given');
  assert.ok(!/publishKeys|syncDeviceList|setInterval/.test(opener), 'no key publishing, no device-list sync, no timers');
  const page = readFileSync(new URL('../src/background/main.js', import.meta.url), 'utf8');
  assert.ok(page.includes('useSecureStorageOverride('), 'secure records replaced by memory before anything runs');
  // The database only through src/sqliteMessageDb.js (one owner of the schema and statements), never the app store's saving.
  assert.ok(!/persistMessages|flushPersistedMessages|persistContacts/.test(page), 'never the app store saving');
  assert.ok(page.includes('useSecureStorageOverride(backgroundSecureStorage({ platform, tables: createRecordTables(openLocalDatabase), writable: (name) => name === outboxName }))'), 'records: read as written, only the outbox written');
  assert.match(page, /await keep\(\{ \.\.\.opened, opened: true \}\);[\s\S]*bridge\.notify[\s\S]*message:delivered/, 'kept before the notification and the receipt');
  assert.ok(page.includes('transportOptions: { ackAfterHandled: true }'), 'the server is told only about stored messages');
  assert.match(page, /navigator\.locks\.request\(E2E_LOCK, \{ ifAvailable: true \}/, 'runs only when the lock is free at once');
  const host = readFileSync(new URL('../android/app/src/main/java/io/github/bickworld555/hiddenchat/BackgroundHost.java', import.meta.url), 'utf8');
  assert.match(host, /static void start\(Context context\) \{\s*if \(AppActivity\.isAlive\(\) \|\| running \|\| HeadlessRunner\.isRunning\(\)\) return;/, 'never while the app has a screen');
  // The page itself runs in HeadlessRunner (hosted by BackgroundHost for a push, HeartbeatJob for the hourly check).
  const runner = readFileSync(new URL('../android/app/src/main/java/io/github/bickworld555/hiddenchat/HeadlessRunner.java', import.meta.url), 'utf8');
  assert.match(runner, /static boolean start\(Context context, Done done\) \{\s*if \(web != null \|\| AppActivity\.isAlive\(\)\) return false;/, 'one page at a time, never while the app has a screen');
  // The bridge runs only the statements the page sends (src/sqliteMessageDb.js), on a database the app created.
  const sql = readFileSync(new URL('../android/app/src/main/java/io/github/bickworld555/hiddenchat/BackgroundSql.java', import.meta.url), 'utf8');
  assert.ok(sql.includes('if (!sqlite.isDatabase(DB_NAME) || !sqlite.isSecretStored()) throw new Exception("no-database");'), 'only a database the app created');
  assert.ok(runner.includes('BackgroundSql.close();'), 'the connection goes with the page');
  // P3: the wake lock never blocks the next push; P4: the hourly check skips when a fetch was recent.
  const pushHandler = readFileSync(new URL('../android/app/src/main/java/io/github/bickworld555/hiddenchat/PushService.java', import.meta.url), 'utf8');
  // The wake-up (from Firebase, or P5's own connection) holds the CPU awake from its first line.
  assert.match(pushHandler, /static void handleXmppWake\(android\.content\.Context context, RelaySession session, JSONObject body\) \{[\s\S]{0,1500}FetchWake\.hold\(context, fetchWakeMs\);\s*FetchWake\.started\(\);/);
  assert.match(pushHandler, /long fetchWakeMs = tuned\(cfg, "w", FetchWake\.FETCH_WAKE_MS, 5_000, 170_000\);/, 'how long: from the server (PUSH_TUNING), within bounds');
  assert.ok(!/CountDownLatch|\.await\(/.test(pushHandler), 'the push handler never waits (a call push behind it would ring late)');
  assert.match(runner, /FetchWake\.finished\(appContext, "done"\.equals\(reason\)\);/, 'the page lets the CPU sleep once done');
  const job = readFileSync(new URL('../android/app/src/main/java/io/github/bickworld555/hiddenchat/HeartbeatJob.java', import.meta.url), 'utf8');
  assert.match(job, /if \(FetchWake\.fetchedWithin\(this, RECENT_MS\)\)/, 'no fetch when one completed recently');
  assert.match(job, /\.setRequiredNetworkType\(JobInfo\.NETWORK_TYPE_ANY\)[\s\S]*\.setPersisted\(true\)/, 'with a network, kept across restarts');
  // The incoming-call sync (MessagingService.startSync) was dataSync too, refused once Android 15's daily cap was
  // used; a refusal of every type crashed the service. Now a short service on Android 14+, and a refusal stops it.
  const messaging = readFileSync(new URL('../android/app/src/main/java/io/github/bickworld555/hiddenchat/MessagingService.java', import.meta.url), 'utf8');
  assert.match(messaging, /private int baseType\(\) \{[\s\S]*?UPSIDE_DOWN_CAKE \? ServiceInfo\.FOREGROUND_SERVICE_TYPE_SHORT_SERVICE : ServiceInfo\.FOREGROUND_SERVICE_TYPE_DATA_SYNC;/);
  assert.ok(!/if \(attempt == fallback\) throw/.test(messaging), 'never crashes when Android refuses every type');
  assert.match(messaging, /public void onTimeout\(int startId\)/, 'stops (or keeps a call going) when the short time is up');
  const manifest = readFileSync(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8');
  assert.match(manifest, /android:name="\.MessagingService"[\s\S]{0,300}?shortService/, 'declared as a possible short service');
  assert.ok(manifest.includes('android.permission.RECEIVE_BOOT_COMPLETED') && manifest.includes('android:name=".HeartbeatJob"'));
  const activity = readFileSync(new URL('../android/app/src/main/java/io/github/bickworld555/hiddenchat/AppActivity.java', import.meta.url), 'utf8');
  assert.match(activity, /public void onCreate\(Bundle savedInstanceState\) \{[\s\S]{0,400}BackgroundHost\.stopForApp\(\);/, 'the app screen stops the page first');
  // Found on the S23: the session went to Android without the device id, so the page always read "signed out".
  const native = readFileSync(new URL('../src/native.js', import.meta.url), 'utf8');
  assert.match(native, /invoke\('setSession', \{[^}]*deviceId, lockedChats/, 'the device id and locked chats reach Android');
  // Found on the S23: "dataSync" was refused (Android 15's daily cap, used up by the app's other services).
  assert.ok(host.includes('FOREGROUND_SERVICE_TYPE_SHORT_SERVICE'), 'a short service on Android 14+');
  // Found on the S23: with the app alive in the background, the dataSync sync was refused and the fetch froze.
  const push = readFileSync(new URL('../android/app/src/main/java/io/github/bickworld555/hiddenchat/PushService.java', import.meta.url), 'utf8');
  assert.ok(push.includes('if (!WakeKeeper.keep(context, backgroundFetchMs)) MessagingService.startSync(context, backgroundFetchMs);'), 'a short service keeps a living app awake');
  const keeper = readFileSync(new URL('../android/app/src/main/java/io/github/bickworld555/hiddenchat/WakeKeeper.java', import.meta.url), 'utf8');
  assert.ok(keeper.includes('FOREGROUND_SERVICE_TYPE_SHORT_SERVICE'));
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  // The inbox is imported only after the end-to-end lock is held — the native inbox on the native path, the WebView
  // page's inbox as the fallback, both inside the same guarded block.
  assert.match(app, /await e2eLockReady\(\);[\s\S]{0,700}importNativeInbox\(await nativeTakeInbox\(\), applyOpened\)/, 'the native inbox is imported only once it holds the lock');
  assert.match(app, /nativeE2eActive\(\)[\s\S]{0,400}importInbox\(/, 'otherwise the WebView page inbox, still under the lock');
  assert.match(app, /e2eLockReady\(\)\.then\(async \(\) => \{[\s\S]{0,700}startE2e\(\{ token: sessionToken, userId, deviceId, useNativeCore \}\)/, 'and starts its own encryption only then, native core when active');
});

test('one message, one notification: the sealed "🔒 Message" fallback never stacks under the real one', () => {
  const dir = '../android/app/src/main/java/io/github/bickworld555/hiddenchat/';
  const push = readFileSync(new URL(dir + 'PushService.java', import.meta.url), 'utf8');
  const alerts = readFileSync(new URL(dir + 'Alerts.java', import.meta.url), 'utf8');
  const fetch = readFileSync(new URL(dir + 'FetchWake.java', import.meta.url), 'utf8');
  // Skipped when the conversation was notified since the push, a fetch completed since, or the app is on screen.
  assert.match(push, /Alerts\.postedSince\(tag, pushedAt\) \|\| FetchWake\.completedSince\(pushedAt\) \|\| AppActivity\.isVisible\(\)/);
  assert.equal(push.match(/postDelayed\(/g).length, 2, 'both fallbacks (app alive, background page) share that check (and its re-check)');
  // A message already shown (over the connection, before its push) still counts as this conversation's notification.
  assert.ok(alerts.indexOf('postedAt.put(key') < alerts.indexOf('if (!firstNotice(messageId)) return true;'));
  assert.match(fetch, /static void markFetched\(Context context\) \{\s*completedAt = /);
  // The background page says "done" (a completed fetch) only when it reached the server's end, not at a time limit.
  const page = readFileSync(new URL('../src/background/main.js', import.meta.url), 'utf8');
  assert.match(page, /fetchReason === 'offline-done' \|\| fetchReason === 'quiet' \? 'done' : `incomplete/);
});

test('P6 and the local database: the background page reads the app records as written and writes only the outbox', async () => {
  const { backgroundSecureStorage, createSecureStorage } = await import('../src/secureStorage.js');
  const { createRecordTables, migrate } = await import('../src/sqliteMessageDb.js');
  const { pluginLikeConnection } = await import('./sqliteTestDb.mjs');
  const connection = pluginLikeConnection();
  await migrate(connection);
  const tables = createRecordTables(async () => connection);
  // A Keystore stand-in: what the app sealed, the page opens with the same key.
  const platform = { seal: async (text) => `sealed:${text}`, open: async (sealed) => sealed.slice('sealed:'.length) };
  // The app's records, written as the app writes them (already moved into the database).
  await tables.kvSet('meta:records-moved', true);
  const app = createSecureStorage({ platform, storage: { get: tables.kvGet, set: tables.kvSet, del: tables.kvDelete } });
  await app.set('relay:contacts:me', [{ id: 'ann', disappearSeconds: 86400 }]);
  await app.set('relay:outbox:me', [{ id: 'o1', receiverId: 'ann', content: 'hi' }]);

  const page = backgroundSecureStorage({ platform, tables, writable: (name) => name === 'relay:outbox:me' });
  assert.deepEqual(await page.get('relay:contacts:me'), [{ id: 'ann', disappearSeconds: 86400 }], 'reads the record the app wrote');
  // Anything else it writes stays in its memory: the app's contacts are untouched.
  await page.set('relay:contacts:me', []);
  assert.deepEqual(await page.get('relay:contacts:me'), []);
  assert.deepEqual(await app.get('relay:contacts:me'), [{ id: 'ann', disappearSeconds: 86400 }]);
  // The outbox it sent is written for real, so the app does not send it again.
  await page.set('relay:outbox:me', []);
  assert.deepEqual(await app.get('relay:outbox:me'), []);

  const source = readFileSync(new URL('../src/background/main.js', import.meta.url), 'utf8');
  // Sent only after the server has given everything that waited, and taken out of the outbox once the server has it.
  assert.match(source, /settle: \(\) => sendOutbox\(\)/);
  assert.match(source, /if \(!\(await session\.transport\.pingServer\(\{ timeoutMs: 5000 \}\)\)\) return;\s*const now = /);
  // Opened messages go into the app's database too, never over a copy, never from a blocked person.
  assert.match(source, /await keep\(\{ \.\.\.opened, opened: true \}\);\s*const saved = await saveToDatabase\(opened\)/);
  assert.match(source, /hiddenByBlock\(message, useChatStore\.getState\(\)\.blockedChats\?\.\[chat\], userId\)\) return false;\s*await local\.addIfMissing/);
  const job = readFileSync(new URL('../android/app/src/main/java/io/github/bickworld555/hiddenchat/UnsentMessagesJob.java', import.meta.url), 'utf8');
  assert.match(job, /setRequiredNetworkType\(JobInfo\.NETWORK_TYPE_ANY\)/);
  const manifest = readFileSync(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8');
  assert.match(manifest, /android:name="\.UnsentMessagesJob"[\s\S]{0,120}BIND_JOB_SERVICE/);
  const appSource = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(appSource, /nativeScheduleUnsent\(outbox\.some\(\(message\) => !message\?\.awaitingKeys\)\)/);
});

test('P7: Settings, Notifications says whether Android delivered pushes on time this week', async () => {
  const { pushDeliverySummary } = await import('../src/pushDiagnostics.js');
  assert.equal(pushDeliverySummary(null), null);
  assert.equal(pushDeliverySummary({ received: 0 }), null);
  assert.equal(pushDeliverySummary({ received: 12, demoted: 0 }).late, false);
  const late = pushDeliverySummary({ received: 12, demoted: 3, lastDemotedAt: Date.UTC(2026, 10, 16) });
  assert.equal(late.late, true);
  assert.match(late.text, /delayed 3 of 12 notifications/);
  assert.match(late.advice, /Unrestricted/);
  const stats = readFileSync(new URL('../android/app/src/main/java/io/github/bickworld555/hiddenchat/PushStats.java', import.meta.url), 'utf8');
  assert.match(stats, /original == RemoteMessage\.PRIORITY_HIGH && delivered != RemoteMessage\.PRIORITY_HIGH/);
  const push = readFileSync(new URL('../android/app/src/main/java/io/github/bickworld555/hiddenchat/PushService.java', import.meta.url), 'utf8');
  assert.match(push, /PushStats\.record\(this, message, type\);/);
});

// WhatsApp-style push handling (2026-11-20): each push id handled once over every path, no sealed notice while a fetch
// is still running, and the "Checking for new messages" short service gone as soon as the fetch ends.
test('push ids are handled once; the sealed notice waits for a running fetch; the short service ends with the fetch', () => {
  const dir = '../android/app/src/main/java/io/github/bickworld555/hiddenchat/';
  const read = (file) => readFileSync(new URL(dir + file, import.meta.url), 'utf8');
  const push = read('PushService.java');
  const dedup = read('PushDedup.java');
  const fetch = read('FetchWake.java');
  const keeper = read('WakeKeeper.java');
  assert.match(push, /if \(!"xwake"\.equals\(type\) && !PushDedup\.firstTime\(this, body\.optString\("pid"\)\)\)/, 'a repeated push is dropped');
  assert.match(push, /static void handleXmppWake\([^)]*\) \{\s*\/\/[^\n]*\n\s*if \(!PushDedup\.firstTime\(context, body\.optString\("pid"\)\)\)/, 'the Firebase and socket wake-ups share one check, first thing');
  assert.match(dedup, /if \(pid == null \|\| pid\.isEmpty\(\)\) return true;/, 'an older server (no ids): always handled');
  assert.match(dedup, /while \(order\.size\(\) > MAX\) seen\.remove\(order\.removeFirst\(\)\);/, 'bounded');
  assert.match(push, /if \(FetchWake\.inProgress\(\) && android\.os\.SystemClock\.elapsedRealtime\(\) - pushedAt \+ FALLBACK_RECHECK_MS <= maxMs\) \{\s*main\.postDelayed\(this, FALLBACK_RECHECK_MS\);/,
    'still fetching: checked again, up to the server-tuned maximum');
  assert.match(fetch, /static void finished\(Context context, boolean fetched\) \{[\s\S]*?endedAt = [\s\S]*?release\(\);\s*WakeKeeper\.release\(\);/);
  assert.match(keeper, /static void release\(\) \{[\s\S]*?running\.stop\(\);/);
  const plugin = read('HiddenNativePlugin.java');
  assert.ok(plugin.includes('FetchWake.finished(getContext(), "offline-done".equals(reason) || "quiet".equals(reason));'), 'the app\'s fetch ending stops it too');
});

test('the app takes its relay wake-up timings from the server, clamped, keeping defaults on bad input', async () => {
  const { applyPushTuning, pushTuning } = await import('../src/pushTuning.js');
  assert.deepEqual(pushTuning(), { relayWakeQuietMs: 2000, relayWakeMaxMs: 15000 });
  assert.deepEqual(applyPushTuning({ relayWakeQuietMs: 3000, relayWakeMaxMs: 10 ** 9, other: 1 }), { relayWakeQuietMs: 3000, relayWakeMaxMs: 120000 });
  assert.deepEqual(applyPushTuning({ relayWakeQuietMs: 'x' }), { relayWakeQuietMs: 3000, relayWakeMaxMs: 120000 }, 'not a number: unchanged');
  assert.deepEqual(applyPushTuning(null), { relayWakeQuietMs: 3000, relayWakeMaxMs: 120000 });
});
