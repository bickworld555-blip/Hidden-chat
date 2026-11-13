// Appearance preferences (motion). Stored per device, applied as a data attribute on the app shell
// so one CSS rule can switch every transition and animation off.
import { useSyncExternalStore } from 'react';
import { deviceStorage } from './deviceStorage.js';

export const APPEARANCE_KEY = 'relay:appearance';
export const DEFAULT_APPEARANCE = Object.freeze({ animations: true, callAnimations: true, avatarCalls: false });

const listeners = new Set();
let current = null;

// `animations` is the master switch; `callAnimations` covers the ring/connect/PiP motion of the call screens;
// `avatarCalls` ("Animation Video Call") sends the cartoon avatar instead of the camera in video calls.
export function normalizeAppearance(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return { animations: source.animations !== false, callAnimations: source.callAnimations !== false, avatarCalls: source.avatarCalls === true };
}

function read() {
  if (current) return current;
  let parsed = null;
  try {
    parsed = JSON.parse(deviceStorage.getItem(APPEARANCE_KEY) ?? 'null');
  } catch {
    parsed = null;
  }
  current = normalizeAppearance(parsed);
  return current;
}

export function getAppearance() {
  return read();
}

export function setAppearance(patch) {
  current = normalizeAppearance({ ...read(), ...patch });
  try {
    deviceStorage.setItem(APPEARANCE_KEY, JSON.stringify(current));
  } catch {
    // Private mode or storage quota: the preference still applies for this session.
  }
  for (const listener of listeners) listener();
  return current;
}

export function setAnimationsEnabled(enabled) {
  return setAppearance({ animations: Boolean(enabled) });
}

export function setCallAnimationsEnabled(enabled) {
  return setAppearance({ callAnimations: Boolean(enabled) });
}

export function setAvatarCallsEnabled(enabled) {
  return setAppearance({ avatarCalls: Boolean(enabled) });
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAppearance() {
  return useSyncExternalStore(subscribe, read, () => DEFAULT_APPEARANCE);
}

export function useAnimationsEnabled() {
  return useAppearance().animations;
}

export function useCallAnimationsEnabled() {
  return useAppearance().callAnimations;
}

export function useAvatarCallsEnabled() {
  return useAppearance().avatarCalls;
}

// Value for the `data-animations` attribute on the app shell.
export function animationsAttribute(appearance = read()) {
  return appearance.animations ? 'on' : 'off';
}

// Value for `data-call-animations`: call-screen motion is off when either switch is off.
export function callAnimationsAttribute(appearance = read()) {
  return appearance.animations && appearance.callAnimations ? 'on' : 'off';
}

// Theme. New installs start on the light theme (blue accents); Settings › Theme switches to dark. Before this, phones
// started dark: a phone already signed in that never chose a theme keeps the dark one it has been showing, decided
// once (THEME_SETTLED) so someone who installs fresh and signs in later is never switched to dark.
export const THEME_KEY = 'relay:theme';
export const THEME_SETTLED = 'hm:theme-default-light';

export function settleThemeDefault(storage, { signedIn, phone }) {
  if (storage.getItem(THEME_SETTLED)) return;
  if (!storage.getItem(THEME_KEY) && signedIn && phone) storage.setItem(THEME_KEY, 'dark');
  storage.setItem(THEME_SETTLED, '1');
}

// Settings › Appearance › App theme (WhatsApp's three choices): Light, Dark, or System default (follows the phone).
export const THEME_CHOICES = Object.freeze([
  { id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }, { id: 'system', label: 'System default' },
]);

export function themeChoice(storage) {
  const value = storage.getItem(THEME_KEY);
  return THEME_CHOICES.some((choice) => choice.id === value) ? value : 'light';
}

export function resolveDark(choice, systemDark) {
  return choice === 'dark' || (choice === 'system' && Boolean(systemDark));
}

const systemPrefersDark = () => Boolean(globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches);

/** Whether the app opens dark: the device chose (or kept) Dark, or System default while the phone is dark. */
export function startsDark(storage, systemDark = systemPrefersDark()) {
  return resolveDark(themeChoice(storage), systemDark);
}

/** Follows the phone's light/dark switch (for System default). */
export function watchSystemTheme(onChange) {
  const query = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
  if (!query) return () => {};
  const listener = (event) => onChange(event.matches);
  query.addEventListener?.('change', listener);
  return () => query.removeEventListener?.('change', listener);
}
