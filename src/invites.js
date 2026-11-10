import { publicOrigin } from './api.js';
// Group invite links: https://<host>/join/<code> (server/parity.mjs makes the codes).
// In the Android app the page origin is the bundled https://localhost, so links use the server's public origin.
export const inviteUrl = (code) => `${publicOrigin()}/join/${code}`;
const INVITE_IN_TEXT = /(?:\/join\/|^)([A-Za-z0-9_-]{16,64})\/?$/;

/** The invite code in a pasted link or code (null if it isn't one). */
export function inviteCodeFrom(text) {
  const match = INVITE_IN_TEXT.exec((text ?? '').trim());
  return match ? match[1] : null;
}
