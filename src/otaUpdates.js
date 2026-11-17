// Over-the-air web updates, app side (Android shell: OtaUpdates.java; server: server/otaUpdates.mjs).
//
// - Once the app has run for OTA_CONFIRM_AFTER_MS it tells the shell it started properly, so an update on trial is
//   kept (a bundle that breaks before this is rolled back by the shell at the next start).
// - It looks for a newer bundle OTA_FIRST_CHECK_MS after start and again on return to the app, at most every
//   OTA_CHECK_INTERVAL_MS, never while a call is on. A bundle found is prepared in the background and used from the
//   next start, like WhatsApp's own updates: nothing reloads under the person.
import { apiUrl } from './api.js';
import { nativeOtaCheck, nativeOtaReady, nativeShell } from './native.js';

export const OTA_CONFIRM_AFTER_MS = 5_000;
export const OTA_FIRST_CHECK_MS = 20_000;
export const OTA_CHECK_INTERVAL_MS = 6 * 3600_000;

/** Where bundles are published: the API's origin, HTTPS only (null in a browser build without one). */
export function otaOrigin(url = () => apiUrl('/api/')) {
  try {
    const origin = new URL(url()).origin;
    return origin.startsWith('https://') ? origin : null;
  } catch {
    return null;
  }
}

/** Starts the confirm + check cycle; returns a stop function. `busy()` is true while a call is on. */
export function startOtaUpdates({ busy = () => false, now = () => Date.now(), shell = nativeShell, doc = globalThis.document } = {}) {
  if (!shell()) return () => {};
  const origin = otaOrigin();
  let lastCheck = 0;
  let checking = false;
  const check = async () => {
    if (!origin || checking || busy() || now() - lastCheck < OTA_CHECK_INTERVAL_MS) return;
    checking = true;
    lastCheck = now();
    try {
      const result = await nativeOtaCheck(origin);
      if (result === 'ready') console.info('An app update is ready; it is used from the next start.');
    } finally {
      checking = false;
    }
  };
  const confirmTimer = setTimeout(() => { nativeOtaReady(); }, OTA_CONFIRM_AFTER_MS);
  const firstTimer = setTimeout(check, OTA_FIRST_CHECK_MS);
  const onVisible = () => { if (doc?.visibilityState === 'visible') check(); };
  doc?.addEventListener?.('visibilitychange', onVisible);
  return () => {
    clearTimeout(confirmTimer);
    clearTimeout(firstTimer);
    doc?.removeEventListener?.('visibilitychange', onVisible);
  };
}
