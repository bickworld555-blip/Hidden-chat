import { apiFetch, apiUrl } from './api.js';
// Browser upload client. Small files go in one request; larger ones are sliced from the File on disk
// (never read into memory as a whole) and sent as resumable chunks with retry.
import { MAX_TRANSFER_BYTES, UPLOAD_CHUNK_BYTES, uploadPlan } from './transfer.js';
import { createUploadQueue, uploadPriority } from './uploadQueue.js';
import { nativeSetUploads } from './native.js';

const MAX_CHUNK_ATTEMPTS = 6;
const RETRY_BASE_MS = 800;

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
}

function isAbort(error) {
  return error?.name === 'AbortError';
}

// fetch() cannot report upload progress, so a whole chunk (up to 8 MB — a minute on a slow uplink) looked stuck
// at 0%. In the browser, requests that carry a body go through XMLHttpRequest and report bytes as they leave.
// Returns the same { response: { ok, status }, data } shape as api(); falls back to fetch where XHR is missing.
function send(path, { sessionToken, signal, method, body, headers = {}, onBytes }) {
  if (typeof XMLHttpRequest === 'undefined' || !onBytes) return api(path, { sessionToken, signal, method, body, headers });
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, apiUrl(path));
    xhr.setRequestHeader('Authorization', 'Bearer ' + sessionToken);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) onBytes(event.loaded); };
    const abort = () => xhr.abort();
    signal?.addEventListener('abort', abort, { once: true });
    xhr.onload = () => {
      signal?.removeEventListener('abort', abort);
      let data = {};
      try { data = xhr.status === 204 ? {} : JSON.parse(xhr.responseText || '{}'); } catch { data = {}; }
      resolve({ response: { ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status }, data });
    };
    xhr.onerror = () => { signal?.removeEventListener('abort', abort); reject(new TypeError('Network error during upload.')); };
    xhr.onabort = () => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    xhr.send(body);
  });
}

export function uploadSizeError(filename, byteSize) {
  const plan = uploadPlan(byteSize);
  if (plan.ok) return '';
  if (plan.reason === 'empty') return `"${filename}" is empty.`;
  return `"${filename}" is larger than ${MAX_TRANSFER_BYTES / 1024 ** 3} GB.`;
}

// The upload target is one direct chat (receiverId) or one group (groupId); the server rejects both or neither.
function targetQuery({ receiverId, groupId }) {
  return groupId ? `groupId=${encodeURIComponent(groupId)}` : `receiverId=${encodeURIComponent(receiverId)}`;
}

async function singleRequest(file, filename, { receiverId, groupId, sessionToken, signal, onProgress }) {
  const { response, data } = await send(`/api/v1/media?${targetQuery({ receiverId, groupId })}`, {
    sessionToken,
    signal,
    method: 'POST',
    headers: {
      // The browser's type for the file; the server falls back to the extension when this is empty or generic.
      'Content-Type': file.type || 'application/octet-stream',
      'X-File-Name': encodeURIComponent(filename),
    },
    body: file,
    onBytes: onProgress ? (loaded) => onProgress(Math.min(loaded, file.size - 1), file.size) : null,
  });
  if (!response.ok || !data?.id) throw new Error(data?.error || 'Upload failed.');
  return data;
}

async function api(path, { sessionToken, signal, method = 'GET', body, headers = {} }) {
  const response = await apiFetch(path, {
    method,
    signal,
    headers: { Authorization: 'Bearer ' + sessionToken, ...headers },
    body,
  });
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  return { response, data };
}

