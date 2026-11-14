// Client-side media helpers. The server owns each file's content type (reported by HEAD /api/v1/media/:id);
// the extension is used only where no server facts are available, such as chat-list previews.
import { MAX_TRANSFER_BYTES, PREVIEW_LIMIT_BYTES } from './transfer.js';
import { decryptMedia, parseEncryptedMediaRef } from './mediaCrypto.js';
import { apiFetch, apiUrl } from './api.js';
import { PREFETCH_LIMIT_BYTES, canDownloadToDevice, downloadMediaToDevice, readStoredMedia, storeMedia, storeMediaInfo } from './mediaVault.js';
import { recordUsage } from './networkUsage.js';
import { mayAutoDownload } from './autoDownload.js';

export const MAX_UPLOAD_BYTES = MAX_TRANSFER_BYTES;

// Whether a file of this size may be fetched into memory for an inline preview.
export function canPreviewSize(bytes) {
  return Number.isFinite(bytes) && bytes >= 0 && bytes <= PREVIEW_LIMIT_BYTES;
}

// Raster formats browsers render in <img>; SVG is excluded because a top-level SVG document can run script.
const PREVIEWABLE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/avif']);
const OPENABLE_DOCUMENT_TYPES = new Set(['application/pdf', 'text/plain']);

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'heic', 'heif', 'svg', 'tif', 'tiff']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', '3gp']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac', 'weba']);

const FILE_TONES = [
  [['pdf'], 'pdf'],
  [['doc', 'docx', 'odt', 'rtf', 'txt', 'md'], 'doc'],
  [['xls', 'xlsx', 'ods', 'csv'], 'sheet'],
  [['ppt', 'pptx', 'odp', 'key'], 'slides'],
  [['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz'], 'archive'],
  [['apk', 'aab', 'xapk', 'ipa', 'exe', 'msi', 'dmg', 'deb', 'appimage'], 'app'],
];

// End-to-end encrypted attachments ("emedia:", src/mediaCrypto.js) parse like ordinary ones; their descriptor
// is remembered by media id so every viewer path (thumbnails, viewer, download) decrypts transparently.
const encryptedDescriptors = new Map();

/** Remembers how to decrypt an upload (an encrypted voice note's key travels in its own format, src/voice.js). */
export function registerMediaDescriptor(id, descriptor) {
  if (id && descriptor) encryptedDescriptors.set(id, descriptor);
}

/** True when this upload is stored encrypted: it must be downloaded whole and decrypted, never streamed or linked. */
export function isEncryptedMedia(id) {
  return encryptedDescriptors.has(id);
}

/** An attachment message: "media:…" or an end-to-end encrypted "emedia:…". */
export function isMediaContent(content) {
  return typeof content === 'string' && (content.startsWith('media:') || content.startsWith('emedia:'));
}

export function parseMediaRef(content) {
  const encrypted = parseEncryptedMediaRef(content);
  if (encrypted) {
    encryptedDescriptors.set(encrypted.mediaId, encrypted.descriptor);
    return { id: encrypted.mediaId, filename: encrypted.filename || 'attachment', encrypted: true };
  }
  if (typeof content !== 'string' || !content.startsWith('media:')) return null;
  const [, id = '', ...rest] = content.split(':');
  return { id, filename: rest.join(':') || 'attachment' };
}

export function fileExtension(filename) {
  if (typeof filename !== 'string') return '';
  const dot = filename.lastIndexOf('.');
  return dot > 0 && dot < filename.length - 1 ? filename.slice(dot + 1).toLowerCase() : '';
}

function essence(contentType) {
  return String(contentType ?? '').split(';', 1)[0].trim().toLowerCase();
}

// How a file is presented in the bubble, decided from the server-reported content type.
export function mediaKind(contentType) {
  const type = essence(contentType);
  if (PREVIEWABLE_IMAGE_TYPES.has(type)) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  return 'file';
}

// Types that may be shown in a new browser tab without executing script on this origin.
export function canOpenInBrowser(contentType) {
  const type = essence(contentType);
  return OPENABLE_DOCUMENT_TYPES.has(type) || PREVIEWABLE_IMAGE_TYPES.has(type);
}

export function fileTypeLabel(filename) {
  const extension = fileExtension(filename);
  return extension ? extension.slice(0, 5).toUpperCase() : 'FILE';
}

export function fileTone(filename) {
  const extension = fileExtension(filename);
  for (const [extensions, tone] of FILE_TONES) if (extensions.includes(extension)) return tone;
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  return 'generic';
}

export function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  // WhatsApp writes a file between 100 KB and 1 MB as a fraction of a megabyte: "0.90 MB".
  if (bytes >= 100 * 1024 && bytes < 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}

