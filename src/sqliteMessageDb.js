// The phone's local-first message store (Android app): native SQLite encrypted with SQLCipher through
// @capacitor-community/sqlite, the source of truth for chat history (the server keeps messages only until every
// device has them). Same interface as the IndexedDB store the web app keeps using (src/messageDb.js).
//
//   messages     one row per message: owner + chat + id, time (ts), status in place, the message as JSON
//                index (owner, chat, ts) → a chat opens from its newest page
//   messages_fts full-text index of readable text, for search without the network
//   media        attachments kept on the device: local_file_path, file_hash, decryption_key, server_blob_path
//   cache        other account data shown offline (src/groupCache.js: the group list and each group's details)
//
// The SQLCipher passphrase is random, made once, and kept by the plugin in Android's secure storage.
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';

const DB_NAME = 'hm-local';
const DB_VERSION = 1;
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS messages (
    owner TEXT NOT NULL, chat TEXT NOT NULL, id TEXT NOT NULL, ts INTEGER NOT NULL, status TEXT, body TEXT NOT NULL,
    PRIMARY KEY (owner, id)
  );
  CREATE INDEX IF NOT EXISTS messages_chat ON messages(owner, chat, ts);
  CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY, local_file_path TEXT NOT NULL, file_hash TEXT, decryption_key TEXT, server_blob_path TEXT,
    content_type TEXT, byte_size INTEGER, info TEXT, stored_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cache (
    owner TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (owner, key)
  );
`;

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

async function randomSecret() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Opens (once) the encrypted database. */
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
    await db.execute(SCHEMA);
    try {
      await db.execute('CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, owner UNINDEXED, id UNINDEXED)');
      ftsAvailable = true;
    } catch {
      ftsAvailable = false; // a build without FTS5: search falls back to scanning
    }
    return db;
  })();
  return connectionPromise;
}

export function createSqliteMessageDb() {
  const rowsToMessages = (values) => (values ?? []).map((row) => {
    try { return JSON.parse(row.body); } catch { return null; }
  }).filter(Boolean);

  return {
    async apply(owner, { puts = [], deletes = [], clearChats = [] } = {}) {
      if (!puts.length && !deletes.length && !clearChats.length) return;
      const db = await openLocalDatabase();
      const set = [];
      for (const chat of clearChats) {
        set.push({ statement: 'DELETE FROM messages WHERE owner = ? AND chat = ?', values: [owner, chat] });
        if (ftsAvailable) set.push({ statement: 'DELETE FROM messages_fts WHERE owner = ? AND id NOT IN (SELECT id FROM messages WHERE owner = ?)', values: [owner, owner] });
      }
      for (const id of deletes) {
        set.push({ statement: 'DELETE FROM messages WHERE owner = ? AND id = ?', values: [owner, id] });
        if (ftsAvailable) set.push({ statement: 'DELETE FROM messages_fts WHERE owner = ? AND id = ?', values: [owner, id] });
      }
      for (const { chat, message } of puts) {
        if (!message?.id) continue;
        set.push({
          statement: `INSERT INTO messages(owner, chat, id, ts, status, body) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(owner, id) DO UPDATE SET chat = excluded.chat, ts = excluded.ts, status = excluded.status, body = excluded.body`,
          values: [owner, chat, message.id, timeOf(message), message.status ?? null, JSON.stringify(message)],
        });
        if (ftsAvailable) {
          set.push({ statement: 'DELETE FROM messages_fts WHERE owner = ? AND id = ?', values: [owner, message.id] });
          const text = searchableText(message);
          if (text) set.push({ statement: 'INSERT INTO messages_fts(text, owner, id) VALUES (?, ?, ?)', values: [text, owner, message.id] });
        }
      }
      await db.executeSet(set, true);
    },

    async loadRecent(owner, limit) {
      const db = await openLocalDatabase();
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
      const db = await openLocalDatabase();
      const rows = (await db.query('SELECT body FROM messages WHERE owner = ? AND chat = ? AND ts < ? ORDER BY ts DESC LIMIT ?', [owner, chat, beforeTs, limit + 1])).values ?? [];
      return { messages: rowsToMessages(rows.slice(0, limit)).reverse(), more: rows.length > limit };
    },

    async loadAll(owner) {
      const db = await openLocalDatabase();
      const rows = (await db.query('SELECT chat, body FROM messages WHERE owner = ? ORDER BY chat, ts ASC', [owner])).values ?? [];
      const out = {};
      for (const row of rows) {
        try { (out[row.chat] ??= []).push(JSON.parse(row.body)); } catch { /* a damaged row is skipped */ }
      }
      return out;
    },

    async count(owner) {
      const db = await openLocalDatabase();
      return Number((await db.query('SELECT count(*) AS count FROM messages WHERE owner = ?', [owner])).values?.[0]?.count ?? 0);
    },

    /** Message ids matching `query`, newest first (full-text index; a plain scan where FTS5 is missing). */
    async search(owner, query, limit = 200) {
      const db = await openLocalDatabase();
      const words = String(query ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 8);
      if (!words.length) return [];
      if (ftsAvailable) {
        const match = words.map((word) => `"${word.replace(/"/g, '""')}"*`).join(' ');
        const rows = (await db.query(`SELECT m.id AS id, m.chat AS chat FROM messages_fts f JOIN messages m ON m.owner = f.owner AND m.id = f.id
          WHERE messages_fts MATCH ? AND f.owner = ? ORDER BY m.ts DESC LIMIT ?`, [match, owner, limit])).values ?? [];
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
  return { fts: ftsAvailable, mediaRecords: Number(row.count ?? 0), mediaBytes: Number(row.bytes ?? 0) };
}
