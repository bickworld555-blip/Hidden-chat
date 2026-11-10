// App lock, like WhatsApp's fingerprint lock: after the chosen delay away from the app, its content is covered
// until the person unlocks. In the Android app the phone's own unlock is used (fingerprint, face, or its screen
// lock PIN / pattern / password — AppSecurity.java); in a browser, an app passcode kept on this device as a salted
// PBKDF2 hash (never the passcode itself).
import { create } from 'zustand';
import { secureDel, secureGet, secureSet } from './secureStorage.js';
import { appLockDelayMs, appSettings } from './settings.js';
import { nativeAuthenticate, nativeSecurityStatus, nativeSetSecureScreen, nativeShell } from './native.js';

const PASSCODE_KEY = 'hm:app-lock-passcode-v1';
const PASSCODE_ROUNDS = 310_000;
export const PASSCODE_PATTERN = /^\d{4,8}$/;

export const useAppLock = create(() => ({ locked: false, method: null, checked: false }));

let hiddenAt = null;
let authenticating = false;

const encoder = new TextEncoder();
const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

async function passcodeHash(passcode, salt, rounds = PASSCODE_ROUNDS) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(passcode), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: rounds }, material, 256));
}

export async function setPasscode(passcode) {
  if (!PASSCODE_PATTERN.test(passcode)) throw new Error('Use 4 to 8 digits.');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  await secureSet(PASSCODE_KEY, { salt: toBase64(salt), rounds: PASSCODE_ROUNDS, hash: toBase64(await passcodeHash(passcode, salt)) });
}

export async function hasPasscode() {
  return Boolean(await secureGet(PASSCODE_KEY));
}

export async function checkPasscode(passcode) {
  const stored = await secureGet(PASSCODE_KEY);
  if (!stored || !PASSCODE_PATTERN.test(passcode ?? '')) return false;
  const actual = await passcodeHash(passcode, fromBase64(stored.salt), stored.rounds);
  const expected = fromBase64(stored.hash);
  return actual.length === expected.length && actual.every((byte, index) => byte === expected[index]);
}

export const clearPasscode = () => secureDel(PASSCODE_KEY);

/** How this device unlocks: 'biometric' (the phone's own unlock), 'passcode', or null (no way to unlock). */
export async function unlockMethod() {
  if (nativeShell()) {
    const status = await nativeSecurityStatus();
    if (status?.biometric === 'available') return 'biometric';
  }
  return (await hasPasscode()) ? 'passcode' : null;
}

/** The phone's own unlock prompt. Resolves true when unlocked. */
export async function authenticateNative(reason = 'Unlock Hidden Messenger') {
  authenticating = true;
  try {
    const result = await nativeAuthenticate(reason);
    return Boolean(result?.ok);
  } finally {
    // The device-credential screen pauses the app; its return must not count as "came back from the background".
    setTimeout(() => { authenticating = false; hiddenAt = null; }, 500);
  }
}

export function unlock() {
  hiddenAt = null;
  useAppLock.setState({ locked: false });
}

function lockIfDue() {
  const delay = appLockDelayMs(appSettings().get('security.appLock'));
  if (delay === null || hiddenAt === null || authenticating) return;
  if (Date.now() - hiddenAt >= delay) useAppLock.setState({ locked: true });
  hiddenAt = null;
}

/** Starts app lock for this page: locked at launch when enabled, then after the delay away. Returns a stop function. */
export function startAppLock() {
  const enabled = appLockDelayMs(appSettings().get('security.appLock')) !== null;
  unlockMethod().then((method) => {
    // A lock with no way to unlock (e.g. the phone's screen lock was removed) must not trap the user out.
    useAppLock.setState({ method, checked: true, locked: enabled && Boolean(method) });
  }).catch(() => useAppLock.setState({ checked: true }));
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      if (!authenticating && !useAppLock.getState().locked) hiddenAt = Date.now();
    } else {
      lockIfDue();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  return () => document.removeEventListener('visibilitychange', onVisibility);
}

/** Applies screen security (Android) from the device setting; called at start and when it changes. */
export function applyScreenSecurity() {
  if (nativeShell()) nativeSetSecureScreen(Boolean(appSettings().get('security.screenSecurity')));
}
