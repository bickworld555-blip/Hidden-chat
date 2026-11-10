// Catch-up after the realtime connection drops and comes back: fetch what changed since the newest message
// this device has, add anything missed, and refresh ticks and deletions of messages it already holds.
import { apiFetch } from './api.js';
import { useChatStore } from './store.js';

// A little overlap so a message stamped just before our newest one (clock skew) is not skipped.
export const SYNC_OVERLAP_MS = 2 * 60 * 1000;

export function newestTimestamp(messagesByChat) {
  let newest = 0;
  for (const list of Object.values(messagesByChat ?? {})) {
    for (const message of list ?? []) {
      const time = Date.parse(message?.timestamp ?? '');
      if (Number.isFinite(time) && time > newest) newest = time;
    }
  }
  return newest;
}

// Splits the server's catch-up rows into what this device lacks (added like live messages, so chats, unread
// counts and delivery acknowledgements behave the same) and what it holds (merged per conversation).
export function planSync(rows, messagesByChat, userId) {
  const known = new Set(Object.values(messagesByChat ?? {}).flat().map((message) => message.id));
  const added = [];
  const updates = new Map();
  for (const row of rows ?? []) {
    const peerId = row.senderId === userId ? row.receiverId : row.senderId;
    if (!known.has(row.id)) {
      if (!row.deleted) added.push(row);
      continue;
    }
    if (!updates.has(peerId)) updates.set(peerId, []);
    updates.get(peerId).push(row);
  }
  const acknowledge = added.filter((row) => row.receiverId === userId && row.status === 'sent').map((row) => row.id);
  return { added, updates, acknowledge };
}

// `open` turns end-to-end encrypted rows into plaintext (src/e2e/messaging.js openRows) before they are planned.
export async function syncMissedMessages({ sessionToken, userId, acknowledge, open = async (rows) => rows, store = useChatStore, fetchImpl = apiFetch }) {
  const state = store.getState();
  const newest = newestTimestamp(state.messages);
  if (!newest || !sessionToken) return { added: 0, updated: 0 };
  const after = new Date(newest - SYNC_OVERLAP_MS).toISOString();
  const response = await fetchImpl(`/api/v1/messages/sync?after=${encodeURIComponent(after)}`, { headers: { Authorization: `Bearer ${sessionToken}` } });
  if (!response.ok) throw new Error('Could not catch up on messages.');
  const rows = await open(await response.json());
  const plan = planSync(rows, store.getState().messages, userId);
  for (const message of plan.added) store.getState().addMessage(message);
  for (const [peerId, rows] of plan.updates) store.getState().mergeHistory(peerId, rows);
  if (plan.acknowledge.length) acknowledge?.(plan.acknowledge);
  return { added: plan.added.length, updated: [...plan.updates.values()].flat().length };
}
