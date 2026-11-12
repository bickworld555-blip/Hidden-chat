// Where src/secureStorage.js keeps its records (session, outbox, contacts, call log, account preferences, sealed
// data key). In the Android app: the encrypted SQLite database's kv table (src/sqliteMessageDb.js), so one encrypted
// database is the single source of truth. Each record stays sealed with the Keystore data key inside it.
//
// Moving from IndexedDB happens once and loses nothing: every record secureStorage owns is copied in one
// transaction, read back and compared, and only then removed from IndexedDB. A record secureStorage owns that is
// still in IndexedDB later (written before encryption) moves the first time it is read. What is not secureStorage's
// stays where it is: other modules' entries (custom ringtones) and the browser-only data key, a non-extractable
// CryptoKey that cannot be written out. If SQLite cannot be used, IndexedDB keeps serving, as before.

export const MOVED_MARKER = 'meta:records-moved';

const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/**
 * createRecordStorage({ tables, idb, owns(name, value), keepInIdb: [names] }) → { get, set, del, ready }.
 * `tables`: kvGet/kvSet/kvDelete/kvPutMany (src/sqliteMessageDb.js); `idb`: idb-keyval's get/set/del/delMany/entries.
 */
export function createRecordStorage({ tables, idb, owns, keepInIdb = [] }) {
  const pinned = new Set(keepInIdb);
  let state = null; // Promise<'sqlite' | 'idb'>

  async function moveOnce() {
    if ((await tables.kvGet(MOVED_MARKER)) === true) return;
    const entries = (await idb.entries()).filter(([name, value]) => typeof name === 'string' && !pinned.has(name) && owns(name, value));
    await tables.kvPutMany(entries);
    for (const [name, value] of entries) {
      if (!sameJson(await tables.kvGet(name), value)) throw new Error(`Record ${name} did not copy intact.`);
    }
    await tables.kvSet(MOVED_MARKER, true);
    // Copied and checked: the old copies go (a failure here only leaves duplicates that are never read again).
    await idb.delMany(entries.map(([name]) => name)).catch(() => {});
  }

  function backend() {
    state ??= moveOnce().then(() => 'sqlite', (error) => {
      console.error('Records stay in IndexedDB (SQLite unavailable):', error);
      return 'idb';
    });
    return state;
  }

  return {
    ready: backend,
    async get(name) {
      if (pinned.has(name) || (await backend()) === 'idb') return idb.get(name);
      const value = await tables.kvGet(name);
      if (value !== undefined) return value;
      // Written to IndexedDB before (or while) it moved, or before encryption (so the bulk move did not recognise it):
      // secureStorage is asking for it, so it is secureStorage's. It moves now.
      const left = await idb.get(name).catch(() => undefined);
      if (left === undefined) return undefined;
      await tables.kvSet(name, left);
      await idb.del(name).catch(() => {});
      return left;
    },
    async set(name, value) {
      if (pinned.has(name) || (await backend()) === 'idb') return idb.set(name, value);
      return tables.kvSet(name, value);
    },
    async del(name) {
      if (pinned.has(name) || (await backend()) === 'idb') return idb.del(name);
      await tables.kvDelete(name);
      await idb.del(name).catch(() => {});
    },
  };
}
