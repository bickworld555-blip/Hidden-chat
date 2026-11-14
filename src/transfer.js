// Transfer limits shared by the server and the browser so both sides agree on what a file can be.

export const GIB = 1024 ** 3;
export const MIB = 1024 ** 2;

// Largest file that can be shared. Files are streamed to disk in chunks, never held in memory.
export const MAX_TRANSFER_BYTES = 100 * GIB;

// Size of each upload request; also the cutoff below which a file is sent in one request.
export const UPLOAD_CHUNK_BYTES = 8 * MIB;

// Above this a file is downloaded straight to disk and played by streaming; below it the bytes may be
// fetched into memory for inline previews.
export const PREVIEW_LIMIT_BYTES = 200 * MIB;

// Validity of a one-off download link; browsers resume large downloads with range requests within it.
export const DOWNLOAD_LINK_TTL_MS = 15 * 60 * 1000;

// Unfinished uploads untouched for this long are discarded.
export const UPLOAD_STALE_MS = 24 * 60 * 60 * 1000;

// On mobile data a network switch or a weak uplink loses whatever request is in flight. Anything above
// CELLULAR_RESUMABLE_BYTES then goes up resumably in CELLULAR_CHUNK_BYTES pieces (about 8 s each at 1 Mbit/s),
// so a drop costs one small piece, not the whole file.
export const CELLULAR_RESUMABLE_BYTES = MIB;
export const CELLULAR_CHUNK_BYTES = MIB;

export function uploadPlan(byteSize, { cellular = false } = {}) {
  if (!Number.isInteger(byteSize) || byteSize <= 0) return { ok: false, reason: 'empty' };
  if (byteSize > MAX_TRANSFER_BYTES) return { ok: false, reason: 'too-large' };
  const chunkBytes = cellular ? CELLULAR_CHUNK_BYTES : UPLOAD_CHUNK_BYTES;
  const chunked = byteSize > (cellular ? CELLULAR_RESUMABLE_BYTES : UPLOAD_CHUNK_BYTES);
  return { ok: true, chunked, chunkBytes, chunks: chunked ? Math.ceil(byteSize / chunkBytes) : 1 };
}
