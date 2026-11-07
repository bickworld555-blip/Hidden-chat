// Download manager with live progress (bytes, %, speed, time left) shared by every attachment.
// Strategy: stream straight to a file the user picks (File System Access API) when available;
// otherwise fetch into memory with progress for files small enough; otherwise hand the browser a link.
import { useSyncExternalStore } from 'react';
import { PREVIEW_LIMIT_BYTES } from './transfer.js';
import { downloadMedia, loadMediaBlob, loadMediaInfo, saveBlob } from './media.js';

const downloads = new Map();
const listeners = new Set();
let snapshot = new Map();

function publish() {
  snapshot = new Map(downloads);
  for (const listener of listeners) listener();
}

function update(id, patch) {
  downloads.set(id, { ...(downloads.get(id) ?? {}), ...patch });
  publish();
}

export function subscribeDownloads(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getDownload(id) {
  return snapshot.get(id) ?? null;
}

export function useDownloadProgress(id) {
  return useSyncExternalStore(subscribeDownloads, () => snapshot.get(id) ?? null, () => null);
}

// Exponential moving average of throughput keeps the time-left estimate from jumping around.
export function progressStats({ received, total, startedAt, now = Date.now(), previousRate = 0 }) {
  const elapsed = Math.max(0.001, (now - startedAt) / 1000);
  const instant = received / elapsed;
  const rate = previousRate ? previousRate * 0.7 + instant * 0.3 : instant;
  const fraction = total > 0 ? Math.min(received / total, 1) : 0;
  const etaSeconds = total > 0 && rate > 0 ? Math.max(0, (total - received) / rate) : null;
  return { fraction, rate, etaSeconds };
}

export function formatEta(seconds) {
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 1) return 'almost done';
  if (seconds < 60) return `${Math.ceil(seconds)} s left`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min left`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min left`;
}

export function formatRate(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '';
  if (bytesPerSecond < 1024 * 1024) return `${Math.round(bytesPerSecond / 1024)} KB/s`;
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
}

export function cancelDownload(id) {
  downloads.get(id)?.controller?.abort();
}

export function clearDownload(id) {
  downloads.delete(id);
  publish();
}

function finish(id, patch) {
  update(id, patch);
  setTimeout(() => { if (downloads.get(id)?.status !== 'running') clearDownload(id); }, patch.status === 'error' ? 6000 : 1500);
}

async function streamToFile(id, handle, sessionToken, total, controller) {
  const writable = await handle.createWritable();
  const response = await fetch(`/api/v1/media/${encodeURIComponent(id)}`, { headers: { Authorization: 'Bearer ' + sessionToken }, signal: controller.signal });
  if (!response.ok || !response.body) throw new Error(response.status === 404 ? 'File is no longer available.' : 'Download failed.');
  const reader = response.body.getReader();
  const startedAt = Date.now();
  let received = 0;
  let rate = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
      received += value.byteLength;
      const stats = progressStats({ received, total, startedAt, previousRate: rate });
      rate = stats.rate;
      update(id, { received, total, fraction: stats.fraction, rate, etaSeconds: stats.etaSeconds });
    }
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
}

async function fetchThenSave(id, filename, sessionToken, total, controller) {
  const startedAt = Date.now();
  let rate = 0;
  const blob = await loadMediaBlob(id, sessionToken, {
    signal: controller.signal,
    onProgress: (fraction) => {
      const received = Math.round(fraction * total);
      const stats = progressStats({ received, total, startedAt, previousRate: rate });
      rate = stats.rate;
      update(id, { received, total, fraction, rate, etaSeconds: stats.etaSeconds });
    },
  });
  saveBlob(blob, filename);
}

// Starts (or ignores, if already running) a download and reports progress through the store.
export async function downloadWithProgress(id, filename, sessionToken) {
  if (downloads.get(id)?.status === 'running') return;
  const controller = new AbortController();
  update(id, { status: 'running', received: 0, total: 0, fraction: 0, rate: 0, etaSeconds: null, controller, filename });
  try {
    // The save dialog must open inside the user's click, before any network round trip.
    let handle = null;
    if (typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function') {
      handle = await window.showSaveFilePicker({ suggestedName: filename });
    }
    const info = await loadMediaInfo(id, sessionToken, controller.signal).catch(() => null);
    const total = info?.size ?? 0;
    update(id, { total });
    if (handle) {
      await streamToFile(id, handle, sessionToken, total, controller);
    } else if (total > 0 && total <= PREVIEW_LIMIT_BYTES) {
      await fetchThenSave(id, filename, sessionToken, total, controller);
    } else {
      // Too big to hold in memory and no streaming API: the browser's own download UI shows progress.
      await downloadMedia(id, filename, sessionToken);
      finish(id, { status: 'handoff', fraction: 1 });
      return;
    }
    finish(id, { status: 'done', fraction: 1, received: total });
  } catch (error) {
    if (error?.name === 'AbortError') finish(id, { status: 'cancelled' });
    else finish(id, { status: 'error', error: error?.message || 'Download failed.' });
  }
}