// Chat-list and reply previews only have the message text, so they use the filename's extension.
export function mediaPreviewLabel(content) {
  const ref = parseMediaRef(content);
  if (!ref) return '📎 Attachment';
  const extension = fileExtension(ref.filename);
  if (IMAGE_EXTENSIONS.has(extension)) return '📷 Photo';
  if (VIDEO_EXTENSIONS.has(extension)) return '🎥 Video';
  if (AUDIO_EXTENSIONS.has(extension)) return `🎵 ${ref.filename}`;
  return `📄 ${ref.filename}`;
}

function mediaUrl(id) {
  return `/api/v1/media/${encodeURIComponent(id)}`;
}

async function fetchMediaInfo(id, sessionToken, signal) {
  const response = await apiFetch(mediaUrl(id), { method: 'HEAD', headers: { Authorization: `Bearer ${sessionToken}` }, signal });
  if (!response.ok) throw new Error(response.status === 404 ? 'File is no longer available.' : 'Could not load file details.');
  const length = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  const pages = Number.parseInt(response.headers.get('x-page-count') ?? '', 10);
  return {
    contentType: essence(response.headers.get('content-type')) || 'application/octet-stream',
    size: Number.isFinite(length) ? length : null,
    ...(Number.isFinite(pages) && pages > 0 ? { pages } : {}),
  };
}

// Downloads the exact stored bytes; onProgress receives a 0..1 fraction when the size is known.
async function fetchMediaBlob(id, sessionToken, { signal, onProgress } = {}) {
  const blob = await fetchMediaBytes(id, sessionToken, { signal, onProgress });
  recordUsage('media', { received: blob.size });
  return blob;
}

async function fetchMediaBytes(id, sessionToken, { signal, onProgress } = {}) {
  const response = await apiFetch(mediaUrl(id), { headers: { Authorization: `Bearer ${sessionToken}` }, signal });
  if (!response.ok) throw new Error(response.status === 404 ? 'File is no longer available.' : 'Download failed.');
  const type = essence(response.headers.get('content-type'));
  const total = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (!onProgress || !response.body || !Number.isFinite(total) || total <= 0) return response.blob();
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress(Math.min(received / total, 1));
  }
  return new Blob(chunks, { type });
}

// A media id always refers to the same stored bytes, so completed downloads are shared by the chat
// bubbles, the full-screen viewer, and the media gallery. Memory is bounded; sign-out clears it.
const BLOB_CACHE_LIMIT_BYTES = 64 * 1024 * 1024;
const INFO_CACHE_LIMIT = 500;
const blobCache = new Map();
const infoCache = new Map();
let blobCacheBytes = 0;

function cacheKey(id, sessionToken) {
  return `${sessionToken}\n${id}`;
}

