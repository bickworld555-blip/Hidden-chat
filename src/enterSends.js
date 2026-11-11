// "Enter is send" (Settings › Chats). Default: on for computers (a fine pointer, no Android shell), off on
// phones, where Enter starts a new line and the send button sends. Stored on this device.
import { useSyncExternalStore } from 'react';
import { nativeShell } from './native.js';

const KEY = 'hm:enter-sends';
const listeners = new Set();
const defaultValue = () => !nativeShell() && Boolean(globalThis.matchMedia?.('(pointer: fine)').matches);

export function enterSends() {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === '1' || stored === '0') return stored === '1';
  } catch { /* private mode */ }
  return defaultValue();
}

export function setEnterSends(on) {
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* private mode */ }
  for (const listener of listeners) listener();
}

const subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
export const useEnterSends = () => useSyncExternalStore(subscribe, enterSends, () => false);
