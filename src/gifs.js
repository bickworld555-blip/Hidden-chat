// GIF search (server/gifs.mjs): everything goes through our server, so GIPHY never sees this device. A picked GIF
// is downloaded the same way and sent as an ordinary end-to-end encrypted attachment.
import { apiFetch } from './api.js';

const auth = (token) => ({ headers: { Authorization: `Bearer ${token}` } });
let status = null;

/** Whether the server offers GIF search (asked once per session). */
export function gifSearchEnabled(token) {
  if (!token) return Promise.resolve(false);
  status ??= apiFetch('/api/v1/gifs/status', auth(token))
    .then((response) => (response.ok ? response.json() : { enabled: false }))
    .then((body) => Boolean(body?.enabled))
    .catch(() => { status = null; return false; });
  return status;
}

/** { gifs: [{ id, title, width, height, preview, full }], next, attribution }; an empty query lists trending. */
export async function searchGifs(token, query, offset = 0, { signal } = {}) {
  const params = new URLSearchParams({ offset: String(offset) });
  if (query.trim()) params.set('q', query.trim());
  const response = await apiFetch(`/api/v1/gifs/search?${params}`, { ...auth(token), signal });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'GIF search is unavailable right now.');
  return body;
}

/** The GIF's bytes, through our server. */
export async function loadGif(token, url, { signal } = {}) {
  const response = await apiFetch(`/api/v1/gifs/media?u=${encodeURIComponent(url)}`, { ...auth(token), signal });
  if (!response.ok) throw new Error('That GIF could not be loaded.');
  return response.blob();
}

/** The GIF to send, as a file. */
export async function gifFile(token, gif, options) {
  const blob = await loadGif(token, gif.full, options);
  const type = blob.type === 'image/webp' ? 'image/webp' : 'image/gif';
  return new File([blob], `GIF-${gif.id}.${type === 'image/webp' ? 'webp' : 'gif'}`, { type });
}
