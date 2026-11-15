// Group messages waiting for end-to-end encryption (strict mode): when a member has no device with keys yet (an
// old app), nothing is sent readable. The message is kept on this device, shown as "Waiting", and sent sealed
// once every member has keys (the group screen retries while it is open). Stored per account and group.
//
// These are people's words before encryption, so they are kept in the encrypted store (src/secureStorage.js:
// AES-256-GCM, data key sealed by the Android Keystore), never in plain localStorage. Lists that older versions left
// in localStorage are moved once and removed. The screen reads a synchronous in-memory copy.
import { useSyncExternalStore } from 'react';
import { deviceStorage } from './deviceStorage.js';
import { secureDel, secureGet, secureSet } from './secureStorage.js';

const keyOf = (userId, groupId) => `hm:group-pending:${userId}:${groupId}`;
const validList = (value) => (Array.isArray(value) ? value.filter((entry) => entry && typeof entry.id === 'string' && typeof entry.content === 'string') : []);

/** The store behind the default export; `store` is { get, set, del } (async), `legacy` a localStorage-like object. */
export function createGroupPending({ store = { get: secureGet, set: secureSet, del: secureDel }, legacy = deviceStorage } = {}) {
  const listeners = new Set();
  const cache = new Map();
  const loading = new Map();
  const writes = new Map();
  const notify = () => { for (const listener of listeners) listener(); };

  function persist(key, list) {
    // One write at a time per list, in order, so an older list never lands after a newer one.
    const previous = writes.get(key) ?? Promise.resolve();
    const next = previous.then(() => (list.length ? store.set(key, list) : store.del(key))).catch(() => { /* kept in memory; retried on the next change */ });
    writes.set(key, next);
    return next;
  }

  function load(key) {
    if (!loading.has(key)) {
      loading.set(key, (async () => {
        let stored = validList(await store.get(key).catch(() => undefined));
        let old = null;
        try { old = legacy?.getItem(key) ?? null; } catch { /* private mode */ }
        if (old !== null) {
          let parsed = [];
          try { parsed = validList(JSON.parse(old)); } catch { /* unreadable: dropped */ }
          const known = new Set(stored.map((entry) => entry.id));
          stored = [...stored, ...parsed.filter((entry) => !known.has(entry.id))];
          await persist(key, stored);
          try { legacy.removeItem(key); } catch { /* private mode */ }
        }
        // Messages queued while the stored list was loading come after it.
        const queued = cache.get(key) ?? [];
        const ids = new Set(stored.map((entry) => entry.id));
        const merged = [...stored, ...queued.filter((entry) => !ids.has(entry.id))];
        cache.set(key, merged);
        if (queued.length) await persist(key, merged);
        notify();
      })());
    }
    return loading.get(key);
  }

  function pendingFor(userId, groupId) {
    const key = keyOf(userId, groupId);
    if (!cache.has(key)) { cache.set(key, []); load(key); }
    return cache.get(key);
  }

  function save(userId, groupId, list) {
    const key = keyOf(userId, groupId);
    cache.set(key, list);
    notify();
    return persist(key, list);
  }

  function enqueuePending(userId, groupId, content) {
    const entry = { id: `pending-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, content, createdAt: Date.now() };
    save(userId, groupId, [...pendingFor(userId, groupId), entry]);
    return entry;
  }

  const dropPending = (userId, groupId, id) => save(userId, groupId, pendingFor(userId, groupId).filter((entry) => entry.id !== id));

  /**
   * Tries to send every waiting message in order with `send(content)` (which seals it); stops at the first one that
   * still cannot be sealed. Resolves the number sent.
   */
  async function flushPending(userId, groupId, send) {
    pendingFor(userId, groupId);
    await load(keyOf(userId, groupId));
    let sent = 0;
    for (const entry of [...pendingFor(userId, groupId)]) {
      try {
        await send(entry.content);
      } catch (error) {
        if (error?.code === 'group-keys-missing') break;
        throw error;
      }
      dropPending(userId, groupId, entry.id);
      sent += 1;
    }
    return sent;
  }

  const subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
  const settled = (userId, groupId) => load(keyOf(userId, groupId)).then(() => writes.get(keyOf(userId, groupId)));
  return { pendingFor, enqueuePending, dropPending, flushPending, subscribe, settled };
}

const shared = createGroupPending();
export const { pendingFor, enqueuePending, dropPending, flushPending } = shared;
export const usePending = (userId, groupId) => useSyncExternalStore(shared.subscribe, () => pendingFor(userId, groupId), () => []);
