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

test('background key opening writes nothing to the encrypted records; the page and bridge never touch the app database', () => {
  const client = readFileSync(new URL('../src/e2e/client.js', import.meta.url), 'utf8');
  const opener = client.slice(client.indexOf('export function openE2eForBackground'), client.indexOf('export function replayE2eEvent'));
  assert.ok(opener.includes('records: { get: async (key) => memory.get(key)'), 'records stay in the page memory');
  assert.ok(!/publishKeys|syncDeviceList|setInterval/.test(opener), 'no key publishing, no device-list sync, no timers');
  const page = readFileSync(new URL('../src/background/main.js', import.meta.url), 'utf8');
  assert.ok(page.includes('useSecureStorageOverride('), 'secure records replaced by memory before anything runs');
  assert.ok(!/sqliteMessageDb|recordStore|persistMessages|messageDb/.test(page), 'no access to the app database');
  assert.match(page, /await keep\(\{ \.\.\.opened, opened: true \}\);[\s\S]*bridge\.notify[\s\S]*message:delivered/, 'kept before the notification and the receipt');
  assert.ok(page.includes('transportOptions: { ackAfterHandled: true }'), 'the server is told only about stored messages');
  assert.match(page, /navigator\.locks\.request\(E2E_LOCK, \{ ifAvailable: true \}/, 'runs only when the lock is free at once');
  const host = readFileSync(new URL('../android/app/src/main/java/io/github/bickworld555/hiddenchat/BackgroundHost.java', import.meta.url), 'utf8');
  assert.match(host, /static void start\(Context context\) \{\s*if \(AppActivity\.isAlive\(\) \|\| running\) return;/, 'never while the app has a screen');
  assert.ok(!/sqlite|SQLite|openDatabase/.test(host), 'the bridge has no database access');
  const activity = readFileSync(new URL('../android/app/src/main/java/io/github/bickworld555/hiddenchat/AppActivity.java', import.meta.url), 'utf8');
  assert.match(activity, /public void onCreate\(Bundle savedInstanceState\) \{[\s\S]{0,400}BackgroundHost\.stopForApp\(\);/, 'the app screen stops the page first');
  // Found on the S23: the session went to Android without the device id, so the page always read "signed out".
  const native = readFileSync(new URL('../src/native.js', import.meta.url), 'utf8');
  assert.match(native, /invoke\('setSession', \{[^}]*deviceId, lockedChats/, 'the device id and locked chats reach Android');
  // Found on the S23: "dataSync" was refused (Android 15's daily cap, used up by the app's other services).
  assert.ok(host.includes('FOREGROUND_SERVICE_TYPE_SHORT_SERVICE'), 'a short service on Android 14+');
  // Found on the S23: with the app alive in the background, the dataSync sync was refused and the fetch froze.
  const push = readFileSync(new URL('../android/app/src/main/java/io/github/bickworld555/hiddenchat/PushService.java', import.meta.url), 'utf8');
  assert.ok(push.includes('if (!WakeKeeper.keep(this, BACKGROUND_FETCH_MS)) MessagingService.startSync(this, BACKGROUND_FETCH_MS);'), 'a short service keeps a living app awake');
  const keeper = readFileSync(new URL('../android/app/src/main/java/io/github/bickworld555/hiddenchat/WakeKeeper.java', import.meta.url), 'utf8');
  assert.ok(keeper.includes('FOREGROUND_SERVICE_TYPE_SHORT_SERVICE'));
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /await e2eLockReady\(\);[\s\S]{0,200}importInbox\(/, 'the app imports the inbox only once it holds the lock');
  assert.match(app, /e2eLockReady\(\)\.then\(\(\) => \{\s*if \(live\) startE2e\(/, 'and starts its own encryption only then');
});
