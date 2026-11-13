// About: a short line under your name (Settings), and someone else's in their Contact info when their About privacy
// (Privacy › About) lets you see it. server/index.mjs /api/v1/me/about and /api/v1/users/:id/about.
import { apiFetch } from './api.js';

export const ABOUT_MAX = 139;
// WhatsApp's ready-made lines, offered when editing.
export const ABOUT_SUGGESTIONS = Object.freeze(['Available', 'Busy', 'At work', 'In a meeting', 'Battery about to die', 'Can’t talk, message only', 'Sleeping', 'Urgent calls only']);

async function request(path, sessionToken, init = {}) {
  const response = await apiFetch(path, { ...init, headers: { Authorization: `Bearer ${sessionToken}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Could not load About.');
  return data;
}

export const fetchMyAbout = (sessionToken) => request('/api/v1/me/about', sessionToken).then((data) => data.about ?? '');
export const saveMyAbout = (sessionToken, about) => request('/api/v1/me/about', sessionToken, { method: 'PUT', body: JSON.stringify({ about }) }).then((data) => data.about ?? '');
/** Someone's About, or null when their privacy hides it from you. */
export const fetchAbout = (sessionToken, userId) => request(`/api/v1/users/${encodeURIComponent(userId)}/about`, sessionToken).then((data) => data.about ?? null);
