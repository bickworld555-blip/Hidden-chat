// PWA wiring: service worker registration and manifest shortcut targets.
const SHORTCUT_TABS = new Set(['chats', 'calls', 'updates', 'tools']);

// Manifest shortcuts open `/?tab=calls` etc.; anything else starts on Chats.
export function initialTabFromUrl(href = globalThis.location?.href) {
  try {
    const tab = new URL(href).searchParams.get('tab');
    return SHORTCUT_TABS.has(tab) ? tab : 'chats';
  } catch {
    return 'chats';
  }
}

// Registers only in production builds on a secure origin. The Capacitor Android shell is skipped: it is
// already installed natively and its WebView does not need an install prompt or offline shell.
export function registerServiceWorker({ navigator: nav = globalThis.navigator, window: win = globalThis.window, production = import.meta.env?.PROD } = {}) {
  if (!production || !nav?.serviceWorker || !win?.isSecureContext) return false;
  if (win.Capacitor?.isNativePlatform?.()) return false;
  win.addEventListener('load', () => {
    nav.serviceWorker.register('/sw.js', { scope: '/' }).catch((error) => {
      console.warn('Service worker registration failed; the app still works online.', error);
    });
  });
  return true;
}
