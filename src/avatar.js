import { apiFetch } from './api.js';
// Profile photos: authenticated image loading shared by every Avatar, and client-side resizing before upload.
import { useEffect, useState } from 'react';
import { useChatStore } from './store.js';

export const AVATAR_MAX_EDGE = 640;
export const AVATAR_JPEG_QUALITY = 0.86;

// API avatar URLs need the session header, which <img> cannot send; the bytes are fetched once per
// versioned URL and shared as an object URL. Absolute and data URLs are used as they are.
const objectUrls = new Map();

export function isApiAvatar(src) {
  return typeof src === 'string' && src.startsWith('/api/');
}

export function loadAvatar(src, token) {
  const key = `${token}\n${src}`;
  if (!objectUrls.has(key)) {
    objectUrls.set(key, apiFetch(src, { headers: { Authorization: 'Bearer ' + token } })
      .then((response) => {
        if (!response.ok) throw new Error('No profile photo.');
        return response.blob();
      })
      .then((blob) => URL.createObjectURL(blob))
      .catch((error) => {
        objectUrls.delete(key);
        throw error;
      }));
  }
  return objectUrls.get(key);
}

// Photos already loaded, readable at once: a list drawn again (back from a chat) shows them in its first frame
// instead of initials for a moment.
const ready = new Map();

export function clearAvatarCache() {
  for (const pending of objectUrls.values()) pending.then((url) => URL.revokeObjectURL(url)).catch(() => {});
  objectUrls.clear();
  ready.clear();
}

export function useAvatarSrc(src) {
  const token = useChatStore((state) => state.sessionToken);
  const needsAuth = isApiAvatar(src);
  const key = `${token}\n${src}`;
  const [resolved, setResolved] = useState(needsAuth ? ready.get(key) ?? '' : src || '');
  useEffect(() => {
    if (!needsAuth) {
      setResolved(src || '');
      return undefined;
    }
    if (!token) {
      setResolved('');
      return undefined;
    }
    const known = ready.get(key);
    if (known) { setResolved(known); return undefined; }
    let cancelled = false;
    setResolved('');
    loadAvatar(src, token)
      .then((url) => { ready.set(key, url); if (!cancelled) setResolved(url); })
      .catch(() => { if (!cancelled) setResolved(''); });
    return () => { cancelled = true; };
  }, [src, token, needsAuth, key]);
  return resolved;
}

// Picks the square centre of the image and scales it down so uploads stay small and fast.
export async function prepareAvatarBlob(file, { maxEdge = AVATAR_MAX_EDGE, quality = AVATAR_JPEG_QUALITY } = {}) {
  if (!file?.type?.startsWith('image/')) throw new Error('Choose an image file.');
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error('This image could not be read.');
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const edge = Math.min(maxEdge, side);
    const canvas = document.createElement('canvas');
    canvas.width = edge;
    canvas.height = edge;
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, edge, edge);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob) throw new Error('This image could not be processed.');
    return blob;
  } finally {
    bitmap.close?.();
  }
}

export async function uploadAvatar(blob, sessionToken) {
  const response = await apiFetch('/api/v1/me/avatar', { method: 'PUT', headers: { Authorization: 'Bearer ' + sessionToken, 'Content-Type': blob.type || 'image/jpeg' }, body: blob });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.user) throw new Error(data?.error || 'Could not update your photo.');
  return data.user;
}

/** A group's photo (server/parity.mjs): the same prepared square JPEG as a profile photo. Resolves its URL. */
export async function uploadGroupAvatar(groupId, blob, sessionToken) {
  const response = await apiFetch(`/api/v1/groups/${encodeURIComponent(groupId)}/avatar`, { method: 'PUT', headers: { Authorization: 'Bearer ' + sessionToken, 'Content-Type': blob.type || 'image/jpeg' }, body: blob });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.avatar) throw new Error(data?.error || 'Could not set the group photo.');
  return data.avatar;
}

export async function removeAvatar(sessionToken) {
  const response = await apiFetch('/api/v1/me/avatar', { method: 'DELETE', headers: { Authorization: 'Bearer ' + sessionToken } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.user) throw new Error(data?.error || 'Could not remove your photo.');
  return data.user;
}
