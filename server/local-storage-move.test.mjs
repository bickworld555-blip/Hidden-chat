// Moving the Android app's remaining records (outbox, contacts, call log, preferences, session) and settings out of
// browser storage into its encrypted SQLite database: nothing lost, nothing half-moved, and a way back if SQLite
// cannot be used. Plus the rules for a full phone and for fetching big attachments ahead of time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createRecordTables, migrate } from '../src/sqliteMessageDb.js';
import { MOVED_MARKER, createRecordStorage } from '../src/recordStore.js';
import { deviceStorage, deviceStorageWritten, loadDeviceStorage } from '../src/deviceStorage.js';
import { classifyStorageError, reportStorageFailure, reportStorageWorking, storageProblem, storageProblemText } from '../src/storageHealth.js';
import { LARGE_DOWNLOAD_RESERVE_BYTES, largeDownloadPlan } from '../src/media.js';
import { isSecureRecord } from '../src/secureStorage.js';
import { pluginLikeConnection } from './sqliteTestDb.mjs';

async function freshTables() {
  const connection = pluginLikeConnection(new DatabaseSync(':memory:'));
  await migrate(connection);
  return { connection, tables: createRecordTables(async () => connection) };
}

function fakeIdb(initial) {
  const map = new Map(initial);
  return {
    map,
    get: async (name) => map.get(name),
    set: async (name, value) => { map.set(name, value); },
    del: async (name) => { map.delete(name); },
    delMany: async (names) => { for (const name of names) map.delete(name); },
    entries: async () => [...map.entries()],
  };
}

const sealed = (data) => ({ hmSecure: 1, iv: 'aXY=', data });
const owns = (name, value) => isSecureRecord(value) || name === 'hm:data-key-sealed-v1';

test('records move once into SQLite: copied, checked, then removed from IndexedDB; others stay', async () => {
  const { tables } = await freshTables();
  const cryptoKey = { type: 'secret', extractable: false }; // stands for the non-extractable browser key
  const idb = fakeIdb([
    ['relay:outbox:me', sealed('b3V0Ym94')],
    ['relay:contacts:me', sealed('Y29udGFjdHM=')],
    ['relay:calls:me', sealed('Y2FsbHM=')],
    ['relay:pinned:me', sealed('cGlubmVk')],
    ['hm:data-key-sealed-v1', 'c2VhbGVkLWtleQ=='],
    ['hm:data-key-v1', cryptoKey],
    ['hm:custom-tones', [{ id: 't1', name: 'Bell' }]], // another module's entry (src/sounds.js)
  ]);
  const records = createRecordStorage({ tables, idb, owns, keepInIdb: ['hm:data-key-v1'] });
  assert.equal(await records.ready(), 'sqlite');
  for (const name of ['relay:outbox:me', 'relay:contacts:me', 'relay:calls:me', 'relay:pinned:me', 'hm:data-key-sealed-v1']) {
    assert.ok(await tables.kvGet(name), `${name} is in SQLite`);
    assert.equal(idb.map.has(name), false, `${name} left IndexedDB`);
  }
  assert.deepEqual(await records.get('relay:contacts:me'), sealed('Y29udGFjdHM='));
  assert.equal(idb.map.get('hm:data-key-v1'), cryptoKey, 'the browser key stays (it cannot be written out)');
  assert.equal(await records.get('hm:data-key-v1'), cryptoKey);
  assert.deepEqual(idb.map.get('hm:custom-tones'), [{ id: 't1', name: 'Bell' }], "other modules' entries stay");
  assert.equal(await tables.kvGet(MOVED_MARKER), true);

  // Written from now on: SQLite only.
  await records.set('relay:outbox:me', sealed('bmV3'));
  assert.deepEqual(await tables.kvGet('relay:outbox:me'), sealed('bmV3'));
  assert.equal(idb.map.has('relay:outbox:me'), false);
  await records.del('relay:outbox:me');
  assert.equal(await records.get('relay:outbox:me'), undefined);
});

test('a record from before encryption still in IndexedDB moves the first time it is read', async () => {
  const { tables } = await freshTables();
  await tables.kvSet(MOVED_MARKER, true);
  const idb = fakeIdb([['relay:session', { token: 'plain-old' }]]);
  const records = createRecordStorage({ tables, idb, owns });
  assert.deepEqual(await records.get('relay:session'), { token: 'plain-old' });
  assert.deepEqual(await tables.kvGet('relay:session'), { token: 'plain-old' });
  assert.equal(idb.map.has('relay:session'), false);
});

