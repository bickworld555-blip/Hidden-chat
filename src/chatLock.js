// Chat lock (WhatsApp's "Lock this chat"): locked chats leave the chat list for a "Locked chats" folder that opens
// only after the phone's fingerprint / face / screen lock (Android app) or the app passcode (browser). Their
// notifications say "New message" without the name or text. The list of locked chats stays on this device.
import { authenticateNative, checkPasscode, hasPasscode } from './appLock.js';
import { nativeSecurityStatus, nativeShell } from './native.js';

/** How locked chats are opened here: 'biometric' (phone prompt), 'passcode' (app passcode) or null (set one first). */
export async function chatLockMethod() {
  if (nativeShell()) {
    const status = await nativeSecurityStatus().catch(() => null);
    if (status?.biometric === 'available') return 'biometric';
  }
  return (await hasPasscode()) ? 'passcode' : null;
}

/** Opens the locked folder: the phone's prompt, or the passcode the user typed. Resolves true when allowed. */
export async function unlockLockedChats({ method, passcode = '' }) {
  if (method === 'biometric') return authenticateNative('Open locked chats');
  if (method === 'passcode') return checkPasscode(passcode);
  return false;
}

/** The notification for a message in a locked chat: no name, no text. */
export const LOCKED_NOTIFICATION = Object.freeze({ title: 'Hidden Messenger', body: 'New message' });
