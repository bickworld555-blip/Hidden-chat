// Checklist item 2 (authoritative store): a messageStore backend (same interface as src/messageDb.js and
// src/sqliteMessageDb.js) backed by the native Kotlin SQLCipher store (NativeStore.full_messages) through the
// HiddenNative plugin. The native store owns the message history; each message crosses the bridge as its full JSON
// (opaque to native, round-tripped), so no fidelity is lost and native stays decoupled from the message shape.
//
// Used only on the native shell and only when the native-UI flag is on, as the authoritative READ store and one half
// of the DUAL-WRITE (store.js writes both this and sqliteMessageDb during the transition, reads here, and falls back
// to sqlite if a native read fails). It is strictly additive and inert until wired behind that flag.
import {
  nativeApplyFullMessages,
  nativeCountFullMessages,
  nativeLoadFullAll,
  nativeLoadFullOlder,
  nativeLoadFullRecent,
  nativeReindexFullMessages,
  nativeSearchFullMessages,
} from './native.js';
// The same searchable-text extraction the sqlite FTS uses, so native and sqlite search match (ciphertext/structured
// payloads contribute only an attachment name). Native keeps `json` opaque, so JS supplies this text for the index.
import { searchableText } from './sqliteMessageDb.js';
import { deviceStorage } from './deviceStorage.js';

// Bumped if the searchable-text rule changes, forcing a one-time reindex of already-stored rows.
const SEARCH_INDEX_VERSION = 1;

// The ordering key, identical to messageDb.timeOf: epoch ms from `timestamp`, or 0 when it has none (e.g. a group
// message keyed by createdAt) — the same value the IndexedDB/SQLite stores index on, so paging matches.
function timeOf(message) {
  const value = Date.parse(message?.timestamp ?? '');
  return Number.isFinite(value) ? value : 0;
}

/** Parse a list of full-message JSON strings the bridge returned, dropping any that no longer parse. */
function parseList(list) {
  const out = [];
  for (const json of list ?? []) {
    try {
      const message = JSON.parse(json);
      if (message && typeof message === 'object') out.push(message);
    } catch {
      // A row that cannot be parsed is skipped rather than failing the whole load.
    }
  }
  // Oldest-first, like messageDb.openRows (the native store already orders by ts; this settles equal/zero ts).
  return out.sort((left, right) => String(left.timestamp).localeCompare(String(right.timestamp)));
}

/**
 * The native authoritative message store as a messageStore. `owner` (the account) is accepted for interface parity;
 * NativeStore is single-account (adoptOwner wipes on account change), so the open database is already this account's.
 */
export function createNativeMessageStore() {
  // The one-time index backfill for messages stored before the FTS index existed, per account (idempotent, marked in
  // deviceStorage). Going-forward writes already carry `text`, so this only has to run once after the upgrade.
  const indexed = new Map(); // owner -> Promise
  function ensureIndex(owner) {
    if (!indexed.has(owner)) {
      indexed.set(owner, (async () => {
        const marker = `native-search-indexed:${owner}:${SEARCH_INDEX_VERSION}`;
        try {
          if (deviceStorage.getItem(marker)) return;
          const all = await nativeLoadFullAll(); // { chats: { chatId: [jsonString…] } }
          const entries = [];
          for (const list of Object.values(all?.chats ?? {})) {
            for (const message of parseList(list)) if (message?.id) entries.push({ id: String(message.id), text: searchableText(message) || '' });
          }
          for (let start = 0; start < entries.length; start += 500) await nativeReindexFullMessages(entries.slice(start, start + 500));
          deviceStorage.setItem(marker, String(Date.now()));
        } catch (error) {
          indexed.delete(owner); // a failure retries next time rather than leaving search half-indexed
          throw error;
        }
      })());
    }
    return indexed.get(owner);
  }
  return {
    /** Writes changed messages and removes deleted ones: puts = [{ chat, message }], deletes = [id], clearChats = [chat]. */
    async apply(owner, { puts = [], deletes = [], clearChats = [] } = {}) {
      if (!puts.length && !deletes.length && !clearChats.length) return;
      const rows = [];
      for (const { chat, message } of puts) {
        if (!message?.id) continue;
        // `text` is the searchable words for the native FTS index ("" for ciphertext/structured payloads).
        rows.push({ chat, id: message.id, ts: timeOf(message), json: JSON.stringify(message), text: searchableText(message) || '' });
      }
      // Rejects on a native write failure, so store.js treats the batch as not-yet-saved (kept in memory, retried, not acked).
      await nativeApplyFullMessages({ puts: rows, deletes, clearChats });
    },

    /** The newest `limit` messages of every chat: { [chatId]: [message…] } oldest-first, and which chats have more. */
    async loadRecent(owner, limit) {
      const result = await nativeLoadFullRecent(limit);
      const messages = {};
      for (const [chat, list] of Object.entries(result?.messages ?? {})) messages[chat] = parseList(list);
      return { messages, more: new Set(Array.isArray(result?.more) ? result.more : []) };
    },

    /** Up to `limit` messages of one chat older than `beforeTs` (ms), oldest-first; `more` when even older exist. */
    async loadOlder(owner, chat, beforeTs, limit) {
      const result = await nativeLoadFullOlder(chat, beforeTs, limit);
      return { messages: parseList(result?.messages), more: Boolean(result?.more) };
    },

    /** Every saved message of this account, { [chatId]: [message…] } oldest-first (for a full backup). */
    async loadAll(owner) {
      const result = await nativeLoadFullAll();
      const out = {};
      for (const [chat, list] of Object.entries(result?.chats ?? {})) out[chat] = parseList(list);
      return out;
    },

    async count(owner) {
      return nativeCountFullMessages();
    },

    /** Full-text search over the native store, newest-first: [{ id, chat }] (the same shape sqlite search returns).
     *  Backfills the index once per account before the first search so pre-upgrade messages are found too. */
    async search(owner, query, limit = 200) {
      if (!String(query ?? '').trim()) return [];
      await ensureIndex(owner);
      return nativeSearchFullMessages(query, limit);
    },

    close() {},
  };
}
