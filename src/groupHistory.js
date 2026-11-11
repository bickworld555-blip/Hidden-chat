// A group's message history, opened (Sender Keys, src/e2e/client.js). Used by the group screen and by search
// across chats, so both read group messages the same way.
import { apiFetch } from './api.js';
import { openGroupMessages } from './e2e/client.js';

export async function fetchGroupMessages(token, groupId, { signal } = {}) {
  const response = await apiFetch(`/api/v1/groups/${encodeURIComponent(groupId)}/messages`, { headers: { Authorization: `Bearer ${token}` }, signal });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const error = new Error(data.error || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return openGroupMessages(groupId, await response.json());
}
