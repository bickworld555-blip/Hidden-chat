// Pure rules for presence ("online" / last seen), its privacy setting, and naming signed-in devices.

export const LAST_SEEN_PRIVACY = Object.freeze(['everyone', 'contacts', 'nobody']);

export function isLastSeenPrivacy(value) {
  return LAST_SEEN_PRIVACY.includes(value);
}

// Whether `viewerId` may see the owner's online status and last seen. `ownerContactIds` is the owner's
// contact book (who the owner saved), which is what "My contacts" means.
export function canSeePresence({ ownerId, viewerId, privacy, ownerContactIds }) {
  if (ownerId === viewerId) return true;
  if (privacy === 'nobody') return false;
  if (privacy === 'contacts') return Boolean(ownerContactIds?.has(viewerId));
  return true;
}

// What one viewer is told about one user. Hidden presence carries no status and no time at all.
export function presenceFor({ online, lastSeenAt, visible }) {
  if (!visible) return { status: 'hidden', lastSeenAt: null };
  return { status: online ? 'online' : 'offline', lastSeenAt: online ? null : (lastSeenAt ?? null) };
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
