// The Help Center articles (public) and the person's conversation with Hidden Messenger Support (server/support.mjs,
// server/admin.mjs). Support messages are not end-to-end encrypted: the support team reads them.
import { apiFetch } from './api.js';

export const SUPPORT_MESSAGE_MAX = 2000;
// Fired on window when a support message arrives over the live connection (App.jsx): detail is the message.
export const SUPPORT_EVENT = 'hm-support-message';
// Fired on window once the support chat has been read (the chat list's pinned row clears its unread count).
export const SUPPORT_READ_EVENT = 'hm-support-read';
// The official account's name, as the chat list and the chat header show it.
export const SUPPORT_NAME = 'Hidden Messenger';

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
/** { messages, replies: 'open' | 'closed' } — closed while the chat holds only campaigns (read-only announcements). */
/** Delete chat: the official chat's messages so far leave this account's view on every device. */
export const deleteSupportChat = (token) => call('/api/v1/support/messages', { token, method: 'DELETE' });
export const fetchSupportChat = (token) => call('/api/v1/support/messages', { token });
export const fetchSupportMessages = (token) => fetchSupportChat(token).then((data) => data.messages);
/** The pinned row: { last: { preview, fromSupport, createdAt } | null, unread }. Marks nothing read. */
export const fetchSupportSummary = (token) => call('/api/v1/support/summary', { token });
// `start`: a new request for help (Contact support), which opens a conversation even where only campaigns arrived.
export const sendSupportMessage = (token, body, { start = false } = {}) => call('/api/v1/support/messages', { token, method: 'POST', body: { body, ...(start ? { start: true } : {}) } });

/** Adds or replaces a message (by id) and keeps the conversation in time order. */
export function mergeSupportMessage(messages, message) {
  const rest = messages.filter((item) => item.id !== message.id);
  return [...rest, message].sort((a, b) => a.createdAt - b.createdAt);
}
