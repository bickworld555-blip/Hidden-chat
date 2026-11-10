// Client for the WhatsApp (Business) parity endpoints (server/parity.mjs).
import { apiFetch } from './api.js';
import { openDirectMessage, openGroupMessage, sendDirectContent, sendGroupContent } from './e2e/client.js';

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export async function request(sessionToken, path, { method = 'GET', body, raw, contentType } = {}) {
  const headers = { Authorization: `Bearer ${sessionToken}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (raw && contentType) headers['Content-Type'] = contentType;
  const response = await apiFetch(path, { method, headers, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  const parsed = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(parsed?.error ?? 'Something went wrong. Please try again.', response.status, parsed);
  return parsed;
}

const enc = encodeURIComponent;

// Message edits.
// The new text is sealed end-to-end like a new message (src/e2e/client.js), re-sealed if the device list changed.
export const editDirectMessage = (token, messageId, content, peerId) => sendDirectContent(peerId, content,
  (sealed) => request(token, `/api/v1/messages/${enc(messageId)}`, { method: 'PUT', body: { content: sealed } }));
export const editGroupMessage = (token, groupId, messageId, content) => sendGroupContent(groupId, content,
  (sealed) => request(token, `/api/v1/groups/${enc(groupId)}/messages/${enc(messageId)}`, { method: 'PUT', body: { content: sealed } }));

// Stars, archive, pins.
// Starred messages come back as the server stores them: end-to-end encrypted ones are opened on this device.
export const listStars = async (token) => {
  const items = await request(token, '/api/v1/stars');
  const out = [];
  for (const item of items ?? []) out.push(item.groupId ? await openGroupMessage(item.groupId, item) : await openDirectMessage(item));
  return out;
};
export const setStar = (token, messageId, starred) => request(token, `/api/v1/stars/${enc(messageId)}`, { method: starred ? 'PUT' : 'DELETE' });
export const getChatPrefs = (token) => request(token, '/api/v1/chat-prefs');
export const setArchived = (token, chatKey, archived) => request(token, `/api/v1/chat-prefs/${enc(chatKey)}`, { method: 'PUT', body: { archived } });
export const listPins = (token, chatKey) => request(token, `/api/v1/pins/${enc(chatKey)}`);
export const setPinned = (token, chatKey, messageId, pinned) => request(token, `/api/v1/pins/${enc(chatKey)}/${enc(messageId)}`, { method: pinned ? 'PUT' : 'DELETE' });

// Group administration.
const group = (groupId) => `/api/v1/groups/${enc(groupId)}`;
export const updateGroupInfo = (token, groupId, info) => request(token, `${group(groupId)}/info`, { method: 'PUT', body: info });
export const updateGroupPermissions = (token, groupId, permissions) => request(token, `${group(groupId)}/permissions`, { method: 'PUT', body: permissions });
export const setMemberRole = (token, groupId, userId, role) => request(token, `${group(groupId)}/members/${enc(userId)}/role`, { method: 'PUT', body: { role } });
export const removeMember = (token, groupId, userId) => request(token, `${group(groupId)}/members/${enc(userId)}`, { method: 'DELETE' });
export const resetInvite = (token, groupId) => request(token, `${group(groupId)}/invite`, { method: 'POST' });
export const revokeInvite = (token, groupId) => request(token, `${group(groupId)}/invite`, { method: 'DELETE' });
export const listJoinRequests = (token, groupId) => request(token, `${group(groupId)}/requests`);
export const answerJoinRequest = (token, groupId, userId, approve) => request(token, `${group(groupId)}/requests/${enc(userId)}`, { method: 'POST', body: { approve } });
export const previewInvite = (token, code) => request(token, `/api/v1/invites/${enc(code)}`);
export const joinInvite = (token, code) => request(token, `/api/v1/invites/${enc(code)}/join`, { method: 'POST' });
export const cancelJoinRequest = (token, code) => request(token, `/api/v1/invites/${enc(code)}/request`, { method: 'DELETE' });

// Communities.
export const listCommunities = (token) => request(token, '/api/v1/communities');
export const getCommunity = (token, id) => request(token, `/api/v1/communities/${enc(id)}`);
export const createCommunity = (token, details) => request(token, '/api/v1/communities', { method: 'POST', body: details });
export const updateCommunity = (token, id, details) => request(token, `/api/v1/communities/${enc(id)}`, { method: 'PUT', body: details });
export const deleteCommunity = (token, id) => request(token, `/api/v1/communities/${enc(id)}`, { method: 'DELETE' });
export const addCommunityGroup = (token, id, body) => request(token, `/api/v1/communities/${enc(id)}/groups`, { method: 'POST', body });
export const removeCommunityGroup = (token, id, groupId) => request(token, `/api/v1/communities/${enc(id)}/groups/${enc(groupId)}`, { method: 'DELETE' });
export const joinCommunityGroup = (token, id, groupId) => request(token, `/api/v1/communities/${enc(id)}/groups/${enc(groupId)}/join`, { method: 'POST' });

// Business suite.
export const listCatalog = (token, userId) => request(token, `/api/v1/users/${enc(userId)}/catalog`);
export const getCatalogItem = (token, itemId) => request(token, `/api/v1/catalog/${enc(itemId)}`);
export const createCatalogItem = (token, item) => request(token, '/api/v1/catalog', { method: 'POST', body: item });
export const updateCatalogItem = (token, itemId, item) => request(token, `/api/v1/catalog/${enc(itemId)}`, { method: 'PUT', body: item });
export const deleteCatalogItem = (token, itemId) => request(token, `/api/v1/catalog/${enc(itemId)}`, { method: 'DELETE' });
export const uploadCatalogImage = (token, itemId, blob) => request(token, `/api/v1/catalog/${enc(itemId)}/image`, { method: 'PUT', raw: blob, contentType: blob.type || 'application/octet-stream' });
export const listLabels = (token) => request(token, '/api/v1/labels');
export const createLabel = (token, label) => request(token, '/api/v1/labels', { method: 'POST', body: label });
export const updateLabel = (token, id, label) => request(token, `/api/v1/labels/${enc(id)}`, { method: 'PUT', body: label });
export const deleteLabel = (token, id) => request(token, `/api/v1/labels/${enc(id)}`, { method: 'DELETE' });
export const assignLabel = (token, id, chatKey, assigned) => request(token, `/api/v1/labels/${enc(id)}/chats/${enc(chatKey)}`, { method: 'PUT', body: { assigned } });
export const listQuickReplies = (token) => request(token, '/api/v1/quick-replies');
export const createQuickReply = (token, reply) => request(token, '/api/v1/quick-replies', { method: 'POST', body: reply });
export const updateQuickReply = (token, id, reply) => request(token, `/api/v1/quick-replies/${enc(id)}`, { method: 'PUT', body: reply });
export const deleteQuickReply = (token, id) => request(token, `/api/v1/quick-replies/${enc(id)}`, { method: 'DELETE' });
export const getBusinessProfile = (token) => request(token, '/api/v1/business');
export const saveBusinessProfile = (token, profile) => request(token, '/api/v1/business', { method: 'PUT', body: profile });

// Two-step verification.
export const getTwoStep = (token) => request(token, '/api/v1/me/two-step');
export const enableTwoStep = (token, pin, password) => request(token, '/api/v1/me/two-step', { method: 'PUT', body: { pin, password } });
export const disableTwoStep = (token, password) => request(token, '/api/v1/me/two-step', { method: 'DELETE', body: { password } });
export const verifyTwoStep = (token, pin) => request(token, '/api/v1/me/two-step/verify', { method: 'POST', body: { pin } });
