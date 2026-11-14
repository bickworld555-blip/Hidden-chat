// The Android app runs the web app from files packaged inside the APK (Capacitor's local server at
// https://localhost), never from a website: no code can be swapped in remotely. ANDROID_APP_URL names the HTTPS
// server the bundled app talks to for its API and WebSocket (it is compiled into the bundle and its security policy).
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const ANDROID_WEB_DIR = 'dist-android';
// The bundled app's own origin (Capacitor: androidScheme https, hostname localhost). The server allows it.
export const BUNDLED_APP_ORIGIN = 'https://localhost';

/** The API origin the bundled app is built against: an HTTPS origin reachable from the phone. */
export function apiOrigin(rawUrl) {
  if (!rawUrl) throw new Error('ANDROID_APP_URL is required: the HTTPS server origin (serving /api and /ws) the app connects to.');
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('ANDROID_APP_URL must be an HTTPS origin without credentials, paths, query or fragment.');
  }
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('ANDROID_APP_URL must be reachable from the phone, not localhost.');
  if (url.hostname.endsWith('.invalid')) throw new Error('ANDROID_APP_URL cannot use a placeholder .invalid domain.');
  return url.origin;
}

/** Capacitor config for the self-contained app: bundled web assets only, no server.url, no cleartext. */
export function androidConfig(rawUrl) {
  apiOrigin(rawUrl);
  return {
    appId: 'io.github.bickworld555.hiddenchat',
    appName: 'Hidden Messenger',
    webDir: ANDROID_WEB_DIR,
    loggingBehavior: 'none',
    server: { androidScheme: 'https', hostname: 'localhost', cleartext: false },
    android: { allowMixedContent: false, webContentsDebuggingEnabled: false },
    // The local-first message store on the phone (src/sqliteMessageDb.js): SQLite encrypted with SQLCipher; the
    // passphrase is kept by the plugin in Android's secure storage.
    plugins: { CapacitorSQLite: { androidIsEncryption: true, androidBiometric: { biometricAuth: false } } },
  };
}

/** Extra media-server origins for the CSP: only bare https:// and wss:// origins are kept. */
export function sfuOrigins(value = '') {
  return String(value).split(/\s+/).filter(Boolean).flatMap((entry) => {
    try {
      const url = new URL(entry);
      return ['https:', 'wss:'].includes(url.protocol) && url.origin === entry.replace(/\/$/, '') ? [url.origin] : [];
    } catch {
      return [];
    }
  });
}

export const DEFAULT_XMPP_ORIGIN = 'wss://chat.hiddenmessenger.com';

/**
 * The bundled app's Content-Security-Policy: scripts only from the APK itself (and WebAssembly for the on-device
 * face tracker), network only to the app's server, the XMPP core, the map/place services it uses and the group-call media server,
 * no frames or plugins.
 */
export function bundledCsp(rawUrl) {
  const api = apiOrigin(rawUrl);
  const socket = api.replace(/^https:/, 'wss:');
  const services = ['https://nominatim.openstreetmap.org', 'https://overpass-api.de', 'https://overpass.kumi.systems', 'https://overpass.private.coffee', 'https://storage.googleapis.com'];
  // Group calls through the media server (server/sfu.mjs): LiveKit Cloud and its region servers, plus a self-hosted
  // server named in ANDROID_SFU_ORIGINS (space-separated https:// and wss:// origins). Media stays end-to-end encrypted.
  const sfu = ['https://*.livekit.cloud', 'wss://*.livekit.cloud', ...sfuOrigins(process.env.ANDROID_SFU_ORIGINS)];
  // The XMPP core (ejabberd on the VPS, server/xmpp.mjs DEFAULT_XMPP_HOST): the app's WebSocket to it
  // (src/xmpp/transport.js). Another host is named in ANDROID_XMPP_ORIGINS (space-separated wss:// origins).
  const xmpp = sfuOrigins(process.env.ANDROID_XMPP_ORIGINS ?? DEFAULT_XMPP_ORIGIN);
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    `media-src 'self' blob: data: ${api}`,
    `connect-src 'self' blob: data: ${api} ${socket} ${xmpp.join(' ')} ${services.join(' ')} ${sfu.join(' ')}`,
    "worker-src 'self' blob:",
    "font-src 'self' data:",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join('; ');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = androidConfig(process.env.ANDROID_APP_URL);
  await writeFile(new URL('../capacitor.config.json', import.meta.url), JSON.stringify(config, null, 2) + '\n');
  console.log(`Android app configured: bundled web assets (${ANDROID_WEB_DIR}), API at ${apiOrigin(process.env.ANDROID_APP_URL)}.`);
}
