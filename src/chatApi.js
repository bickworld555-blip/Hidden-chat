import { apiFetch } from './api.js';
// Server-side chat management. The server hides the messages for this user and broadcasts the change to all of
// their devices; the local store applies it right away so the UI does not wait for the round trip.
async function postChatAction(sessionToken, peerId, action, body) {
  const response = await apiFetch(`/api/v1/chats/${encodeURIComponent(peerId)}/${action}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + sessionToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.error ?? `Could not ${action} this chat.`);
  }
  return response.json();
}

export function clearChatOnServer(sessionToken, peerId, keepIds = []) {
  return postChatAction(sessionToken, peerId, 'clear', { keepIds });
}

export function deleteChatOnServer(sessionToken, peerId) {
  return postChatAction(sessionToken, peerId, 'delete');
}
