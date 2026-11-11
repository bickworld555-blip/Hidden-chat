// Requests from the standalone admin page to /api/admin/v1. The admin session is an HttpOnly cookie the server
// set at sign-in (server/adminAuth.mjs); this page never sees or stores a token. Every request carries the
// X-HM-Admin header the server requires, which a cross-site form or link can't send.
export const ADMIN_API = '/api/admin/v1';
export const SIGNED_OUT_EVENT = 'hm-admin-signed-out';

export class AdminApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function adminRequest(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'X-HM-Admin': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const parsed = response.status === 204 ? null : await response.json().catch(() => null);
  if (response.status === 401) window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
  if (!response.ok) throw new AdminApiError(parsed?.error ?? 'Something went wrong. Please try again.', response.status);
  return parsed;
}

export const adminSession = () => adminRequest(`${ADMIN_API}/session`);
export const adminSignIn = (username, password) => adminRequest(`${ADMIN_API}/login`, { method: 'POST', body: { username, password } });
export const adminSignOut = () => adminRequest(`${ADMIN_API}/logout`, { method: 'POST' });
