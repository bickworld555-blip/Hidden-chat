// The device's message store: one IndexedDB row per message, indexed by account, chat and time, instead of one
// record holding the whole history ("relay:messages:<user>") that was re-encrypted and re-written on every change.
//
//   row = { key: "<owner>\u0001<id>", owner, chat, id, ts, data }   data = the message, sealed (src/secureStorage.js)
//
// Saving writes only the messages that changed and deletes only the ones removed (store.js keeps the last saved
// copy of each). Start-up loads the newest MESSAGE_WINDOW messages of each chat; older ones are read on demand
// when the conversation scrolls back (loadOlder), so memory no longer grows with the whole history.
export const DB_NAME = 'hm-messages';
export const DB_VERSION = 1;
export const MESSAGE_WINDOW = 500;
const STORE = 'messages';
const SEP = '\u0001';

const rowKey = (owner, id) => `${owner}${SEP}${id}`;
const sealName = (owner, id) => `msg:${owner}:${id}`;
const timeOf = (message) => {
  const value = Date.parse(message?.timestamp ?? '');
  return Number.isFinite(value) ? value : 0;
};

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('Transaction aborted.'));
  });
}

/**
 * createMessageDb({ indexedDB, seal(name, value), open(name, record) }) → the store's operations. `seal`/`open`
 * encrypt each message at rest (secureStorage); identity functions keep tests readable.
 */
export function createMessageDb({ indexedDB = globalThis.indexedDB, seal = async (_name, value) => value, open = async (_name, record) => record, name = DB_NAME } = {}) {
  let database = null;

  function connect() {
    if (!indexedDB) return Promise.reject(new Error('IndexedDB is not available.'));
    database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(name, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'key' });
          store.createIndex('chat', ['owner', 'chat', 'ts']);
          store.createIndex('owner', 'owner');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch((error) => {
      database = null;
      throw error;
    });
    return database;
  }

  async function sealRow(owner, chat, message) {
    return { key: rowKey(owner, message.id), owner, chat, id: message.id, ts: timeOf(message), data: await seal(sealName(owner, message.id), message) };
  }

  async function openRows(owner, rows) {
    const out = [];
    for (const row of rows) {
      const message = await open(sealName(owner, row.id), row.data);
      if (message && typeof message === 'object') out.push(message);
    }
    return out.sort((left, right) => String(left.timestamp).localeCompare(String(right.timestamp)));
  }

  return {
    /** Writes changed messages and removes deleted ones in one transaction: puts = [{ chat, message }], deletes = [id]. */
    async apply(owner, { puts = [], deletes = [], clearChats = [] } = {}) {
      if (!puts.length && !deletes.length && !clearChats.length) return;
      // Sealing is async, so it happens before the transaction (an IndexedDB transaction closes when idle).
      const rows = [];
      for (const { chat, message } of puts) if (message?.id) rows.push(await sealRow(owner, chat, message));
      const db = await connect();
      // Cleared chats go first, in their own transaction, so the messages kept from them are written afterwards.
      if (clearChats.length) {
        const clearing = db.transaction(STORE, 'readwrite');
        const store = clearing.objectStore(STORE);
        for (const chat of clearChats) {
          const range = IDBKeyRangeFor(indexedDB).bound([owner, chat, -Infinity], [owner, chat, Infinity]);
          const keysRequest = store.index('chat').getAllKeys(range);
          keysRequest.onsuccess = () => { for (const key of keysRequest.result) store.delete(key); };
        }
        await done(clearing);
      }
      const transaction = db.transaction(STORE, 'readwrite');
      const store = transaction.objectStore(STORE);
      for (const id of deletes) store.delete(rowKey(owner, id));
      for (const row of rows) store.put(row);
      await done(transaction);
    },

    /** The newest `limit` messages of every chat: { [chatId]: [message…] } oldest first, and which chats have more. */
    async loadRecent(owner, limit = MESSAGE_WINDOW) {
      const db = await connect();
      const transaction = db.transaction(STORE, 'readonly');
      const index = transaction.objectStore(STORE).index('chat');
      const range = IDBKeyRangeFor(indexedDB).bound([owner, '', -Infinity], [owner, '￿', Infinity]);
      const picked = new Map();
      const more = new Set();
      await new Promise((resolve, reject) => {
        const request = index.openCursor(range, 'prev');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return resolve();
          const row = cursor.value;
          const list = picked.get(row.chat) ?? [];
          if (list.length < limit) {
            list.push(row);
            picked.set(row.chat, list);
            cursor.continue();
          } else {
            // This chat is full: jump past its older rows to the next chat (keys are [owner, chat, ts]).
            more.add(row.chat);
            cursor.continue([owner, row.chat, -Infinity]);
          }
        };
      });
      const out = {};
      for (const [chat, rows] of picked) out[chat] = await openRows(owner, rows);
      return { messages: out, more };
    },

    /** Up to `limit` messages of one chat older than `beforeTs` (ms), oldest first; `more` when even older exist. */
    async loadOlder(owner, chat, beforeTs, limit = MESSAGE_WINDOW) {
      const db = await connect();
      const transaction = db.transaction(STORE, 'readonly');
      const index = transaction.objectStore(STORE).index('chat');
      const range = IDBKeyRangeFor(indexedDB).bound([owner, chat, -Infinity], [owner, chat, beforeTs], false, true);
      const rows = [];
      let more = false;
      await new Promise((resolve, reject) => {
        const request = index.openCursor(range, 'prev');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return resolve();
          if (rows.length >= limit) {
            more = true;
            return resolve();
          }
          rows.push(cursor.value);
          cursor.continue();
        };
      });
      return { messages: await openRows(owner, rows), more };
    },

    async count(owner) {
      const db = await connect();
      return promisify(db.transaction(STORE, 'readonly').objectStore(STORE).index('owner').count(owner));
    },

    close() {
      database?.then((db) => db.close()).catch(() => {});
      database = null;
    },
  };
}

// IDBKeyRange lives next to indexedDB (the global in browsers; the fake's export in tests).
function IDBKeyRangeFor(indexedDB) {
  return indexedDB?.IDBKeyRange ?? globalThis.IDBKeyRange;
}

/**
 * What changed between the last saved copy and the store now (by object identity: the store replaces a message
 * object whenever it changes). Chats that disappeared or were cleared are dropped whole, rows not loaded included.
 */
export function diffMessages(saved, current, cleared = new Set()) {
  const puts = [];
  const deletes = [];
  const clearChats = [];
  for (const chat of saved.keys()) if (!(chat in current)) clearChats.push(chat);
  for (const chat of cleared) if (!clearChats.includes(chat)) clearChats.push(chat);
  for (const [chat, list] of Object.entries(current)) {
    const before = saved.get(chat);
    const wiped = clearChats.includes(chat);
    const ids = new Set();
    for (const message of list ?? []) {
      if (!message?.id) continue;
      ids.add(message.id);
      if (wiped || before?.get(message.id) !== message) puts.push({ chat, message });
    }
    if (before && !wiped) for (const id of before.keys()) if (!ids.has(id)) deletes.push(id);
  }
  return { puts, deletes, clearChats };
}

/** The saved copy after a successful write: chat → (id → message object). */
export function snapshotOf(current) {
  return new Map(Object.entries(current).map(([chat, list]) => [chat, new Map((list ?? []).filter((message) => message?.id).map((message) => [message.id, message]))]));
}
