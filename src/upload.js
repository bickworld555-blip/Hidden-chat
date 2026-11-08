import { apiFetch } from './api.js';
// Browser upload client. Small files go in one request; larger ones are sliced from the File on disk
// (never read into memory as a whole) and sent as resumable chunks with retry.
import { MAX_TRANSFER_BYTES, UPLOAD_CHUNK_BYTES, uploadPlan } from './transfer.js';

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

async function singleRequest(file, filename, { receiverId, groupId, sessionToken, signal }) {
  const response = await apiFetch(`/api/v1/media?${targetQuery({ receiverId, groupId })}`, {
    method: 'POST',
    signal,
    headers: {
      Authorization: 'Bearer ' + sessionToken,
      // The browser's type for the file; the server falls back to the extension when this is empty or generic.
      'Content-Type': file.type || 'application/octet-stream',
      'X-File-Name': encodeURIComponent(filename),
    },
    body: file,
  });
  const data = await response.json().catch(() => ({}));
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
        result = await api(`/api/v1/uploads/${encodeURIComponent(uploadId)}`, {
          sessionToken, signal, method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream', 'X-Upload-Offset': String(offset) },
          body: file.slice(offset, end),
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

// Resolves to { id, filename, contentType, byteSize } once the server has the whole file.
export async function uploadFile(file, { receiverId, groupId, sessionToken, signal, onProgress } = {}) {
  const filename = file.name || 'attachment';
  const sizeError = uploadSizeError(filename, file.size);
  if (sizeError) throw new Error(sizeError);
  if (!sessionToken) throw new Error('Sign in again to share attachments.');
  const plan = uploadPlan(file.size);
  onProgress?.(0, file.size);
  const result = plan.chunked
    ? await chunkedUpload(file, filename, { receiverId, groupId, sessionToken, signal, onProgress })
    : await singleRequest(file, filename, { receiverId, groupId, sessionToken, signal });
  onProgress?.(file.size, file.size);
  return result;
}
