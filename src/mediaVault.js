// Attachments kept on this device (photos, videos, voice notes, documents), local-first like WhatsApp: the server
// deletes a file once every device that should have it has stored it, so each device keeps its own copy.
// What is stored is exactly what the server served (for end-to-end encrypted attachments, the ciphertext; the key
// stays in the message and, on the phone, in the media reference), plus the file's info for the bubble.
//
//   Android app: the file in the app's private folder (Capacitor Filesystem, Directory.Data/media/<id>.bin) and a
//                reference row in the encrypted SQLite database (src/sqliteMessageDb.js: local_file_path,
//                file_hash, decryption_key, server_blob_path).
//   Web:         IndexedDB ("hm-media-vault").
import { createStore, del, get, set } from 'idb-keyval';
import { nativeShell } from './native.js';

// Attachments bigger than this are not fetched ahead of time; they are kept once opened.
export const PREFETCH_LIMIT_BYTES = 64 * 1024 * 1024;

let store = null;
function vault() {
  if (!store && typeof indexedDB !== 'undefined') store = createStore('hm-media-vault', 'files');
  return store;
}
const key = (id) => `media:${id}`;

// --- Android: private files + SQLite references (loaded only in the app) ---
let nativeParts = null;
async function native() {
  if (!nativeShell()) return null;
  nativeParts ??= Promise.all([import('@capacitor/filesystem'), import('./sqliteMessageDb.js')])
    .then(([fs, refs]) => ({ Filesystem: fs.Filesystem, Directory: fs.Directory, refs }))
    .catch(() => null);
  return nativeParts;
}

async function toBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

function fromBase64(data, type) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: type || 'application/octet-stream' });
}

async function sha256(blob) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** { blob, info } kept for this attachment, or null. */
export async function readStoredMedia(id) {
  if (!id) return null;
  const parts = await native();
  if (parts) {
    try {
      const ref = await parts.refs.readMediaRef(id);
      if (ref) {
        const file = await parts.Filesystem.readFile({ path: ref.local_file_path, directory: parts.Directory.Data });
        return { blob: fromBase64(file.data, ref.content_type), info: ref.info };
      }
    } catch { /* falls back to the web store below */ }
  }
  const target = vault();
  if (!target) return null;
  try {
    return (await get(key(id), target)) ?? null;
  } catch {
    return null;
  }
}

export async function hasStoredMedia(id) {
  return Boolean((await readStoredMedia(id))?.blob);
}

/** Keeps the bytes the server served (or that this device uploaded), their info and, when known, their key. */
export async function storeMedia(id, blob, info = null, { descriptor = null } = {}) {
  if (!id || !(blob instanceof Blob)) return false;
  const parts = await native();
  if (parts) {
    try {
      const path = `media/${id}.bin`;
      await parts.Filesystem.writeFile({ path, data: await toBase64(blob), directory: parts.Directory.Data, recursive: true });
      await parts.refs.writeMediaRef({
        id, localFilePath: path, fileHash: await sha256(blob), decryptionKey: descriptor ? JSON.stringify(descriptor) : null,
        serverBlobPath: `/api/v1/media/${id}`, contentType: blob.type, byteSize: blob.size, info,
      });
      return true;
    } catch { /* falls back to the web store below */ }
  }
  const target = vault();
  if (!target) return false;
  try {
    const previous = await get(key(id), target);
    await set(key(id), { blob, info: info ?? previous?.info ?? null, storedAt: Date.now() }, target);
    return true;
  } catch {
    return false;
  }
}

export async function storeMediaInfo(id, info) {
  if (!id || !info) return;
  const parts = await native();
  if (parts) {
    try {
      if (await parts.refs.readMediaRef(id)) { await parts.refs.updateMediaInfo(id, info); return; }
    } catch { /* web store below */ }
  }
  const target = vault();
  if (!target) return;
  try {
    const previous = await get(key(id), target);
    if (previous?.blob) await set(key(id), { ...previous, info }, target);
  } catch { /* storage full or unavailable: the info is fetched again */ }
}

export async function forgetMedia(id) {
  if (!id) return;
  const parts = await native();
  if (parts) {
    try {
      const ref = await parts.refs.readMediaRef(id);
      if (ref) await parts.Filesystem.deleteFile({ path: ref.local_file_path, directory: parts.Directory.Data }).catch(() => {});
      await parts.refs.deleteMediaRef(id);
    } catch { /* web store below */ }
  }
  const target = vault();
  if (target) await del(key(id), target).catch(() => {});
}

/** Attachment files in the app's private folder (Android), or null elsewhere. */
export async function storedMediaFileCount() {
  const parts = await native();
  if (!parts) return null;
  try {
    const listing = await parts.Filesystem.readdir({ path: 'media', directory: parts.Directory.Data });
    return listing.files.filter((file) => String(file.name ?? file).endsWith('.bin')).length;
  } catch {
    return 0; // no attachment kept yet: the folder does not exist
  }
}