async function chunkedUpload(file, filename, { receiverId, groupId, sessionToken, signal, onProgress }) {
  const created = await api('/api/v1/uploads', {
    sessionToken, signal, method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(groupId ? { groupId } : { receiverId }), filename, contentType: file.type || '', byteSize: file.size }),
  });
  if (!created.response.ok || !created.data?.uploadId) throw new Error(created.data?.error || 'Upload could not start.');
  const { uploadId } = created.data;
  const chunkBytes = Number(created.data.chunkBytes) || UPLOAD_CHUNK_BYTES;
  let offset = Number(created.data.received) || 0;
  let attempts = 0;

  try {
    while (offset < file.size) {
      const end = Math.min(offset + chunkBytes, file.size);
      let result;
      try {
        const chunkStart = offset;
        result = await send(`/api/v1/uploads/${encodeURIComponent(uploadId)}`, {
          sessionToken, signal, method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream', 'X-Upload-Offset': String(offset) },
          body: file.slice(offset, end),
          onBytes: onProgress ? (loaded) => onProgress(Math.min(chunkStart + loaded, file.size - 1), file.size) : null,
        });
      } catch (error) {
        if (isAbort(error)) throw error;
        result = null;
      }
      if (result?.response.ok) {
        offset = Number(result.data.received);
        attempts = 0;
        onProgress?.(offset, file.size);
        continue;
      }
      if (result && [400, 401, 404, 413].includes(result.response.status)) {
        throw new Error(result.data?.error || 'Upload failed.');
      }
      // Network error, server restart or offset mismatch: ask where the server is and continue from there.
      attempts += 1;
      if (attempts > MAX_CHUNK_ATTEMPTS) throw new Error('Upload failed after several retries. Check your connection and try again.');
      if (Number.isInteger(result?.data?.received)) {
        offset = result.data.received;
      } else {
        await sleep(RETRY_BASE_MS * 2 ** (attempts - 1), signal);
        const status = await api(`/api/v1/uploads/${encodeURIComponent(uploadId)}`, { sessionToken, signal }).catch(() => null);
        if (status?.response.status === 404) throw new Error('The upload was discarded by the server. Please send the file again.');
        if (status?.response.ok && Number.isInteger(status.data.received)) offset = status.data.received;
      }
    }
    const completed = await api(`/api/v1/uploads/${encodeURIComponent(uploadId)}/complete`, { sessionToken, signal, method: 'POST' });
    if (!completed.response.ok || !completed.data?.id) throw new Error(completed.data?.error || 'Upload could not be completed.');
    return completed.data;
  } catch (error) {
    if (isAbort(error)) {
      // Best effort: free the partial file on the server; the stale sweep covers a lost connection.
      apiFetch(`/api/v1/uploads/${encodeURIComponent(uploadId)}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + sessionToken }, keepalive: true }).catch(() => {});
    }
    throw error;
  }
}

// Android: while anything uploads, a foreground "Sending…" notification keeps the app alive in the background.
// Reported at most once a second while running, and at once when the queue empties.
const NATIVE_REPORT_MS = 1000;
let lastNativeReport = 0;
let pendingNativeReport = null;
function reportUploads(state) {
  clearTimeout(pendingNativeReport);
  const send = () => {
    lastNativeReport = Date.now();
    nativeSetUploads({ count: state.count, label: state.label, progress: Math.round(state.progress * 100) });
  };
  if (state.count === 0 || Date.now() - lastNativeReport >= NATIVE_REPORT_MS) send();
  else pendingNativeReport = setTimeout(send, NATIVE_REPORT_MS);
}
const uploadQueue = createUploadQueue({ concurrency: 2, onChange: reportUploads });

/**
 * Resolves to { id, filename, contentType, byteSize } once the server has the whole file. Uploads wait in a
 * priority queue (voice notes and small files first; `priority` or `kind: 'voice'` override the size rule).
 */
export function uploadFile(file, options = {}) {
  const { priority, kind, signal, onProgress } = options;
  return uploadQueue.enqueue((report) => {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    return uploadFileNow(file, { ...options, onProgress: (done, total) => { report(done); onProgress?.(done, total); } });
  }, { priority: priority ?? uploadPriority({ size: file?.size ?? 0, kind }), label: file?.name || 'attachment', size: file?.size ?? 0 });
}

async function uploadFileNow(file, { receiverId, groupId, sessionToken, signal, onProgress } = {}) {
  const filename = file.name || 'attachment';
  const sizeError = uploadSizeError(filename, file.size);
  if (sizeError) throw new Error(sizeError);
  if (!sessionToken) throw new Error('Sign in again to share attachments.');
  const plan = uploadPlan(file.size);
  onProgress?.(0, file.size);
  const result = plan.chunked
    ? await chunkedUpload(file, filename, { receiverId, groupId, sessionToken, signal, onProgress })
    : await singleRequest(file, filename, { receiverId, groupId, sessionToken, signal, onProgress });
  onProgress?.(file.size, file.size);
  return result;
}
