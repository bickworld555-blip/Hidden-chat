// On a computer (the website, or the desktop app that loads it) Hidden Messenger opens only by linking with the phone,
// like WhatsApp Web: no password sign-in, no new accounts. The server refuses both from a browser too
// (server/clientGate.mjs). A local development build keeps the password form.
import { nativeShell } from './native.js';

export function companionOnly({ native = nativeShell(), development = Boolean(import.meta.env?.DEV) } = {}) {
  return !native && !development;
}
