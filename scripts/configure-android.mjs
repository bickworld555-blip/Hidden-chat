import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export function androidConfig(rawUrl) {
  if (!rawUrl) throw new Error('ANDROID_APP_URL is required. Set it to your running HTTPS app origin serving /api and /ws.');
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('ANDROID_APP_URL must be an HTTPS origin without credentials, paths, query or fragment.');
  }
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('ANDROID_APP_URL must be reachable from the phone, not localhost.');
  if (url.hostname.endsWith('.invalid')) throw new Error('ANDROID_APP_URL cannot use a placeholder .invalid domain.');
  return {
    appId: 'io.github.bickworld555.hiddenchat',
    appName: 'Hidden Chat Test',
    webDir: 'dist',
    loggingBehavior: 'debug',
    server: { url: url.origin, cleartext: false },
    android: { allowMixedContent: false, webContentsDebuggingEnabled: false },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = androidConfig(process.env.ANDROID_APP_URL);
  await writeFile(new URL('../capacitor.config.json', import.meta.url), JSON.stringify(config, null, 2) + '\n');
  console.log(`Android test shell configured for ${config.server.url}. Only load an origin you control.`);
}
