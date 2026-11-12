// Groups kept on this device, so the group list (names, photos, last activity) and each group's details still show
// when the phone is offline. The server's answer replaces them whenever it arrives.
//
//   Android app: the encrypted SQLite database (src/sqliteMessageDb.js, table "cache").
//   Web:         IndexedDB, like the contact list.
import { get, set } from 'idb-keyval';
import { nativeShell } from './native.js';

const LIST_KEY = 'groups';
const detailsKey = (groupId) => `group:${groupId}`;

let sqlite = null;
async function native() {
  if (!nativeShell()) return null;
  sqlite ??= import('./sqliteMessageDb.js').catch(() => null);
  return sqlite;
}

async function read(owner, key) {
  if (!owner) return undefined;
  const db = await native();
  if (db) {
    try { return await db.readCached(owner, key); } catch { /* falls back to the web store */ }
  }
  try { return await get(`relay:${key}:${owner}`); } catch { return undefined; }
}

async function write(owner, key, value) {
  if (!owner) return;
  const db = await native();
  if (db) {
    try { await db.writeCached(owner, key, value); return; } catch { /* falls back to the web store */ }
  }
  try { await set(`relay:${key}:${owner}`, value); } catch { /* storage full or unavailable: shown online only */ }
}

/** The group list last received from the server, or null when none was kept. */
export async function cachedGroups(owner) {
  const list = await read(owner, LIST_KEY);
  return Array.isArray(list) ? list : null;
}

export const saveGroups = (owner, list) => (Array.isArray(list) ? write(owner, LIST_KEY, list) : Promise.resolve());

/** One group's details (name, members, settings) last received from the server, or null. */
export async function cachedGroupDetails(owner, groupId) {
  if (!groupId) return null;
  const details = await read(owner, detailsKey(groupId));
  return details && typeof details === 'object' ? details : null;
}

export const saveGroupDetails = (owner, groupId, details) => (groupId && details && typeof details === 'object'
  ? write(owner, detailsKey(groupId), details)
  : Promise.resolve());

/**
 * Details to show offline for a group that was never opened online since its details were kept: its name, role and
 * settings from the saved list, with only this account as a known member (other senders show as "Member").
 */
export function offlineGroupDetails(summary, userId) {
  if (!summary?.id) return null;
  return { ...summary, members: [{ id: userId, name: 'You', role: summary.role ?? 'member' }], offline: true };
}

/**
 * While online, keeps every listed group's details on the device once per app session, so a group opens offline
 * with its members even if it was not opened before. `fetchDetails(groupId)` returns the server's details.
 */
const prefetched = new Set();
export async function prefetchGroupDetails(owner, list, fetchDetails, { limit = 50 } = {}) {
  for (const group of (Array.isArray(list) ? list : []).slice(0, limit)) {
    const key = `${owner}:${group?.id}`;
    if (!group?.id || prefetched.has(key)) continue;
    prefetched.add(key);
    try {
      const details = await fetchDetails(group.id);
      if (details) await saveGroupDetails(owner, group.id, details);
    } catch {
      prefetched.delete(key); // tried again on the next listing
    }
  }
}
