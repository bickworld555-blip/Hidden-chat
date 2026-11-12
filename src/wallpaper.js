// Chat wallpaper for this device (Settings › Chats › Wallpaper). A chat with its own theme (contact info ›
// Chat theme) keeps that; every other chat shows this wallpaper. Drawn by CSS ([data-wallpaper] on the
// message list), so it follows light and dark mode.
import { useSyncExternalStore } from 'react';
import { deviceStorage } from './deviceStorage.js';

export const WALLPAPERS = Object.freeze([
  { id: 'doodle', label: 'Default', kind: 'Pattern' },
  { id: 'dots', label: 'Dots', kind: 'Pattern' },
  { id: 'grid', label: 'Grid', kind: 'Pattern' },
  { id: 'waves', label: 'Waves', kind: 'Pattern' },
  { id: 'plain', label: 'Plain', kind: 'Solid' },
  { id: 'navy', label: 'Navy', kind: 'Solid' },
  { id: 'harbour', label: 'Harbour', kind: 'Solid' },
  { id: 'slate', label: 'Slate', kind: 'Solid' },
  { id: 'dawn', label: 'Dawn', kind: 'Solid' },
]);
const KEY = 'hm:wallpaper';
const listeners = new Set();

export function getWallpaper() {
  try {
    const value = deviceStorage.getItem(KEY);
    return WALLPAPERS.some((wallpaper) => wallpaper.id === value) ? value : 'doodle';
  } catch {
    return 'doodle';
  }
}

export function setWallpaper(id) {
  if (!WALLPAPERS.some((wallpaper) => wallpaper.id === id)) return;
  try { deviceStorage.setItem(KEY, id); } catch { /* private mode: this session only */ }
  for (const listener of listeners) listener();
}

const subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
export const useWallpaper = () => useSyncExternalStore(subscribe, getWallpaper, () => 'doodle');
