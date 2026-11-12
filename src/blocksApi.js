// The account's block list, kept by the server (server/blocks.mjs), which enforces it: a blocked person's messages
// are never delivered, their calls never ring, and neither side sees the other's online status, photo or statuses.
import { apiFetch } from './api.js';

const auth = (token) => ({ Authorization: `Bearer ${token}` });

/** People this account blocked: [{ id, username, name, avatar, blockedAt, deleted? }], newest first. */
export async function fetchBlocks(token) {
  const response = await apiFetch('/api/v1/blocks', { headers: auth(token) });
  if (!response.ok) throw new Error('Could not load your blocked contacts.');
  return response.json();
}

/** Blocks or unblocks someone on the server; throws when it did not happen (the device then keeps its old state). */
export async function setBlocked(token, userId, blocked) {
  const response = await apiFetch(`/api/v1/blocks/${encodeURIComponent(userId)}`, { method: blocked ? 'PUT' : 'DELETE', headers: auth(token) });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || (blocked ? 'Could not block this contact. Check your connection.' : 'Could not unblock this contact. Check your connection.'));
  }
}

/**
 * Brings this device's block periods in line with the server's list: blocks made on another device start here, and
 * blocks lifted elsewhere end here. `periods` is the store's blockedChats map ({ [id]: [{ from, to }] }).
 */
export function reconcileBlocks(periods, serverIds, at = new Date().toISOString()) {
  const next = { ...periods };
  const listed = new Set(serverIds);
  for (const id of listed) {
    const list = next[id] ?? [];
    if (!list.length || list[list.length - 1].to) next[id] = [...list, { from: at, to: null }];
  }
  for (const [id, list] of Object.entries(next)) {
    if (!listed.has(id) && list.length && !list[list.length - 1].to) next[id] = list.map((period, index) => (index === list.length - 1 ? { ...period, to: at } : period));
  }
  return next;
}
