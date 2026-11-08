import { apiFetch } from './api.js';
// Display name rules shared by the server and the browser. The @handle is the permanent identity;
// the display name is what people see and can be changed any time.

export const MAX_DISPLAY_NAME = 40;

export function normalizeDisplayName(raw) {
  return String(raw ?? '').replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim();
}

export function displayNameError(raw) {
  const name = normalizeDisplayName(raw);
  if (!name) return 'Enter a display name.';
  if (name.length > MAX_DISPLAY_NAME) return `Display names can be up to ${MAX_DISPLAY_NAME} characters.`;
  return '';
}

// Two letters: first letters of the first two words, or the first two letters of a single word.
export function initialsFor(name, username = '') {
  const source = normalizeDisplayName(name).replace(/^@/, '') || String(username ?? '');
  const words = source.split(' ').filter(Boolean);
  const letters = words.length >= 2 ? words[0][0] + words[1][0] : source.slice(0, 2);
  return (letters || '??').toUpperCase();
}

// Whether a profile still shows the auto-generated "@handle" as its name.
export function hasCustomDisplayName(user) {
  if (!user?.name) return false;
  return normalizeDisplayName(user.name).toLowerCase() !== `@${String(user.username ?? '').toLowerCase()}`;
}

export async function updateDisplayName(name, sessionToken) {
  const error = displayNameError(name);
  if (error) throw new Error(error);
  const response = await apiFetch('/api/v1/me', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + sessionToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: normalizeDisplayName(name) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.user) throw new Error(data?.error || 'Could not update your name.');
  return data.user;
}

export function presentName(user) {
  return hasCustomDisplayName(user) ? user.name : (user?.username ? `@${user.username}` : user?.name ?? '');
}