function touch(cache, key) {
  const value = cache.get(key);
  if (value === undefined) return null;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

export function peekMediaInfo(id, sessionToken) {
  return id && sessionToken ? touch(infoCache, cacheKey(id, sessionToken)) : null;
}

export function peekMediaBlob(id, sessionToken) {
  return id && sessionToken ? touch(blobCache, cacheKey(id, sessionToken)) : null;
}

export async function loadMediaInfo(id, sessionToken, signal) {
  const cached = peekMediaInfo(id, sessionToken);
  if (cached) return cached;
  // Kept on this device (the server may already have deleted it): its info came with it.
  const stored = await readStoredMedia(id);
  const fetched = stored?.info ?? await fetchMediaInfo(id, sessionToken, signal);
  if (!stored?.info) storeMediaInfo(id, fetched);
  // The server only knows the ciphertext: an encrypted attachment's real type and size come from its descriptor.
  const descriptor = encryptedDescriptors.get(id);
  const info = descriptor ? { ...fetched, contentType: descriptor.type || fetched.contentType, size: descriptor.size } : fetched;
  infoCache.set(cacheKey(id, sessionToken), info);
  while (infoCache.size > INFO_CACHE_LIMIT) infoCache.delete(infoCache.keys().next().value);
  return info;
}

export async function loadMediaBlob(id, sessionToken, options = {}) {
  const cached = peekMediaBlob(id, sessionToken);
  if (cached) {
    options.onProgress?.(1);
    return cached;
  }
  // This device's own copy first; a file fetched from the server is kept, as the server deletes it once every
  // device has its copy.
  const stored = await readStoredMedia(id);
  const fetched = stored?.blob ?? await fetchMediaBlob(id, sessionToken, options);
  if (!stored?.blob) await storeMedia(id, fetched, peekMediaInfo(id, sessionToken), { descriptor: encryptedDescriptors.get(id) ?? null });
  const descriptor = encryptedDescriptors.get(id);
  const blob = descriptor ? await decryptMedia(fetched, descriptor) : fetched;
  const key = cacheKey(id, sessionToken);
  if (blob.size <= BLOB_CACHE_LIMIT_BYTES / 4 && !blobCache.has(key)) {
    blobCache.set(key, blob);
    blobCacheBytes += blob.size;
    while (blobCacheBytes > BLOB_CACHE_LIMIT_BYTES) {
      const [oldestKey, oldest] = blobCache.entries().next().value;
      blobCache.delete(oldestKey);
      blobCacheBytes -= oldest.size;
    }
  }
  return blob;
}

// Free space kept for the phone itself after a big download.
export const LARGE_DOWNLOAD_RESERVE_BYTES = 256 * 1024 * 1024;
let lastLargeDownloadDecision = null;
export const largeDownloadDecision = () => lastLargeDownloadDecision;

/**
 * Whether a big attachment (over PREFETCH_LIMIT_BYTES) may be fetched ahead of time now: { ok, reason }. Never on
 * mobile data (`connection.type` 'cellular', or a metered `saveData` connection), and only with its size plus a reserve
 * free (`estimate`: navigator.storage.estimate(), which the WebView bases on the phone's free space).
 */
export function largeDownloadPlan({ size, connection = null, estimate = null }) {
  const type = connection?.type;
  if (connection?.saveData) return { ok: false, reason: 'data-saver' };
  if (type && !['wifi', 'ethernet'].includes(type)) return { ok: false, reason: type === 'none' ? 'offline' : 'mobile-data' };
  const free = Number(estimate?.quota) - Number(estimate?.usage);
  if (Number.isFinite(free) && free < Number(size) + LARGE_DOWNLOAD_RESERVE_BYTES) return { ok: false, reason: 'low-storage' };
  return { ok: true, reason: 'ok' };
}

/**
 * Fetches an attachment into this device's store ahead of time (a message is acknowledged to the server only once
 * its attachment is kept here). True when it is kept; big files are left until opened.
 */
export async function storeMediaLocally(id, sessionToken, { voice = false } = {}) {
  if (!id || !sessionToken) return false;
  if ((await readStoredMedia(id))?.blob) return true;
  try {
    const info = await fetchMediaInfo(id, sessionToken);
    // Media auto-download (Storage and data): a kind switched off for this connection waits for a tap.
    if (!(await mayAutoDownload(info?.contentType, { voice }))) return false;
    const size = Number(info?.size ?? 0);
    if (size > PREFETCH_LIMIT_BYTES) {
      // Big files: on the phone, fetched straight to disk while on Wi-Fi with room to spare, so the server can let go
      // of them before they expire; otherwise kept once opened (and tried again at the next reconnect).
      if (!(await canDownloadToDevice())) return false;
      const estimate = await globalThis.navigator?.storage?.estimate?.().catch(() => null);
      const plan = largeDownloadPlan({ size, connection: globalThis.navigator?.connection, estimate });
      lastLargeDownloadDecision = { id, size, ...plan, at: Date.now() };
      if (!plan.ok) return false;
      const link = await requestMediaLink(id, sessionToken);
      return await downloadMediaToDevice(id, link.url, info, { descriptor: encryptedDescriptors.get(id) ?? null, size });
    }
    const blob = await fetchMediaBlob(id, sessionToken);
    return storeMedia(id, blob, info, { descriptor: encryptedDescriptors.get(id) ?? null });
  } catch {
    return false;
  }
}

/** What the in-memory media cache holds (Storage and data). */
export function mediaCacheStats() {
  return { files: blobCache.size, bytes: blobCacheBytes };
}

export function clearMediaCache() {
  blobCache.clear();
  infoCache.clear();
  blobCacheBytes = 0;
}

// Asks the server for a short-lived link, so the browser streams the file to disk itself
// (with its own progress and resume) instead of holding the bytes in memory.
export async function requestMediaLink(id, sessionToken, { inline = false, signal } = {}) {
  const response = await apiFetch(`${mediaUrl(id)}/link`, { method: 'POST', headers: { Authorization: 'Bearer ' + sessionToken }, signal });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.url) throw new Error(data?.error || (response.status === 404 ? 'File is no longer available.' : 'Could not prepare the download.'));
  const url = apiUrl(data.url);
  return { ...data, url: inline ? `${url}&inline=1` : url };
}

// Saves the exact stored bytes under the original filename without reading them into memory.
export async function downloadMedia(id, filename, sessionToken) {
  if (isEncryptedMedia(id)) {
    saveBlob(await loadMediaBlob(id, sessionToken), filename || 'attachment');
    return;
  }
  const link = await requestMediaLink(id, sessionToken);
  const anchor = document.createElement('a');
  anchor.href = link.url;
  anchor.download = filename || link.filename || 'attachment';
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

// Saves the bytes under the original filename, so the extension and format are unchanged.
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename || 'attachment';
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// m:ss (h:mm:ss from an hour) for the length shown on a video, as on WhatsApp.
export function formatVideoLength(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}
