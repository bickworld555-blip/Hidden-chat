import { apiFetch } from './api.js';
// People lookup and chat links, shared by the chat list, sidebar and contact picker.

async function readJson(response, fallback) {
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || fallback);
  return data;
}

// People are found by their exact @username only (no prefixes, no display names), so nobody can list accounts.
export const USERNAME_SHAPE = /^[a-z0-9_]{3,24}$/;
/** The handle a search box holds ("@Rahim_42 " -> "rahim_42"), or '' when it can't be a whole username. */
export function handleFrom(query) {
  const handle = String(query ?? '').trim().replace(/^@/, '').toLowerCase();
  return USERNAME_SHAPE.test(handle) ? handle : '';
}

/** The person with exactly this @username, or null. The name goes in the body, never in a URL. */
export async function lookupUsername(sessionToken, query, { signal } = {}) {
  const username = handleFrom(query);
  if (!username) return null;
  const response = await apiFetch('/api/v1/users/lookup', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + sessionToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
    signal,
  });
  if (response.status === 404) return null;
  const data = await readJson(response, 'Finding people is unavailable right now.');
  return data?.user ?? null;
}

// Invite links (Invite a friend): https://<site>/c#<token>; the token after "#" never reaches a web server.
export async function createInviteLink(sessionToken, { uses = 1 } = {}) {
  const response = await apiFetch('/api/v1/connect/tokens', {
    method: 'POST', headers: { Authorization: 'Bearer ' + sessionToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ uses }),
  });
  return readJson(response, 'Could not make an invite link.');
}
export async function listInviteLinks(sessionToken) {
  const response = await apiFetch('/api/v1/connect/tokens', { headers: { Authorization: 'Bearer ' + sessionToken } });
  const links = await readJson(response, 'Could not load your invite links.');
  return Array.isArray(links) ? links : [];
}
export async function revokeInviteLink(sessionToken, id) {
  const response = await apiFetch(`/api/v1/connect/tokens/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + sessionToken } });
  if (!response.ok && response.status !== 204) await readJson(response, 'Could not revoke the link.');
}
/** The token in an invite link (…/c#<token>, hiddenmessenger://c#<token>) or a bare token; '' if there is none. */
export function inviteTokenFrom(text) {
  return /(?:\/c\/?#|^)([A-Za-z0-9_-]{22})$/.exec(String(text ?? '').trim())?.[1] ?? '';
}
export async function redeemInviteLink(sessionToken, token) {
  const response = await apiFetch('/api/v1/connect/redeem', {
    method: 'POST', headers: { Authorization: 'Bearer ' + sessionToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
  });
  return (await readJson(response, 'This invite link could not be opened.')).user;
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
