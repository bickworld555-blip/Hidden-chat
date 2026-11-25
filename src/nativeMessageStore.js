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
} from './native.js';

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
  return {
    /** Writes changed messages and removes deleted ones: puts = [{ chat, message }], deletes = [id], clearChats = [chat]. */
    async apply(owner, { puts = [], deletes = [], clearChats = [] } = {}) {
      if (!puts.length && !deletes.length && !clearChats.length) return;
      const rows = [];
      for (const { chat, message } of puts) {
        if (!message?.id) continue;
        rows.push({ chat, id: message.id, ts: timeOf(message), json: JSON.stringify(message) });
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

    // No native full-text search yet: callers fall back to null (no match) rather than a slow full scan. A later
    // increment can add an FTS index to NativeStore.full_messages if search on the native path is needed.
    close() {},
  };
}
