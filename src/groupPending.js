// Group messages waiting for end-to-end encryption (strict mode): when a member has no device with keys yet (an
// old app), nothing is sent readable. The message is kept on this device, shown as "Waiting", and sent sealed
// once every member has keys (the group screen retries while it is open). Stored per account and group.
import { useSyncExternalStore } from 'react';

const listeners = new Set();
const keyOf = (userId, groupId) => `hm:group-pending:${userId}:${groupId}`;
const cache = new Map();

export function pendingFor(userId, groupId) {
  const key = keyOf(userId, groupId);
  if (!cache.has(key)) {
    let list = [];
    try { list = JSON.parse(localStorage.getItem(key) ?? '[]'); } catch { list = []; }
    cache.set(key, Array.isArray(list) ? list : []);
  }
  return cache.get(key);
}

function save(userId, groupId, list) {
  const key = keyOf(userId, groupId);
  cache.set(key, list);
  try { if (list.length) localStorage.setItem(key, JSON.stringify(list)); else localStorage.removeItem(key); } catch { /* private mode */ }
  for (const listener of listeners) listener();
}

export function enqueuePending(userId, groupId, content) {
  const entry = { id: `pending-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, content, createdAt: Date.now() };
  save(userId, groupId, [...pendingFor(userId, groupId), entry]);
  return entry;
}

export const dropPending = (userId, groupId, id) => save(userId, groupId, pendingFor(userId, groupId).filter((entry) => entry.id !== id));

/**
 * Tries to send every waiting message in order with `send(content)` (which seals it); stops at the first one that
 * still cannot be sealed. Resolves the number sent.
 */
export async function flushPending(userId, groupId, send) {
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
export const usePending = (userId, groupId) => useSyncExternalStore(subscribe, () => pendingFor(userId, groupId), () => []);
