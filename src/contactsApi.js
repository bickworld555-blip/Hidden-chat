import { apiFetch } from './api.js';
// People lookup and chat links, shared by the chat list, sidebar and contact picker.

async function readJson(response, fallback) {
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || fallback);
  return data;
}

export async function searchPeople(sessionToken, query, { signal } = {}) {
  const response = await apiFetch(`/api/v1/contacts/search?q=${encodeURIComponent(query)}`, {
    headers: { Authorization: 'Bearer ' + sessionToken },
    signal,
  });
  const results = await readJson(response, 'Contact search is unavailable.');
  return Array.isArray(results) ? results : [];
}

// Opens a thread with `userId`. `save: true` also adds them to the contact book; `save: false` is a direct chat.
export async function linkContact(sessionToken, userId, { save = true } = {}) {
  const response = await apiFetch('/api/v1/contacts', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + sessionToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, save }),
  });
  return readJson(response, save ? 'Could not add this contact.' : 'Could not start this chat.');
}
