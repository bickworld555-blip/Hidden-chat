// The Help Center articles (public) and the person's conversation with Hidden Messenger Support (server/support.mjs,
// server/admin.mjs). Support messages are not end-to-end encrypted: the support team reads them.
import { apiFetch } from './api.js';

export const SUPPORT_MESSAGE_MAX = 2000;
// Fired on window when a support message arrives over the live connection (App.jsx): detail is the message.
export const SUPPORT_EVENT = 'hm-support-message';

async function call(path, { token, method = 'GET', body } = {}) {
  const response = await apiFetch(path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error ?? 'Something went wrong. Please try again.');
  return data;
}

export const fetchHelp = (query = '') => call(`/api/v1/help${query ? `?q=${encodeURIComponent(query)}` : ''}`);
export const fetchArticle = (slug) => call(`/api/v1/help/${encodeURIComponent(slug)}`);
export const fetchSupportMessages = (token) => call('/api/v1/support/messages', { token }).then((data) => data.messages);
export const sendSupportMessage = (token, body) => call('/api/v1/support/messages', { token, method: 'POST', body: { body } });

/** Adds or replaces a message (by id) and keeps the conversation in time order. */
export function mergeSupportMessage(messages, message) {
  const rest = messages.filter((item) => item.id !== message.id);
  return [...rest, message].sort((a, b) => a.createdAt - b.createdAt);
}
