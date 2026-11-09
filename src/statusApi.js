// Status updates (24 hours): the server API, plus the wording the Updates tab uses.
import { apiFetch } from './api.js';
import { uploadFile } from './upload.js';

export const STATUS_BACKGROUNDS = ['#00a884', '#128c7e', '#7e57c2', '#ef6c00', '#c2185b', '#1e88e5', '#5d4037', '#37474f'];

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

// { mine: [status], others: [{ user, statuses: [status], lastAt, allSeen }] }
export const fetchStatuses = (token) => request('', token);
export const postTextStatus = (token, text, background) => request('', token, { method: 'POST', body: { content: text, background } });
export const markStatusSeen = (token, id) => request(`/${encodeURIComponent(id)}/view`, token, { method: 'POST' });
export const deleteStatus = (token, id) => request(`/${encodeURIComponent(id)}`, token, { method: 'DELETE' });
export const statusViewers = (token, id) => request(`/${encodeURIComponent(id)}/viewers`, token);

// A photo or video status: uploaded to yourself first (contacts can open it only through the status).
export async function postMediaStatus(token, userId, file, { onProgress } = {}) {
  const data = await uploadFile(file, { receiverId: userId, sessionToken: token, onProgress });
  return request('', token, { method: 'POST', body: { content: `media:${data.id}:${data.filename || file.name || 'status'}` } });
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
  if (!content.startsWith('media:')) return { kind: 'text', text: content };
  const [, mediaId, ...rest] = content.split(':');
  const filename = rest.join(':');
  const extension = filename.split('.').pop()?.toLowerCase() ?? '';
  const kind = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp'].includes(extension) ? 'image'
    : ['mp4', 'mov', 'webm', '3gp', 'mkv', 'm4v'].includes(extension) ? 'video' : 'file';
  return { kind, mediaId, filename };
}
