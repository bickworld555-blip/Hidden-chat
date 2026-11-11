// Display preferences on this device (Settings › Chats › Font size, Settings › Accessibility): message font size
// and increased contrast. Applied as attributes on the app shell (App.jsx), so CSS does the rest.
import { useSyncExternalStore } from 'react';

export const FONT_SIZES = [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large'], ['xlarge', 'Extra large']];
const FONT_KEY = 'hm:font-size';
const CONTRAST_KEY = 'hm:high-contrast';
const listeners = new Set();
const notify = () => { for (const listener of listeners) listener(); };
const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key, value) => { try { localStorage.setItem(key, value); } catch { /* private mode */ } notify(); };

export const getFontSize = () => (FONT_SIZES.some(([id]) => id === read(FONT_KEY)) ? read(FONT_KEY) : 'medium');
export const setFontSize = (id) => { if (FONT_SIZES.some(([value]) => value === id)) write(FONT_KEY, id); };
export const getHighContrast = () => read(CONTRAST_KEY) === '1';
export const setHighContrast = (on) => write(CONTRAST_KEY, on ? '1' : '0');

const subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
export const useFontSize = () => useSyncExternalStore(subscribe, getFontSize, () => 'medium');
export const useHighContrast = () => useSyncExternalStore(subscribe, getHighContrast, () => false);
export const fontSizeLabel = (id) => FONT_SIZES.find(([value]) => value === id)?.[1] ?? 'Medium';
