// Attachments kept on this device (photos, videos, voice notes, documents), local-first like WhatsApp: the server
// deletes a file once every device that should have it has stored it, so each device keeps its own copy here.
// What is stored is exactly what the server served (for end-to-end encrypted attachments, the ciphertext; the key
// stays in the message), plus the file's info (name, type, size, pages) for the bubble.
import { createStore, del, get, set } from 'idb-keyval';

// Attachments bigger than this are not fetched ahead of time; they are kept once opened.
export const PREFETCH_LIMIT_BYTES = 64 * 1024 * 1024;

let store = null;
function vault() {
  if (!store && typeof indexedDB !== 'undefined') store = createStore('hm-media-vault', 'files');
  return store;
}

const key = (id) => `media:${id}`;

/** { blob, info } kept for this attachment, or null. */
export async function readStoredMedia(id) {
  const target = vault();
  if (!id || !target) return null;
  try {
    return (await get(key(id), target)) ?? null;
  } catch {
    return null;
  }
}

export async function hasStoredMedia(id) {
  return Boolean((await readStoredMedia(id))?.blob);
}

/** Keeps the bytes the server served (or that this device uploaded) and their info. */
export async function storeMedia(id, blob, info = null) {
  const target = vault();
  if (!id || !target || !(blob instanceof Blob)) return false;
  try {
    const previous = await get(key(id), target);
    await set(key(id), { blob, info: info ?? previous?.info ?? null, storedAt: Date.now() }, target);
    return true;
  } catch {
    return false;
  }
}

export async function storeMediaInfo(id, info) {
  const target = vault();
  if (!id || !target || !info) return;
  try {
    const previous = await get(key(id), target);
    if (previous?.blob) await set(key(id), { ...previous, info }, target);
  } catch { /* storage full or unavailable: the info is fetched again */ }
}

export async function forgetMedia(id) {
  const target = vault();
  if (id && target) await del(key(id), target).catch(() => {});
}
