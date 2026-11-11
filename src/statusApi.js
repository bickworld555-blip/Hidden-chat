// Status updates (24 hours): the server API, plus the wording the Updates tab uses.
import { apiFetch } from './api.js';
import { uploadFile } from './upload.js';
import { openContent, sealStatus } from './e2e/client.js';
import { attachmentContent, sealForUpload } from './mediaCrypto.js';
import { parseMediaRef } from './media.js';

export { STATUS_BACKGROUNDS } from './statusColors.js';

async function request(path, token, { method = 'GET', body } = {}) {
  const response = await apiFetch(`/api/v1/statuses${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Status request failed (${response.status}).`);
  }
  return response.status === 204 ? null : response.json();
}

// { mine: [status], others: [{ user, statuses: [status], lastAt, allSeen }] }. Sealed statuses are opened here;
// one this device cannot read is left out (its author's audience changed after it was posted, or keys reset).
export async function fetchStatuses(token, ownId = null) {
  const feed = await request('', token);
  const open = async (status, authorId) => {
    const opened = await openContent(status.content, { senderId: authorId });
    return opened.e2eError ? null : { ...status, content: opened.content, ...(opened.e2e ? { e2e: true } : {}) };
  };
  const mine = [];
  for (const status of feed.mine ?? []) { const item = await open(status, ownId); if (item) mine.push(item); }
  const others = [];
  for (const entry of feed.others ?? []) {
    const statuses = [];
    for (const status of entry.statuses) { const item = await open(status, entry.user.id); if (item) statuses.push(item); }
    if (statuses.length) others.push({ ...entry, statuses, allSeen: statuses.every((status) => status.seen) });
  }
  return { ...feed, mine, others };
}
// End-to-end encrypted for the audience when everyone in it can receive it (src/e2e/client.js sealStatus).
export const postTextStatus = async (token, text, background) => request('', token, { method: 'POST', body: { content: await sealStatus(text), background } });
export const markStatusSeen = (token, id) => request(`/${encodeURIComponent(id)}/view`, token, { method: 'POST' });
export const deleteStatus = (token, id) => request(`/${encodeURIComponent(id)}`, token, { method: 'DELETE' });
export const statusViewers = (token, id) => request(`/${encodeURIComponent(id)}/viewers`, token);

// A photo or video status: uploaded to yourself first (contacts can open it only through the status).
export async function postMediaStatus(token, userId, file, { onProgress } = {}) {
  const { upload, descriptor } = await sealForUpload(file);
  const data = await uploadFile(upload, { receiverId: userId, sessionToken: token, onProgress });
  const content = attachmentContent(data.id, descriptor ? file.name || 'status' : data.filename || file.name || 'status', descriptor);
  return request('', token, { method: 'POST', body: { content: await sealStatus(content) } });
}

function clock(date) {
  const hours = date.getHours();
  return `${hours % 12 || 12}:${String(date.getMinutes()).padStart(2, '0')} ${hours < 12 ? 'am' : 'pm'}`;
}

// "Just now", "12 minutes ago", "Today, 5:12 pm", "Yesterday, 9:03 am" (statuses never outlive a day).
export function statusTime(iso, now = new Date()) {
  const at = new Date(iso);
  const minutes = Math.floor((now - at) / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const sameDay = at.toDateString() === now.toDateString();
  return `${sameDay ? 'Today' : 'Yesterday'}, ${clock(at)}`;
}

// What a status is: { kind: 'text' | 'image' | 'video' | 'file', text?, mediaId?, filename? }.
export function statusKind(content) {
  if (typeof content !== 'string') return { kind: 'text', text: '' };
  // parseMediaRef also registers an encrypted photo's key, so the viewer decrypts it (src/media.js).
  const ref = content.startsWith('media:') || content.startsWith('emedia:') ? parseMediaRef(content) : null;
  if (!ref) return { kind: 'text', text: content };
  const mediaId = ref.id;
  const filename = ref.filename;
  const extension = filename.split('.').pop()?.toLowerCase() ?? '';
  const kind = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp'].includes(extension) ? 'image'
    : ['mp4', 'mov', 'webm', '3gp', 'mkv', 'm4v'].includes(extension) ? 'video' : 'file';
  return { kind, mediaId, filename };
}
