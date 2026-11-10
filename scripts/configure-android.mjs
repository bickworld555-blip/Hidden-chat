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
  };
}

/**
 * The bundled app's Content-Security-Policy: scripts only from the APK itself (and WebAssembly for the on-device
 * face tracker), network only to the app's server and the map/place services it uses, no frames or plugins.
 */
export function bundledCsp(rawUrl) {
  const api = apiOrigin(rawUrl);
  const socket = api.replace(/^https:/, 'wss:');
  const services = ['https://nominatim.openstreetmap.org', 'https://overpass-api.de', 'https://overpass.kumi.systems', 'https://overpass.private.coffee', 'https://storage.googleapis.com'];
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    `media-src 'self' blob: data: ${api}`,
    `connect-src 'self' blob: data: ${api} ${socket} ${services.join(' ')}`,
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
