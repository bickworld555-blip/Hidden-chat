// "Media Save": in the Android app, received photos, videos, audio and documents are saved to the phone under
// Download/Hidden Messenger/<Images|Video|Audio|Documents> (visible in the gallery and the file manager). The
// download button saves there too. Browsers keep their own download behaviour.
import { useSyncExternalStore } from 'react';
import { apiFetch, apiUrl } from './api.js';
import { nativeSaveMedia, nativeShell } from './native.js';
import { parseMediaRef } from './media.js';
import { parseVoiceContent } from './voice.js';

export const MEDIA_SAVE_KEY = 'hm:media-save';
const SAVED_KEY = 'hm:media-saved-ids';
const MAX_REMEMBERED = 2000;
const listeners = new Set();

export function mediaSaveEnabled() {
  try { return localStorage.getItem(MEDIA_SAVE_KEY) === 'on'; } catch { return false; }
}

export function setMediaSaveEnabled(enabled) {
  try { localStorage.setItem(MEDIA_SAVE_KEY, enabled ? 'on' : 'off'); } catch { /* private mode */ }
  for (const listener of listeners) listener();
}

export function useMediaSave() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, mediaSaveEnabled, () => false);
}

function savedIds() {
  try { return new Set(JSON.parse(localStorage.getItem(SAVED_KEY) ?? '[]')); } catch { return new Set(); }
}

function rememberSaved(id) {
  const ids = [...savedIds().add(id)].slice(-MAX_REMEMBERED);
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(ids)); } catch { /* full or private */ }
}

// The attachment a message carries, if it is one that can be saved (view once notes never are).
export function savableMedia(content) {
  const voice = parseVoiceContent(content);
  if (voice) return voice.viewOnce || !voice.id ? null : { id: voice.id, filename: '' };
  const ref = parseMediaRef(content);
  return ref?.id ? { id: ref.id, filename: ref.filename } : null;
}

// Saves one attachment to the phone through the app's native saver; resolves the folder path it landed in.
export async function saveMediaToPhone({ id, filename, sessionToken }) {
  const response = await apiFetch(`/api/v1/media/${encodeURIComponent(id)}/link`, { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}` } });
  const link = await response.json().catch(() => null);
  if (!response.ok || !link?.url) throw new Error(link?.error || 'This file is no longer available.');
  const url = new URL(apiUrl(link.url), window.location.href).href;
  const result = await nativeSaveMedia({ id, url, filename: link.filename || filename || 'file' });
  if (!result?.saved) throw new Error('Could not save the file.');
  rememberSaved(id);
  return result.path;
}

// A message just arrived: with Media Save on (Android app), save its attachment once.
export function autoSaveIncoming(content, sessionToken) {
  if (!nativeShell() || !sessionToken || !mediaSaveEnabled()) return;
  const media = savableMedia(content);
  if (!media || savedIds().has(media.id)) return;
  saveMediaToPhone({ ...media, sessionToken }).catch(() => { /* the download button can retry */ });
}
