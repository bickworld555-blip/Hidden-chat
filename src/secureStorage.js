// Encrypted local storage for what this device keeps about the account: session tokens, the message cache, the
// outbox, call history and per-account preferences: in the Android app in the encrypted SQLite database
// (src/recordStore.js), in a browser in IndexedDB (idb-keyval).
//
// Envelope encryption, like WhatsApp's AndroidKeyStore + AES/GCM: every record is AES-256-GCM encrypted with one
// random data key. The data key itself is protected by the platform:
//   • Android app: sealed by the Android Keystore (native SecureStore, keys never leave Android); only the sealed
//     form is stored, and it is opened into memory (as a non-extractable CryptoKey) at start-up.
//   • Browser: a non-extractable Web Crypto key kept in IndexedDB (scripts can use it, never read it out).
// Each record is bound to its storage key (additional data), so one record cannot be swapped in for another.
// Records written before encryption are read once in the clear and re-written encrypted.
import { del as idbDel, delMany as idbDelMany, entries as idbEntries, get as idbGet, set as idbSet } from 'idb-keyval';
import { nativeOpenSecret, nativeSealSecret, nativeShell } from './native.js';
import { reportStorageFailure } from './storageHealth.js';

export const SECURE_RECORD_VERSION = 1;
const DATA_KEY_BROWSER = 'hm:data-key-v1';
const DATA_KEY_SEALED = 'hm:data-key-sealed-v1';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toBase64 = (bytes) => {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) text += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(text);
};
const fromBase64 = (text) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

/** An encrypted record as stored: { hmSecure: version, iv, data } (base64). */
export function isSecureRecord(value) {
  return Boolean(value) && typeof value === 'object' && value.hmSecure === SECURE_RECORD_VERSION && typeof value.iv === 'string' && typeof value.data === 'string';
}

/**
 * createSecureStorage({ storage, subtle, platform }) → { get, set, del, ready }. `storage` is an idb-keyval-like
 * { get, set, del }; `platform` is { seal(text), open(sealed) } in the Android app, or null in a browser.
 */
export function createSecureStorage({ storage = { get: idbGet, set: idbSet, del: idbDel }, subtle = globalThis.crypto?.subtle, random = (bytes) => globalThis.crypto.getRandomValues(bytes), platform = null } = {}) {
  let keyPromise = null;

  async function loadKey() {
    if (!subtle) return null;
    if (platform) {
      const sealed = await storage.get(DATA_KEY_SEALED);
      if (sealed) {
        const raw = await platform.open(sealed).catch(() => null);
        if (raw) return subtle.importKey('raw', fromBase64(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
        // The Keystore key is gone (app data restored to another phone, Keystore reset): the old records can no
        // longer be read on this phone. A fresh key starts; unreadable records read as missing.
      }
      const raw = random(new Uint8Array(32));
      const sealedNew = await platform.seal(toBase64(raw)).catch(() => null);
      if (sealedNew) {
        await storage.set(DATA_KEY_SEALED, sealedNew);
        const key = await subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
        raw.fill(0);
        return key;
      }
      raw.fill(0);
      // Keystore unavailable on this phone: fall through to the browser-style key.
    }
    const existing = await storage.get(DATA_KEY_BROWSER).catch(() => null);
    if (existing) return existing;
    const key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await storage.set(DATA_KEY_BROWSER, key);
    return key;
  }

  function dataKey() {
    keyPromise ??= loadKey().catch((error) => { keyPromise = null; throw error; });
    return keyPromise;
  }

  async function encrypt(name, value) {
    const key = await dataKey();
    if (!key) return value; // No Web Crypto at all (very old browser): stored as before.
    const iv = random(new Uint8Array(12));
    const data = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(name) }, key, encoder.encode(JSON.stringify(value)));
    return { hmSecure: SECURE_RECORD_VERSION, iv: toBase64(iv), data: toBase64(new Uint8Array(data)) };
  }

  async function decrypt(name, record) {
    const key = await dataKey();
    if (!key) return undefined;
    try {
      const plain = await subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(record.iv), additionalData: encoder.encode(name) }, key, fromBase64(record.data));
      return JSON.parse(decoder.decode(plain));
    } catch {
      // Tampered, moved under another name, or written with a key this device no longer has.
      return undefined;
    }
  }

  return {
    ready: () => dataKey().then(() => true, () => false),
    // For stores that keep their own records (src/messageDb.js): a value sealed under a name, and opened again.
    seal: (name, value) => encrypt(name, value),
    open: (name, record) => (isSecureRecord(record) ? decrypt(name, record) : Promise.resolve(record)),
    async get(name) {
      const stored = await storage.get(name);
      if (stored === undefined || stored === null) return stored ?? undefined;
      if (isSecureRecord(stored)) return decrypt(name, stored);
      // Written before encryption: use it, and store it encrypted from now on.
      await storage.set(name, await encrypt(name, stored)).catch(() => {});
      return stored;
    },
    async set(name, value) {
      await storage.set(name, await encrypt(name, value));
    },
    del(name) {
      return storage.del(name);
    },
  };
}

const nativePlatform = () => (nativeShell()
  ? {
    seal: async (value) => { const result = await nativeSealSecret(value); if (!result?.sealed) throw new Error('not sealed'); return result.sealed; },
    open: async (sealed) => { const result = await nativeOpenSecret(sealed); if (!result?.value) throw new Error('not opened'); return result.value; },
  }
  : null);

// The Android app keeps these records in its encrypted SQLite database (src/recordStore.js), moved there once from
// IndexedDB; the browser keeps IndexedDB.
function nativeRecordStorage() {
  let tables = null;
  const sqlite = () => (tables ??= import('./sqliteMessageDb.js').then((module) => module.records));
  const via = (name) => async (...args) => (await sqlite())[name](...args);
  const ownedHere = (name, value) => isSecureRecord(value) || name === DATA_KEY_SEALED;
  return import('./recordStore.js').then(({ createRecordStorage }) => createRecordStorage({
    tables: { kvGet: via('kvGet'), kvSet: via('kvSet'), kvDelete: via('kvDelete'), kvPutMany: via('kvPutMany') },
    idb: { get: idbGet, set: idbSet, del: idbDel, delMany: idbDelMany, entries: idbEntries },
    owns: ownedHere,
    keepInIdb: [DATA_KEY_BROWSER],
  }));
}

let nativeRecords = null;
/** Where the records live: 'sqlite' or 'idb' in the Android app (once moved), 'idb' in a browser. */
export async function secureRecordsLocation() {
  secureStorage();
  return nativeRecords ? (await nativeRecords).ready() : 'idb';
}

let shared = null;
/** The app's encrypted store (created on first use, so tests and server code never touch the platform). */
export function secureStorage() {
  if (!shared) {
    const platform = nativePlatform();
    if (platform) {
      const records = nativeRecordStorage();
      nativeRecords = records;
      const storage = {
        get: async (name) => (await records).get(name),
        // A record that cannot be written (phone full) is reported; the caller still sees the error.
        set: async (name, value) => { try { return await (await records).set(name, value); } catch (error) { reportStorageFailure(error); throw error; } },
        del: async (name) => (await records).del(name),
      };
      shared = createSecureStorage({ platform, storage });
    } else {
      shared = createSecureStorage({ platform });
    }
  }
  return shared;
}

export const secureGet = (name) => secureStorage().get(name);
export const secureSet = (name, value) => secureStorage().set(name, value);
export const secureDel = (name) => secureStorage().del(name);
