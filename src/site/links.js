// Where the public site sends people to get the app. The APK link is the latest signed release build, attached to
// the GitHub Release of the tag "android-v<version>"; update it with each release.
export const ANDROID_APK_URL = 'https://github.com/bickworld555-blip/Hidden-chat/releases/download/android-v1.0.1/HiddenMessenger.apk';

// The Windows app (desktop/): the installer and the portable .exe, attached to the GitHub Release of the tag
// "desktop-v<version>" by .github/workflows/desktop-release.yml. Raise the version with desktop/package.json.
export const WINDOWS_APP_VERSION = '1.0.0';
const WINDOWS_RELEASE = `https://github.com/bickworld555-blip/Hidden-chat/releases/download/desktop-v${WINDOWS_APP_VERSION}`;
export const WINDOWS_INSTALLER_URL = `${WINDOWS_RELEASE}/HiddenMessenger-Setup-${WINDOWS_APP_VERSION}.exe`;
export const WINDOWS_PORTABLE_URL = `${WINDOWS_RELEASE}/HiddenMessenger-${WINDOWS_APP_VERSION}-portable.exe`;

// Public pages (src/site/PublicSite.jsx); every other path opens the messenger.
export const PUBLIC_PATH = /^\/(?:features|calling|messaging|privacy|terms|business|download|delete-account|c|help(?:\/[a-z0-9-]+)?)?\/?$/;
// A shared ID (https://<site>/u/<number>, src/accountNumber.js): a page with "Open in the app" for visitors; signed-in
// web users go straight to the chat (App.jsx short links).
export const ACCOUNT_LINK_PATH = /^\/u\/[1-9]\d{9}\/?$/;
export const SIGNED_IN_HINT = 'hm:signed-in';

/**
 * Which experience a page load shows. The website is a download portal only: in a browser EVERY path shows the public
 * site (download links + "Open in the app" handoff pages), so there is no web messenger or login in the browser. The
 * installed app (the Capacitor/native shell) always runs the messenger.
 */
export function entryFor(pathname, { native = false } = {}) {
  if (native) return 'app';
  return 'site';
}
