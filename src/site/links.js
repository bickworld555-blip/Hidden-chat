// Where the public site sends people to get the app. The APK link is the latest release build (EAS); update it
// with each release.
export const ANDROID_APK_URL = 'https://expo.dev/artifacts/eas/38LfirCl2GQdheYbl7Amfmn6K5U_t-79Ze6YQeHHXM4.apk';

// The Windows app (desktop/): the installer and the portable .exe, attached to the GitHub Release of the tag
// "desktop-v<version>" by .github/workflows/desktop-release.yml. Raise the version with desktop/package.json.
export const WINDOWS_APP_VERSION = '1.0.0';
const WINDOWS_RELEASE = `https://github.com/bickworld555-blip/Hidden-chat/releases/download/desktop-v${WINDOWS_APP_VERSION}`;
export const WINDOWS_INSTALLER_URL = `${WINDOWS_RELEASE}/HiddenMessenger-Setup-${WINDOWS_APP_VERSION}.exe`;
export const WINDOWS_PORTABLE_URL = `${WINDOWS_RELEASE}/HiddenMessenger-${WINDOWS_APP_VERSION}-portable.exe`;

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
