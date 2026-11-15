import { CLIENT_HEADER, CLIENT_PROTOCOL } from './clientVersion.js';
import { apiFetch, apiUrl } from './api.js';
// Browser upload client. Small files go in one request; larger ones are sliced from the File on disk
// (never read into memory as a whole) and sent as resumable chunks with retry.
import { MAX_TRANSFER_BYTES, UPLOAD_CHUNK_BYTES, uploadPlan } from './transfer.js';
import { createUploadQueue, uploadPriority } from './uploadQueue.js';
import { nativeSetUploads } from './native.js';
import { recordUsage } from './networkUsage.js';

const MAX_CHUNK_ATTEMPTS = 6;
const RETRY_BASE_MS = 800;
// A single-request upload (voice notes, photos, short videos) is tried this many times before it fails.
export const SINGLE_ATTEMPTS = 3;
// No bytes leaving for this long = the connection under the request is gone (a Wi-Fi <-> mobile data switch
// leaves it hanging forever otherwise): the request is dropped and retried.
export const STALL_MS = 20_000;
// Once every byte is sent, the server's answer is waited for this long.
export const RESPONSE_MS = 60_000;

/** On mobile data, as far as the browser can tell (Android WebView reports navigator.connection.type). */
export function onCellular(connection = typeof navigator === 'undefined' ? null : navigator.connection) {
  if (!connection) return false;
  return connection.type === 'cellular' || ['slow-2g', '2g', '3g'].includes(connection.effectiveType);
}

/** A failure worth another try: the network, a stall, or the server briefly unavailable. Not a refusal. */
export function retryableUpload(error, status) {
  if (isAbort(error)) return false;
  if (error) return true;
  return status === 408 || status === 429 || status >= 500;
}

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
  if (typeof XMLHttpRequest === 'undefined') return api(path, { sessionToken, signal, method, body, headers });
  return xhrSend(apiUrl(path), { signal, method, body, headers: { Authorization: 'Bearer ' + sessionToken, [CLIENT_HEADER]: String(CLIENT_PROTOCOL), ...headers }, onBytes })
    .then(({ status, text }) => {
      let data = {};
      try { data = status === 204 ? {} : JSON.parse(text || '{}'); } catch { data = {}; }
      return { response: { ok: status >= 200 && status < 300, status }, data };
    });
}