test('if SQLite cannot be used, or a copy does not check out, IndexedDB keeps everything and keeps serving', async () => {
  const idb = fakeIdb([['relay:contacts:me', sealed('a2VwdA==')]]);
  const broken = { kvGet: async () => { throw new Error('SQLite unavailable'); }, kvSet: async () => {}, kvDelete: async () => {}, kvPutMany: async () => {} };
  const records = createRecordStorage({ tables: broken, idb, owns });
  assert.equal(await records.ready(), 'idb');
  assert.deepEqual(await records.get('relay:contacts:me'), sealed('a2VwdA=='));
  // A copy that reads back different is not trusted: nothing is removed.
  const { tables } = await freshTables();
  const lying = { ...tables, kvGet: async (name) => (name === MOVED_MARKER ? undefined : 'something else') };
  const idb2 = fakeIdb([['relay:calls:me', sealed('Y2FsbHM=')]]);
  assert.equal(await createRecordStorage({ tables: lying, idb: idb2, owns }).ready(), 'idb');
  assert.ok(idb2.map.has('relay:calls:me'));
});

function fakeLocalStorage(entries) {
  const map = new Map(entries);
  return {
    map,
    get length() { return map.size; },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

test('settings move from localStorage into SQLite once, the app\'s own keys only, and are then read from memory', async () => {
  const { tables } = await freshTables();
  const legacy = fakeLocalStorage([['relay:theme', 'dark'], ['hm:language', 'bn'], ['hm:settings', '{"version":1}'], ['livekit-device', 'mic-2']]);
  assert.equal(await loadDeviceStorage({ records: tables, legacy }), 'sqlite');
  assert.equal(deviceStorage.getItem('relay:theme'), 'dark');
  assert.equal(deviceStorage.getItem('hm:language'), 'bn');
  assert.equal(deviceStorage.getItem('livekit-device'), null, "a library's own key is not the app's");
  assert.deepEqual([...legacy.map.keys()], ['livekit-device'], 'only the moved keys left localStorage');
  deviceStorage.setItem('relay:theme', 'light');
  deviceStorage.removeItem('hm:language');
  assert.equal(deviceStorage.getItem('relay:theme'), 'light', 'read back at once, synchronously');
  await deviceStorageWritten();
  const stored = new Map(await tables.prefsAll());
  assert.equal(stored.get('relay:theme'), 'light');
  assert.equal(stored.has('hm:language'), false);
  // The next start reads SQLite; localStorage is not consulted again.
  legacy.setItem('relay:theme', 'stale');
  await loadDeviceStorage({ records: tables, legacy });
  assert.equal(deviceStorage.getItem('relay:theme'), 'light');
});

test('a settings copy that does not check out leaves localStorage as it was, and the app keeps using it', async () => {
  const { tables } = await freshTables();
  const lying = { ...tables, prefsAll: async () => [] };
  const legacy = fakeLocalStorage([['relay:theme', 'dark']]);
  const previous = globalThis.localStorage;
  globalThis.localStorage = legacy;
  try {
    assert.equal(await loadDeviceStorage({ records: lying, legacy }), 'localStorage');
    assert.equal(legacy.getItem('relay:theme'), 'dark', 'nothing removed');
    assert.equal(deviceStorage.getItem('relay:theme'), 'dark', 'served from localStorage');
  } finally {
    globalThis.localStorage = previous;
  }
});

test('a full phone is told apart from other failures, and the warning goes once saving works', () => {
  assert.equal(classifyStorageError(new Error('database or disk is full (code 13 SQLITE_FULL)')), 'full');
  assert.equal(classifyStorageError(new Error('write failed: ENOSPC (No space left on device)')), 'full');
  assert.equal(classifyStorageError(Object.assign(new Error('x'), { name: 'QuotaExceededError' })), 'full');
  assert.equal(classifyStorageError(new Error('database is locked')), 'failing');
  reportStorageFailure(new Error('SQLITE_FULL'));
  assert.equal(storageProblem().kind, 'full');
  assert.match(storageProblemText(storageProblem()), /out of storage/);
  reportStorageWorking();
  assert.equal(storageProblem(), null);
});

test('big attachments are fetched ahead of time only on Wi-Fi with room to spare', () => {
  const size = 300 * 1024 * 1024;
  const roomy = { quota: 20 * 1024 ** 3, usage: 1024 ** 3 };
  assert.deepEqual(largeDownloadPlan({ size, connection: { type: 'wifi' }, estimate: roomy }), { ok: true, reason: 'ok' });
  assert.equal(largeDownloadPlan({ size, connection: { type: 'cellular' }, estimate: roomy }).reason, 'mobile-data');
  assert.equal(largeDownloadPlan({ size, connection: { type: 'wifi', saveData: true }, estimate: roomy }).reason, 'data-saver');
  assert.equal(largeDownloadPlan({ size, connection: { type: 'none' } }).reason, 'offline');
  const tight = { quota: size + LARGE_DOWNLOAD_RESERVE_BYTES - 1, usage: 0 };
  assert.equal(largeDownloadPlan({ size, connection: { type: 'wifi' }, estimate: tight }).reason, 'low-storage');
  assert.equal(largeDownloadPlan({ size, connection: { type: 'ethernet' }, estimate: null }).ok, true, 'no estimate: not blocked');
});
