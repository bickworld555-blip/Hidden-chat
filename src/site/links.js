// Where the public site sends people to get the app. The APK link is the latest release build (EAS); update it
// with each release.
export const ANDROID_APK_URL = 'https://expo.dev/artifacts/eas/6EuD8AQn7up7wEE6V2gfMGC2cg2n8VwkBNtUyyV78cY.apk';

// Public pages (src/site/PublicSite.jsx); every other path opens the messenger.
export const PUBLIC_PATH = /^\/(?:features|calling|messaging|privacy|business|download|help(?:\/[a-z0-9-]+)?)?\/?$/;
export const SIGNED_IN_HINT = 'hm:signed-in';

/** Which experience a page load shows: the public site, or the messenger (always in the Android app). */
export function entryFor(pathname, { native = false, signedIn = false } = {}) {
  if (native) return 'app';
  if (!PUBLIC_PATH.test(pathname)) return 'app';
  if (pathname === '/' && signedIn) return 'redirect-app';
  return 'site';
}