// One XMLHttpRequest with the stall watchdog; resolves { status, text, etag }. Used for the app's server and for
// the storage bucket (direct uploads), which gets no Authorization header: its URL is presigned.
function xhrSend(url, { signal, method, body, headers = {}, onBytes }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    // The watchdog: restarted by every progress event; after the last byte it waits for the answer instead.
    let stalled = false;
    let watchdog = null;
    const watch = (ms) => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => { stalled = true; xhr.abort(); }, ms);
    };
    const done = () => { clearTimeout(watchdog); signal?.removeEventListener('abort', abort); };
    xhr.open(method, url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => {
      watch(STALL_MS);
      if (event.lengthComputable) onBytes?.(event.loaded);
    };
    xhr.upload.onload = () => watch(RESPONSE_MS);
    const abort = () => xhr.abort();
    signal?.addEventListener('abort', abort, { once: true });
    xhr.onload = () => {
      done();
      try { resolve({ status: xhr.status, text: xhr.responseText, etag: xhr.getResponseHeader('ETag') }); } catch (error) { reject(error); }
    };
    xhr.onerror = () => { done(); reject(new TypeError('Network error during upload.')); };
    xhr.onabort = () => {
      done();
      reject(stalled ? new TypeError('The upload stalled.') : (signal?.reason ?? new DOMException('Aborted', 'AbortError')));
    };
    watch(STALL_MS);
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

// One request, tried up to SINGLE_ATTEMPTS times: a dropped or stalled connection, or the server briefly away, is
// retried after a short wait; a refusal (too large, not allowed) is not.
async function singleRequest(file, filename, options) {
  for (let attempt = 1; ; attempt += 1) {
    let outcome = null;
    let failure = null;
    try { outcome = await singleAttempt(file, filename, options); } catch (error) { failure = error; }
    if (outcome?.response.ok && outcome.data?.id) return outcome.data;
    const status = outcome?.response.status;
    if (attempt >= SINGLE_ATTEMPTS || !retryableUpload(failure, status)) {
      if (failure) throw failure;
      throw new Error(outcome?.data?.error || 'Upload failed.');
    }
    options.onProgress?.(0, file.size);
    await sleep(RETRY_BASE_MS * 2 ** (attempt - 1), options.signal);
  }
}

function singleAttempt(file, filename, { receiverId, groupId, sessionToken, signal, onProgress }) {
  return send(`/api/v1/media?${targetQuery({ receiverId, groupId })}`, {
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

async function chunkedUpload(file, filename, { receiverId, groupId, sessionToken, signal, onProgress, chunkBytes: wanted = UPLOAD_CHUNK_BYTES }) {
  const created = await api('/api/v1/uploads', {
    sessionToken, signal, method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(groupId ? { groupId } : { receiverId }), filename, contentType: file.type || '', byteSize: file.size }),
  });
  if (!created.response.ok || !created.data?.uploadId) throw new Error(created.data?.error || 'Upload could not start.');
  const { uploadId } = created.data;
  // The server's limit, or smaller pieces on mobile data (uploadPlan).
  const chunkBytes = Math.min(Number(created.data.chunkBytes) || UPLOAD_CHUNK_BYTES, wanted);
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

// --- Direct uploads to object storage (server/objectStore.mjs): the server signs, the bytes go to the bucket. ---

const CONFIG_TTL_MS = 10 * 60 * 1000;
const URL_MARGIN_MS = 60 * 1000;
let storageConfig = null;
/** Whether this server takes uploads straight into its bucket; asked once per 10 minutes, "no" on any failure. */
export async function uploadConfig(sessionToken, signal) {
  if (storageConfig && Date.now() - storageConfig.at < CONFIG_TTL_MS) return storageConfig;
  // At most 5 s: a slow answer must not hold the upload back (it then goes through the server as before).
  const ask = new AbortController();
  const timer = setTimeout(() => ask.abort(), 5000);
  const stop = () => ask.abort();
  signal?.addEventListener('abort', stop, { once: true });
  const result = await api('/api/v1/uploads/config', { sessionToken, signal: ask.signal }).catch(() => null);
  clearTimeout(timer);
  signal?.removeEventListener('abort', stop);
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  storageConfig = { direct: Boolean(result?.response.ok && result.data?.direct), at: Date.now() };
  return storageConfig;
}
export const forgetUploadConfig = () => { storageConfig = null; };

// PUT one part to its presigned URL; resolves { status, etag }.
function putPart(url, body, { signal, onBytes }) {
  if (typeof XMLHttpRequest !== 'undefined') return xhrSend(url, { signal, method: 'PUT', body, onBytes });
  return fetch(url, { method: 'PUT', body, signal }).then((response) => ({ status: response.status, etag: response.headers.get('etag') }));
}

async function directUpload(file, filename, { receiverId, groupId, sessionToken, signal, onProgress }) {
  const created = await api('/api/v1/uploads', {
    sessionToken, signal, method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(groupId ? { groupId } : { receiverId }), filename, contentType: file.type || '', byteSize: file.size, direct: true }),
  });
  if (!created.response.ok || !created.data?.uploadId) throw new Error(created.data?.error || 'Upload could not start.');
  const { uploadId } = created.data;
  const base = `/api/v1/uploads/${encodeURIComponent(uploadId)}`;
  if (!created.data.direct) {
    // The server stopped offering direct uploads: start over through the server.
    forgetUploadConfig();
    api(base, { sessionToken, method: 'DELETE' }).catch(() => {});
    return null;
  }
  const { partBytes, partCount } = created.data.direct;
  const urls = new Map();
  async function urlFor(partNumber) {
    const known = urls.get(partNumber);
    if (known && known.expiresAt - URL_MARGIN_MS > Date.now()) return known.url;
    const numbers = Array.from({ length: Math.min(20, partCount - partNumber + 1) }, (_, index) => partNumber + index);
    const signed = await api(`${base}/parts`, { sessionToken, signal, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ partNumbers: numbers }) });
    if (!signed.response.ok || !signed.data?.urls) {
      const error = new Error(signed.data?.error || 'Upload could not continue.');
      error.status = signed.response.status;
      throw error;
    }
    const expiresAt = Date.now() + (Number(signed.data.expiresIn) || 900) * 1000;
    for (const [number, url] of Object.entries(signed.data.urls)) urls.set(Number(number), { url, expiresAt });
    return urls.get(partNumber).url;
  }
  const parts = [];
  try {
    for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
      const start = (partNumber - 1) * partBytes;
      const end = Math.min(start + partBytes, file.size);
      for (let attempt = 1; ; attempt += 1) {
        let result = null;
        let failure = null;
        try {
          result = await putPart(await urlFor(partNumber), file.slice(start, end), {
            signal, onBytes: onProgress ? (loaded) => onProgress(Math.min(start + loaded, file.size - 1), file.size) : null,
          });
        } catch (error) {
          if (isAbort(error)) throw error;
          if ([400, 401, 404, 409].includes(error.status)) throw error;
          failure = error;
        }
        if (result && result.status >= 200 && result.status < 300 && result.etag) {
          parts.push({ partNumber, etag: result.etag });
          onProgress?.(end, file.size);
          break;
        }
        // A 2xx without an ETag means the bucket's CORS rule does not expose it: retrying cannot help.
        if (result && result.status >= 200 && result.status < 300) throw new Error('The storage bucket hides upload receipts (ETag). Ask the administrator to expose it in CORS.');
        if (result?.status === 403) urls.delete(partNumber); // expired link: ask for a fresh one
        else if (result && !retryableUpload(null, result.status)) throw new Error('Upload failed.');
        if (attempt >= MAX_CHUNK_ATTEMPTS) throw failure ?? new Error('Upload failed after several retries. Check your connection and try again.');
        await sleep(RETRY_BASE_MS * 2 ** (attempt - 1), signal);
      }
    }
    const completed = await api(`${base}/complete`, { sessionToken, signal, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parts }) });
    if (!completed.response.ok || !completed.data?.id) throw new Error(completed.data?.error || 'Upload could not be completed.');
    return completed.data;
  } catch (error) {
    // Free the bucket's partial upload (the stale sweep covers a lost connection).
    apiFetch(base, { method: 'DELETE', headers: { Authorization: 'Bearer ' + sessionToken }, keepalive: true }).catch(() => {});
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
// Three at once, as the chat queues them (ChatWindow UPLOAD_PARALLEL): picked photos go up together.
const uploadQueue = createUploadQueue({ concurrency: 3, onChange: reportUploads });

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

async function uploadFileNow(file, { receiverId, groupId, sessionToken, signal, onProgress, usage = 'media' } = {}) {
  const filename = file.name || 'attachment';
  const sizeError = uploadSizeError(filename, file.size);
  if (sizeError) throw new Error(sizeError);
  if (!sessionToken) throw new Error('Sign in again to share attachments.');
  const plan = uploadPlan(file.size, { cellular: onCellular() });
  onProgress?.(0, file.size);
  const direct = (await uploadConfig(sessionToken, signal)).direct
    ? await directUpload(file, filename, { receiverId, groupId, sessionToken, signal, onProgress })
    : null;
  const result = direct ?? (plan.chunked
    ? await chunkedUpload(file, filename, { receiverId, groupId, sessionToken, signal, onProgress, chunkBytes: plan.chunkBytes })
    : await singleRequest(file, filename, { receiverId, groupId, sessionToken, signal, onProgress }));
  onProgress?.(file.size, file.size);
  // Network usage: a status photo or video counts under Status, everything else under Media.
  recordUsage(usage === 'status' ? 'status' : 'media', { sent: file.size });
  return result;
}
