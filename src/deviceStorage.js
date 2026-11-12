// This device's settings (theme, language, wallpaper, notification and display choices…), read synchronously by the
// screens with the localStorage API. In the Android app they live in the encrypted SQLite database (prefs table):
// loaded into memory once before the app starts (loadDeviceStorage), written through on every change. In a browser,
// and if SQLite cannot be used, they stay in localStorage.
//
// The first start of this version copies everything from localStorage into SQLite, reads it back, and only then
// removes it from localStorage: nothing is lost if the copy fails part way (the next start tries again).
import { nativeShell } from './native.js';
import { reportStorageFailure } from './storageHealth.js';

const MOVED = 'hm:prefs-moved';
const OWN_KEY = /^(relay|hm):/;
const memory = new Map();
let tables = null; // set once the SQLite store is in use
let writes = Promise.resolve();

const web = () => globalThis.localStorage;

function persist(write) {
  writes = writes.then(write).catch((error) => {
    console.error('Could not save a setting:', error);
    reportStorageFailure(error);
  });
}

/**
 * Loads the settings from SQLite (Android app). `records` (src/sqliteMessageDb.js) and `legacy` (localStorage) can be
 * given in tests. Resolves to where the settings now live: 'sqlite' or 'localStorage'.
 */
export async function loadDeviceStorage({ records = null, legacy = web(), native = nativeShell() } = {}) {
  if (!native && !records) return 'localStorage';
  try {
    const store = records ?? (await import('./sqliteMessageDb.js')).records;
    let rows = await store.prefsAll();
    if (!rows.some(([key]) => key === MOVED)) {
      const entries = [];
      for (let index = 0; index < (legacy?.length ?? 0); index += 1) {
        const key = legacy.key(index);
        // Only the app's own keys (all "relay:…" or "hm:…"); a library's own entries stay where it keeps them.
        if (key !== null && key !== MOVED && OWN_KEY.test(key)) entries.push([key, legacy.getItem(key)]);
      }
      await store.prefsPutMany([...entries.filter(([, value]) => value !== null), [MOVED, '1']]);
      rows = await store.prefsAll();
      const copied = new Map(rows);
      for (const [key, value] of entries) {
        if (value !== null && copied.get(key) !== value) throw new Error(`Setting ${key} did not copy intact.`);
      }
      for (const [key] of entries) legacy.removeItem(key);
    }
    memory.clear();
    for (const [key, value] of rows) if (key !== MOVED) memory.set(key, value);
    tables = store;
    return 'sqlite';
  } catch (error) {
    console.error('Settings stay in localStorage (SQLite unavailable):', error);
    tables = null;
    return 'localStorage';
  }
}

/** The localStorage API over this device's settings store. */
export const deviceStorage = {
  getItem(key) {
    if (tables) return memory.has(key) ? memory.get(key) : null;
    return web()?.getItem(key) ?? null;
  },
  setItem(key, value) {
    const text = String(value);
    if (!tables) { web()?.setItem(key, text); return; }
    memory.set(key, text);
    const store = tables;
    persist(() => store.prefsSet(key, text));
  },
  removeItem(key) {
    if (!tables) { web()?.removeItem(key); return; }
    memory.delete(key);
    const store = tables;
    persist(() => store.prefsDelete(key));
  },
  key(index) {
    if (!tables) return web()?.key(index) ?? null;
    return [...memory.keys()][index] ?? null;
  },
  get length() {
    return tables ? memory.size : (web()?.length ?? 0);
  },
};

/** Where the settings live now: 'sqlite' (the Android app) or 'localStorage'. */
export const deviceStorageLocation = () => (tables ? 'sqlite' : 'localStorage');

/** Resolves once every setting written so far is on disk (tests, and before the app is closed). */
export const deviceStorageWritten = () => writes;
