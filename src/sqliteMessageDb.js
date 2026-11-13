// The phone's local-first message store (Android app): native SQLite encrypted with SQLCipher through
// @capacitor-community/sqlite, the source of truth for chat history (the server keeps messages only until every
// device has them). Same interface as the IndexedDB store the web app keeps using (src/messageDb.js).
//
//   messages     one row per message: owner + chat + id, time (ts), status in place, the message as JSON
//                index (owner, chat, ts) → a chat opens from its newest page
//   messages_fts full-text index of readable text, for search without the network
//   media        attachments kept on the device: local_file_path, file_hash, decryption_key, server_blob_path
//   cache        other account data shown offline (src/groupCache.js: the group list and each group's details)
//   kv           this device's other records (src/secureStorage.js: session, outbox, contacts, call log, account
//                preferences), each still sealed with the app's Keystore data key inside the SQLCipher file
//   prefs        device settings the screens read synchronously (src/deviceStorage.js: theme, language, wallpaper…)
//
// The schema moves forward one numbered migration at a time (MIGRATIONS, recorded in PRAGMA user_version), each in
// its own transaction: an upgrade that fails leaves the database as it was, never half-changed.
//
// The SQLCipher passphrase is random, made once, and kept by the plugin in Android's secure storage.
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';

const DB_NAME = 'hm-local';
// The plugin's own version number; it runs nothing for it (no upgrade statements are registered with the plugin).
const DB_VERSION = 1;

/**
 * The schema's history. Append a step to change it; never edit or reorder a released one. Version 1 is the
 * original schema (IF NOT EXISTS, so phones that had it before versions were recorded simply record it); each later
 * step runs once, in order, in one transaction together with its version number.
 */
