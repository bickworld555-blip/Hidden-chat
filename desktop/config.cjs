// What the desktop window may open and allow. Kept apart from main.cjs so it can be tested without Electron.
const DEFAULT_APP_URL = 'https://hiddenmessenger.com/app';

/** The messenger's address: HM_APP_URL (for a test server) or the live site. Only https, or http on localhost. */
function appUrl(env = process.env) {
  const value = env.HM_APP_URL || DEFAULT_APP_URL;
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('HM_APP_URL must use https (or http on localhost).');
  return url.href;
}

/** Pages of the messenger stay in the window; every other link opens in the default browser. */
function staysInApp(target, app) {
  try {
    return new URL(target).origin === new URL(app).origin;
  } catch {
    return false;
  }
}

// Calls need the camera and microphone, new messages show notifications; the clipboard is for copying codes.
// Everything else (location, MIDI, USB, …) is refused, and nothing is granted to another site.
const ALLOWED_PERMISSIONS = new Set(['media', 'notifications', 'clipboard-sanitized-write', 'fullscreen', 'display-capture']);

function permissionAllowed(permission, requestingUrl, app) {
  return ALLOWED_PERMISSIONS.has(permission) && staysInApp(requestingUrl, app);
}

module.exports = { DEFAULT_APP_URL, appUrl, staysInApp, permissionAllowed };
