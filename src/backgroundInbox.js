// What the background page (src/background/main.js) opened while the app had no screen: each opened event, sealed
// with the Android Keystore (the page has no other way to encrypt at rest), in its own IndexedDB store. The app
// imports them in arrival order when it starts, under the "hm-e2e" lock, through its usual event handler, and only
// then deletes them. The page never touches the app's encrypted database itself.
import { createStore, del, entries, set } from 'idb-keyval';

let store = null;
const inbox = () => (store ??= createStore('hm-bg', 'inbox'));
let sequence = 0;

/** A key that sorts in arrival order. */
export function inboxKey(id = '', now = Date.now()) {
  sequence = (sequence + 1) % 1_000_000;
  return `${String(now).padStart(15, '0')}-${String(sequence).padStart(6, '0')}-${String(id).slice(0, 80)}`;
}

/** Keeps one sealed event (the page). Resolves once it is written; rejects when it could not be. */
export function keepInInbox(sealed, key, target = inbox()) {
  if (typeof sealed !== 'string' || !sealed) return Promise.reject(new Error('Nothing sealed to keep.'));
  return set(key, sealed, target);
}

/**
 * Imports what the page kept (the app): `open(sealed)` resolves the JSON text, `handle(event)` applies it, and
 * `commit()` (once, after all of them) saves the result to disk; only then are the imported entries deleted, so a
 * crash in between imports them again (the store merges by id). One that can no longer be opened (the Keystore key
 * changed) is dropped; one whose handler fails stays for the next start.
 */
// `read` / `remove`: the store's entries and delete (idb-keyval's; injectable for tests).
export async function importInbox({ open, handle, commit = async () => {}, target = null, read = entries, remove = del }) {
  target ??= inbox();
  const rows = (await read(target)).filter(([key, value]) => typeof key === 'string' && typeof value === 'string')
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const done = [];
  for (const [key, sealed] of rows) {
    let event;
    try {
      event = JSON.parse(await open(sealed));
    } catch {
      await remove(key, target).catch(() => {});
      continue;
    }
    try {
      await handle(event);
      done.push(key);
    } catch {
      // Left for the next start.
    }
  }
  if (!done.length) return 0;
  await commit();
  for (const key of done) await remove(key, target).catch(() => {});
  return done.length;
}
