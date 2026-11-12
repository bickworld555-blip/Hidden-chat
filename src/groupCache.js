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
