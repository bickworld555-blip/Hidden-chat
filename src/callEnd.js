import { apiFetch } from './api.js';

// Ending a call is sent twice on purpose: the "end" signal over the socket (fast, the normal path) and this
// HTTP request (reliable). The HTTP copy reaches the server even when the socket has just dropped, the app is
// going to the background, or the page is closing (keepalive), so the other side never keeps ringing or waiting.
// The server ends a call once; the later copy answers 404, which is fine.
export function endCallOverHttp(callId, sessionToken, fetchImpl = apiFetch) {
  if (!callId || !sessionToken) return Promise.resolve(false);
  return Promise.resolve()
    .then(() => fetchImpl(`/api/v1/calls/${encodeURIComponent(callId)}/end`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessionToken}` },
      keepalive: true,
    }))
    .then((response) => response.status === 204)
    .catch(() => false);
}

/** Every call id a call screen owns: the main pair and each extra pair of a group call. */
export function ownedCallIds(callId, extraEntries = []) {
  return [...new Set([callId, ...extraEntries.map((entry) => entry.callId)].filter(Boolean))];
}
