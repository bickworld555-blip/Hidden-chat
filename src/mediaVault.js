// Attachments kept on this device (photos, videos, voice notes, documents), local-first like WhatsApp: the server
// deletes a file once every device that should have it has stored it, so each device keeps its own copy.
// What is stored is exactly what the server served (for end-to-end encrypted attachments, the ciphertext; the key
// stays in the message and, on the phone, in the media reference), plus the file's info for the bubble.
//
//   Android app: the file in the app's private folder (Capacitor Filesystem, Directory.Data/media/<id>.bin) and a
//                reference row in the encrypted SQLite database (src/sqliteMessageDb.js: local_file_path,
//                file_hash, decryption_key, server_blob_path).
//   Web:         IndexedDB ("hm-media-vault").
import { createStore, del, entries, get, set } from 'idb-keyval';
import { nativeShell } from './native.js';
import { classifyStorageError, reportStorageFailure } from './storageHealth.js';
import { recordUsage } from './networkUsage.js';

// Attachments bigger than this are fetched ahead of time only by the Android app, straight to disk, on Wi-Fi and
// with room to spare (src/media.js largeDownloadPlan); otherwise they are kept once opened.
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

// Big files never cross the plugin bridge as one base64 string (a 300 MB video was 400 MB of text in the WebView):
// they are written in pieces and read back through the WebView's own file URL, which it streams from disk.
const WRITE_PIECE_BYTES = 3 * 1024 * 1024;

async function readNativeFile(parts, path, type) {
  try {
    const { uri } = await parts.Filesystem.getUri({ path, directory: parts.Directory.Data });
    const response = await fetch(globalThis.Capacitor.convertFileSrc(uri));
    if (response.ok) {
      const blob = await response.blob();
      return type && blob.type !== type ? new Blob([blob], { type }) : blob;
    }
  } catch { /* the plugin's own read below */ }
  const file = await parts.Filesystem.readFile({ path, directory: parts.Directory.Data });
  return fromBase64(file.data, type);
}

async function writeNativeFile(parts, path, blob) {
  if (blob.size <= WRITE_PIECE_BYTES) {
    await parts.Filesystem.writeFile({ path, data: await toBase64(blob), directory: parts.Directory.Data, recursive: true });
    return;
  }
  for (let offset = 0; offset < blob.size; offset += WRITE_PIECE_BYTES) {
    const data = await toBase64(blob.slice(offset, offset + WRITE_PIECE_BYTES));
    if (offset === 0) await parts.Filesystem.writeFile({ path, data, directory: parts.Directory.Data, recursive: true });
    else await parts.Filesystem.appendFile({ path, data, directory: parts.Directory.Data });
  }
}

/** { blob, info } kept for this attachment, or null. */
export async function readStoredMedia(id) {
  if (!id) return null;
  const parts = await native();
  if (parts) {
    try {
      const ref = await parts.refs.readMediaRef(id);
      if (ref) return { blob: await readNativeFile(parts, ref.local_file_path, ref.content_type), info: ref.info };
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

/**
 * Every attachment kept on this device, for Settings › Storage and data › Manage storage: [{ id, size, contentType,
 * storedAt }]. On the phone from the SQLite records (no file is read); in a browser from the IndexedDB vault.
 */
export async function listStoredMedia() {
  const parts = await native();
  const found = new Map();
  if (parts) {
    try {
      for (const row of await parts.refs.listMediaRefs()) {
        found.set(row.id, { id: row.id, size: Number(row.byte_size) || 0, contentType: row.content_type ?? '', storedAt: Number(row.stored_at) || 0 });
      }
    } catch { /* the web store below */ }
  }
  const target = vault();
  if (target) {
    try {
      for (const [name, value] of await entries(target)) {
        const id = String(name).replace(/^media:/, '');
        if (!found.has(id) && value?.blob instanceof Blob) found.set(id, { id, size: value.blob.size, contentType: value.blob.type || value.info?.contentType || '', storedAt: 0 });
      }
    } catch { /* unavailable */ }
  }
  return [...found.values()];
}

/** Whether this attachment is kept here, without reading it (the phone checks its record only). */
export async function isStoredLocally(id) {
  if (!id) return false;
  const parts = await native();
  if (parts) {
    try { if (await parts.refs.readMediaRef(id)) return true; } catch { /* web store below */ }
  }
  const target = vault();
  if (!target) return false;
  try { return Boolean((await get(key(id), target))?.blob); } catch { return false; }
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
      await writeNativeFile(parts, path, blob);
      await parts.refs.writeMediaRef({
        // A big file is not hashed here (that reads all of it into memory); an encrypted one is checked against its
        // descriptor's digests whenever it is opened.
        id, localFilePath: path, fileHash: blob.size <= PREFETCH_LIMIT_BYTES ? await sha256(blob) : null, decryptionKey: descriptor ? JSON.stringify(descriptor) : null,
        serverBlobPath: `/api/v1/media/${id}`, contentType: blob.type, byteSize: blob.size, info,
      });
      return true;
    } catch (error) {
      // No room on the phone: the attachment stays on the server (its message is not acknowledged) and the app says so.
      if (classifyStorageError(error) === 'full') { reportStorageFailure(error); return false; }
      /* otherwise the web store below */
    }
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

/** True in the Android app, where big attachments can be downloaded straight to disk (downloadMediaToDevice). */
export async function canDownloadToDevice() {
  return Boolean(await native());
}

/**
 * Android: downloads `url` (a one-time link to the bytes the server keeps) straight into the app's private folder on a
 * background thread, without passing the file through the WebView, then records it like storeMedia. A failed or
 * interrupted download leaves no record (and its partial file is removed).
 */
export async function downloadMediaToDevice(id, url, info = null, { descriptor = null, size = null } = {}) {
  const parts = await native();
  if (!parts || !id || !/^https?:\/\//.test(String(url))) return false;
  const path = `media/${id}.bin`;
  try {
    await parts.Filesystem.downloadFile({ url, path, directory: parts.Directory.Data, recursive: true });
    const stat = await parts.Filesystem.stat({ path, directory: parts.Directory.Data });
    if (size && Number(stat.size) !== Number(size)) throw new Error(`Downloaded ${stat.size} of ${size} bytes.`);
    recordUsage('media', { received: Number(stat.size) });
    await parts.refs.writeMediaRef({
      id, localFilePath: path, fileHash: null, decryptionKey: descriptor ? JSON.stringify(descriptor) : null,
      serverBlobPath: `/api/v1/media/${id}`, contentType: info?.contentType ?? 'application/octet-stream', byteSize: Number(stat.size), info,
    });
    return true;
  } catch (error) {
    await parts.Filesystem.deleteFile({ path, directory: parts.Directory.Data }).catch(() => {});
    throw error;
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
