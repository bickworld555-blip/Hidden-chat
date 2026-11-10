import { apiFetch } from './api.js';

// Account endpoints: last-seen privacy, password, and linked devices (signed-in sessions).
async function request(sessionToken, path, { method = 'GET', body } = {}) {
  const response = await apiFetch(path, {
    method,
    headers: { Authorization: 'Bearer ' + sessionToken, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.error ?? 'Something went wrong. Please try again.');
  }
  return response.status === 204 ? null : response.json();
}

export const LAST_SEEN_OPTIONS = Object.freeze([
  { id: 'everyone', label: 'Everyone' },
  { id: 'contacts', label: 'My contacts' },
  { id: 'nobody', label: 'Nobody' },
]);

export const lastSeenLabel = (id) => LAST_SEEN_OPTIONS.find((option) => option.id === id)?.label ?? 'Everyone';

export const getPrivacy = (sessionToken) => request(sessionToken, '/api/v1/me/privacy');
export const setLastSeenPrivacy = (sessionToken, lastSeen) => request(sessionToken, '/api/v1/me/privacy', { method: 'PUT', body: { lastSeen } });
// Any privacy settings at once ({ lastSeen?, online?, profilePhoto?, readReceipts? }); answers with all of them.
export const setPrivacy = (sessionToken, patch) => request(sessionToken, '/api/v1/me/privacy', { method: 'PUT', body: patch });
export const changePassword = (sessionToken, currentPassword, newPassword) =>
  request(sessionToken, '/api/v1/me/password', { method: 'PUT', body: { currentPassword, newPassword } });
export const listDevices = (sessionToken) => request(sessionToken, '/api/v1/me/sessions');
export const signOutDevice = (sessionToken, deviceId) =>
  request(sessionToken, `/api/v1/me/sessions/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
