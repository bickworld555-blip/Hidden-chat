// Pure rules for presence ("online" / last seen), its privacy setting, and naming signed-in devices.

import { isDisappearingDuration } from '../src/disappearing.js';
export const LAST_SEEN_PRIVACY = Object.freeze(['everyone', 'contacts', 'nobody']);

export function isLastSeenPrivacy(value) {
  return LAST_SEEN_PRIVACY.includes(value);
}

// WhatsApp's privacy categories (its values: all / contacts / none, and match_last_seen for "online").
// Who can see my profile photo: the same three audiences as last seen.
export const PHOTO_PRIVACY = LAST_SEEN_PRIVACY;
// Who can see when I'm online: everyone, or the same people who can see my last seen.
export const ONLINE_PRIVACY = Object.freeze(['everyone', 'same_as_last_seen']);
// Online defaults to "same as last seen": before this setting existed, last seen privacy also hid online.
export const DEFAULT_PRIVACY = Object.freeze({
  lastSeen: 'everyone', online: 'same_as_last_seen', profilePhoto: 'everyone', readReceipts: true,
  about: 'everyone', silenceUnknownCallers: false, defaultTimer: 0,
});

// "About": a short line under the name, at most 139 characters as on WhatsApp.
export const ABOUT_MAX = 139;

/** Validates a partial privacy update; returns { patch } or { error }. */
export function parsePrivacyPatch(body) {
  const patch = {};
  if (!body || typeof body !== 'object') return { error: 'Send the privacy settings to change.' };
  if ('lastSeen' in body) {
    if (!LAST_SEEN_PRIVACY.includes(body.lastSeen)) return { error: 'Choose Everyone, My contacts or Nobody.' };
    patch.lastSeen = body.lastSeen;
  }
  if ('online' in body) {
    if (!ONLINE_PRIVACY.includes(body.online)) return { error: 'Choose Everyone or Same as last seen.' };
    patch.online = body.online;
  }
  if ('profilePhoto' in body) {
    if (!PHOTO_PRIVACY.includes(body.profilePhoto)) return { error: 'Choose Everyone, My contacts or Nobody.' };
    patch.profilePhoto = body.profilePhoto;
  }
  if ('readReceipts' in body) {
    if (typeof body.readReceipts !== 'boolean') return { error: 'Read receipts are on or off.' };
    patch.readReceipts = body.readReceipts;
  }
  if ('about' in body) {
    if (!PHOTO_PRIVACY.includes(body.about)) return { error: 'Choose Everyone, My contacts or Nobody.' };
    patch.about = body.about;
  }
  // Calls from people who are not saved contacts don't ring; they show as silenced in Calls.
  if ('silenceUnknownCallers' in body) {
    if (typeof body.silenceUnknownCallers !== 'boolean') return { error: 'Silence unknown callers is on or off.' };
    patch.silenceUnknownCallers = body.silenceUnknownCallers;
  }
  // Default message timer: new chats you start get this disappearing-messages timer (0 = off).
  if ('defaultTimer' in body) {
    if (!Number.isInteger(body.defaultTimer) || !isDisappearingDuration(body.defaultTimer)) return { error: 'Choose 24 hours, 7 days, 90 days or Off.' };
    patch.defaultTimer = body.defaultTimer;
  }
  if (Object.keys(patch).length === 0) return { error: 'Nothing to change.' };
  return { patch };
}

/** Whether an audience setting (everyone / contacts / nobody) lets `viewerId` see something of the owner's. */
export function audienceAllows({ ownerId, viewerId, audience, ownerContactIds }) {
  if (ownerId === viewerId) return true;
  if (audience === 'nobody') return false;
  if (audience === 'contacts') return Boolean(ownerContactIds?.has(viewerId));
  return true;
}

/**
 * Blue ticks, WhatsApp's rule: a message shows as read to its sender only while both people have read receipts
 * on (turning them off also hides other people's). Otherwise "read" stays "delivered" for the sender.
 */
export function visibleStatus(status, { senderReceipts = true, receiverReceipts = true } = {}) {
  return status === 'read' && !(senderReceipts && receiverReceipts) ? 'delivered' : status;
}

// Whether `viewerId` may see the owner's online status and last seen. `ownerContactIds` is the owner's
// contact book (who the owner saved), which is what "My contacts" means.
export function canSeePresence({ ownerId, viewerId, privacy, ownerContactIds }) {
  return audienceAllows({ ownerId, viewerId, audience: privacy, ownerContactIds });
}

/**
 * What one viewer is told about one user. `visible` covers last seen; `onlineVisible` (default: the same) covers
 * "online" — with online privacy "Everyone" a viewer may see someone online whose last seen they cannot see.
 * Hidden presence carries no status and no time at all.
 */
export function presenceFor({ online, lastSeenAt, visible, onlineVisible = visible }) {
  if (online && onlineVisible) return { status: 'online', lastSeenAt: null };
  if (!visible) return { status: 'hidden', lastSeenAt: null };
  return { status: 'offline', lastSeenAt: lastSeenAt ?? null };
}

const BROWSERS = [
  [/EdgA?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];
const SYSTEMS = [
  [/Android/, 'Android'],
  [/iPhone|iPad|iPod/, 'iOS'],
  [/CrOS/, 'ChromeOS'],
  [/Windows/, 'Windows'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Linux/, 'Linux'],
];

// "Chrome on Windows", "Hidden Messenger app on Android", or `fallback` when the agent says nothing useful.
export function deviceNameFromUserAgent(userAgent, fallback = 'Browser') {
  const agent = typeof userAgent === 'string' ? userAgent.slice(0, 512) : '';
  const system = SYSTEMS.find(([pattern]) => pattern.test(agent))?.[1];
  // The Android app is a WebView shell, which marks itself with "; wv)".
  if (system === 'Android' && /; wv\)/.test(agent)) return 'Hidden Messenger app on Android';
  const browser = BROWSERS.find(([pattern]) => pattern.test(agent))?.[1];
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system ?? fallback;
}