export const MIGRATIONS = Object.freeze([
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS messages (
        owner TEXT NOT NULL, chat TEXT NOT NULL, id TEXT NOT NULL, ts INTEGER NOT NULL, status TEXT, body TEXT NOT NULL,
        PRIMARY KEY (owner, id))`,
      'CREATE INDEX IF NOT EXISTS messages_chat ON messages(owner, chat, ts)',
      `CREATE TABLE IF NOT EXISTS media (
        id TEXT PRIMARY KEY, local_file_path TEXT NOT NULL, file_hash TEXT, decryption_key TEXT, server_blob_path TEXT,
        content_type TEXT, byte_size INTEGER, info TEXT, stored_at INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS cache (
        owner TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (owner, key))`,
    ],
  },
  {
    // The rest of this device's records move here from browser storage (IndexedDB and localStorage).
    version: 2,
    statements: [
      'CREATE TABLE IF NOT EXISTS kv (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)',
    ],
  },
  {
    // Long histories: newest-first scans over a whole account (search without the full-text index).
    version: 3,
    statements: ['CREATE INDEX IF NOT EXISTS messages_owner_ts ON messages(owner, ts)'],
  },
]);
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/**
 * Brings `db` (the plugin's connection: query(sql, values), execute(sql, transaction)) up to the newest version.
 * Returns { from, to }. A database written by a newer app (a downgrade) is left as it is: every step only adds.
 */
export async function migrate(db, migrations = MIGRATIONS) {
  const versionOf = async () => Number((await db.query('PRAGMA user_version', [])).values?.[0]?.user_version ?? 0);
  const from = await versionOf();
  const pending = migrations.filter((step) => step.version > from).sort((left, right) => left.version - right.version);
  for (const step of pending) {
    await db.execute(`${step.statements.join(';\n')};\nPRAGMA user_version = ${Number(step.version)};`, true);
    const now = await versionOf();
    if (now !== step.version) throw new Error(`Database upgrade to version ${step.version} did not complete (at ${now}).`);
  }
  return { from, to: Math.max(from, pending.at(-1)?.version ?? from) };
}

const timeOf = (message) => {
  const value = Date.parse(message?.timestamp ?? '');
  return Number.isFinite(value) ? value : Number(message?.createdAt) || 0;
};

/** Readable words of a message for the search index (structured payloads and ciphertext are left out). */
export function searchableText(message) {
  const content = message?.content;
  if (typeof content !== 'string' || !content || message.e2eError) return '';
  if (/^[a-z][a-z0-9-]*:/.test(content) && !/\s/.test(content.slice(0, content.indexOf(':')))) {
    // "voice:…", "media:…", "e2e2:…" and other structured messages: only an attachment's name is searchable.
    const name = /^e?media:[^:]+:(.*)$/.exec(content)?.[1];
    return name ? decodeURIComponent(name.split(':')[0] || '') : '';
  }
  return content.slice(0, 4000);
}

let connectionPromise = null;
let ftsAvailable = false;
let schemaState = null;

async function randomSecret() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Search index version 2 keys each row by its message's rowid. Older phones' index (keyed by owner and id) is rebuilt
 * once from the messages themselves, in batches; the marker in kv is written last, so an interrupted rebuild simply
 * runs again at the next start. Returns true when it rebuilt.
 */
export const SEARCH_INDEX_VERSION = 2;
export async function alignSearchIndex(db, { batch = 1000 } = {}) {
  const marker = (await db.query("SELECT value FROM kv WHERE name = 'meta:search-index'", [])).values?.[0]?.value;
  if (marker === JSON.stringify(SEARCH_INDEX_VERSION)) return false;
  await db.execute('DELETE FROM messages_fts;', true);
  let last = -1;
  for (;;) {
    const rows = (await db.query('SELECT rowid AS rid, owner, id, body FROM messages WHERE rowid > ? ORDER BY rowid LIMIT ?', [last, batch])).values ?? [];
    if (!rows.length) break;
    const set = [];
    for (const row of rows) {
      last = Number(row.rid);
      let message = null;
      try { message = JSON.parse(row.body); } catch { continue; }
      const text = searchableText(message);
      if (text) set.push({ statement: 'INSERT INTO messages_fts(rowid, text, owner, id) VALUES (?, ?, ?, ?)', values: [last, text, row.owner, row.id] });
    }
    if (set.length) await db.executeSet(set, true);
  }
  await db.run(`INSERT INTO kv(name, value, updated_at) VALUES ('meta:search-index', ?, ?)
    ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, [JSON.stringify(SEARCH_INDEX_VERSION), Date.now()]);
  return true;
}

/** Opens (once) the encrypted database and brings its schema up to date; a failed attempt can be retried. */
export function openLocalDatabase() {
  connectionPromise ??= (async () => {
    const sqlite = new SQLiteConnection(CapacitorSQLite);
    if (!(await sqlite.isSecretStored()).result) await sqlite.setEncryptionSecret(await randomSecret());
    const consistent = (await sqlite.checkConnectionsConsistency()).result;
    const existing = (await sqlite.isConnection(DB_NAME, false)).result;
    const db = consistent && existing
      ? await sqlite.retrieveConnection(DB_NAME, false)
      : await sqlite.createConnection(DB_NAME, true, 'secret', DB_VERSION, false);
    await db.open();
    schemaState = await migrate(db);
    try {
      await db.execute('CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, owner UNINDEXED, id UNINDEXED)');
      ftsAvailable = true;
    } catch {
      ftsAvailable = false; // a build without FTS5: search falls back to scanning
    }
    if (ftsAvailable) {
      await alignSearchIndex(db).catch((error) => {
        // Search scans the messages instead; the next start rebuilds the index again (its marker was not written).
        ftsAvailable = false;
        console.error('Search index rebuild failed:', error);
      });
    }
    return db;
  })();
  connectionPromise.catch(() => { connectionPromise = null; });
  return connectionPromise;
}

// `connect` and `fts` are for tests against another SQLite (the app uses its encrypted database and what it supports).
export function createSqliteMessageDb({ connect = openLocalDatabase, fts = () => ftsAvailable } = {}) {
  const rowsToMessages = (values) => (values ?? []).map((row) => {
    try { return JSON.parse(row.body); } catch { return null; }
  }).filter(Boolean);

  return {
    async apply(owner, { puts = [], deletes = [], clearChats = [] } = {}) {
      if (!puts.length && !deletes.length && !clearChats.length) return;
      const db = await connect();
      const set = [];
      // The search index row of a message shares its rowid (alignSearchIndex), so each change finds it directly; the
      // old lookup by owner and id scanned the whole index for every message (30 s to save 500 in 100,000).
      for (const chat of clearChats) {
        if (fts()) set.push({ statement: 'DELETE FROM messages_fts WHERE rowid IN (SELECT rowid FROM messages WHERE owner = ? AND chat = ?)', values: [owner, chat] });
        set.push({ statement: 'DELETE FROM messages WHERE owner = ? AND chat = ?', values: [owner, chat] });
      }
      for (const id of deletes) {
        if (fts()) set.push({ statement: 'DELETE FROM messages_fts WHERE rowid = (SELECT rowid FROM messages WHERE owner = ? AND id = ?)', values: [owner, id] });
        set.push({ statement: 'DELETE FROM messages WHERE owner = ? AND id = ?', values: [owner, id] });
      }
      for (const { chat, message } of puts) {
        if (!message?.id) continue;
        set.push({
          statement: `INSERT INTO messages(owner, chat, id, ts, status, body) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(owner, id) DO UPDATE SET chat = excluded.chat, ts = excluded.ts, status = excluded.status, body = excluded.body`,
          values: [owner, chat, message.id, timeOf(message), message.status ?? null, JSON.stringify(message)],
        });
        if (fts()) {
          set.push({ statement: 'DELETE FROM messages_fts WHERE rowid = (SELECT rowid FROM messages WHERE owner = ? AND id = ?)', values: [owner, message.id] });
          const text = searchableText(message);
          if (text) set.push({ statement: 'INSERT INTO messages_fts(rowid, text, owner, id) SELECT rowid, ?, owner, id FROM messages WHERE owner = ? AND id = ?', values: [text, owner, message.id] });
        }
      }
      await db.executeSet(set, true);
    },

    async loadRecent(owner, limit) {
      const db = await connect();
      const chats = (await db.query('SELECT DISTINCT chat FROM messages WHERE owner = ?', [owner])).values ?? [];
      const messages = {};
      const more = new Set();
      for (const { chat } of chats) {
        const rows = (await db.query('SELECT body FROM messages WHERE owner = ? AND chat = ? ORDER BY ts DESC LIMIT ?', [owner, chat, limit + 1])).values ?? [];
        if (rows.length > limit) more.add(chat);
        messages[chat] = rowsToMessages(rows.slice(0, limit)).reverse();
      }
      return { messages, more };
    },

    async loadOlder(owner, chat, beforeTs, limit) {
      const db = await connect();
      const rows = (await db.query('SELECT body FROM messages WHERE owner = ? AND chat = ? AND ts < ? ORDER BY ts DESC LIMIT ?', [owner, chat, beforeTs, limit + 1])).values ?? [];
      return { messages: rowsToMessages(rows.slice(0, limit)).reverse(), more: rows.length > limit };
    },

    async loadAll(owner) {
      const db = await connect();
      const rows = (await db.query('SELECT chat, body FROM messages WHERE owner = ? ORDER BY chat, ts ASC', [owner])).values ?? [];
      const out = {};
      for (const row of rows) {
        try { (out[row.chat] ??= []).push(JSON.parse(row.body)); } catch { /* a damaged row is skipped */ }
      }
      return out;
    },

    async count(owner) {
      const db = await connect();
      return Number((await db.query('SELECT count(*) AS count FROM messages WHERE owner = ?', [owner])).values?.[0]?.count ?? 0);
    },

    /** Message ids matching `query`, newest first (full-text index; a plain scan where FTS5 is missing). */
    async search(owner, query, limit = 200) {
      const db = await connect();
      const words = String(query ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 8);
      if (!words.length) return [];
      if (fts()) {
        const match = words.map((word) => `"${word.replace(/"/g, '""')}"*`).join(' ');
        const rows = (await db.query(`SELECT m.id AS id, m.chat AS chat FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
          WHERE messages_fts MATCH ? AND m.owner = ? ORDER BY m.ts DESC LIMIT ?`, [match, owner, limit])).values ?? [];
        return rows;
      }
      const like = `%${words.join(' ')}%`;
      return (await db.query('SELECT id, chat FROM messages WHERE owner = ? AND body LIKE ? ORDER BY ts DESC LIMIT ?', [owner, like, limit])).values ?? [];
    },

    close() {},
  };
}

// --- Attachments kept on the device: files in the app's private folder, references here. ---

export async function readMediaRef(id) {
  const db = await openLocalDatabase();
  const row = (await db.query('SELECT * FROM media WHERE id = ?', [id])).values?.[0];
  if (!row) return null;
  let info = null;
  try { info = row.info ? JSON.parse(row.info) : null; } catch { info = null; }
  return { ...row, info };
}

export async function writeMediaRef({ id, localFilePath, fileHash, decryptionKey = null, serverBlobPath, contentType, byteSize, info }) {
  const db = await openLocalDatabase();
  await db.run(`INSERT INTO media(id, local_file_path, file_hash, decryption_key, server_blob_path, content_type, byte_size, info, stored_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET local_file_path = excluded.local_file_path, file_hash = excluded.file_hash,
      decryption_key = COALESCE(excluded.decryption_key, media.decryption_key), server_blob_path = excluded.server_blob_path,
      content_type = excluded.content_type, byte_size = excluded.byte_size, info = COALESCE(excluded.info, media.info), stored_at = excluded.stored_at`,
  [id, localFilePath, fileHash ?? null, decryptionKey, serverBlobPath ?? null, contentType ?? null, byteSize ?? null, info ? JSON.stringify(info) : null, Date.now()]);
}

export async function updateMediaInfo(id, info) {
  const db = await openLocalDatabase();
  await db.run('UPDATE media SET info = ? WHERE id = ?', [JSON.stringify(info), id]);
}

/** Every attachment kept on this phone: id, size, type and when it was stored (Manage storage). */
export async function listMediaRefs() {
  const db = await openLocalDatabase();
  return (await db.query('SELECT id, byte_size, content_type, stored_at FROM media')).values ?? [];
}

export async function deleteMediaRef(id) {
  const db = await openLocalDatabase();
  await db.run('DELETE FROM media WHERE id = ?', [id]);
}

// --- Account data kept for offline display (JSON values by owner and key). ---

export async function readCached(owner, key) {
  const db = await openLocalDatabase();
  const row = (await db.query('SELECT value FROM cache WHERE owner = ? AND key = ?', [owner, key])).values?.[0];
  if (!row) return undefined;
  try { return JSON.parse(row.value); } catch { return undefined; }
}

export async function writeCached(owner, key, value) {
  const db = await openLocalDatabase();
  await db.run(`INSERT INTO cache(owner, key, value, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(owner, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, [owner, key, JSON.stringify(value), Date.now()]);
}

export async function deleteCached(owner, key) {
  const db = await openLocalDatabase();
  await db.run('DELETE FROM cache WHERE owner = ? AND key = ?', [owner, key]);
}

/** What this phone's store holds and can do, for Settings › Storage and data: search index and attachment records. */
export async function localStoreFacts() {
  const db = await openLocalDatabase();
  const row = (await db.query('SELECT count(*) AS count, COALESCE(sum(byte_size), 0) AS bytes FROM media')).values?.[0] ?? {};
  return { fts: ftsAvailable, mediaRecords: Number(row.count ?? 0), mediaBytes: Number(row.bytes ?? 0), schemaVersion: schemaState?.to ?? null };
}

// --- This device's records (src/secureStorage.js) and settings (src/deviceStorage.js), as JSON / text. ---

export function createRecordTables(connect) {
  const parse = (text) => { try { return JSON.parse(text); } catch { return undefined; } };
  const upsert = (table, keyColumn) => `INSERT INTO ${table}(${keyColumn}, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(${keyColumn}) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`;
  return {
    async kvGet(name) {
      const row = (await (await connect()).query('SELECT value FROM kv WHERE name = ?', [name])).values?.[0];
      return row ? parse(row.value) : undefined;
    },
    async kvSet(name, value) {
      await (await connect()).run(upsert('kv', 'name'), [name, JSON.stringify(value), Date.now()]);
    },
    async kvDelete(name) {
      await (await connect()).run('DELETE FROM kv WHERE name = ?', [name]);
    },
    /** Many records in one transaction: all of them or none. */
    async kvPutMany(entries) {
      if (!entries.length) return;
      const now = Date.now();
      await (await connect()).executeSet(entries.map(([name, value]) => ({ statement: upsert('kv', 'name'), values: [name, JSON.stringify(value), now] })), true);
    },
    async prefsAll() {
      return ((await (await connect()).query('SELECT key, value FROM prefs', [])).values ?? []).map((row) => [row.key, row.value]);
    },
    async prefsSet(key, value) {
      await (await connect()).run(upsert('prefs', 'key'), [key, String(value), Date.now()]);
    },
    async prefsDelete(key) {
      await (await connect()).run('DELETE FROM prefs WHERE key = ?', [key]);
    },
    async prefsPutMany(entries) {
      if (!entries.length) return;
      const now = Date.now();
      await (await connect()).executeSet(entries.map(([key, value]) => ({ statement: upsert('prefs', 'key'), values: [key, String(value), now] })), true);
    },
  };
}

export const records = createRecordTables(openLocalDatabase);
