// The app's push and background timings, tuned on the server (server/pushConfig.mjs, PUSH_TUNING) so they change
// without a new bundle or APK. Defaults until the server answers, and whenever it cannot; every value is clamped.
import { apiFetch } from './api.js';

const RANGES = Object.freeze({
  // A relay wake-up in the background is done once nothing has arrived for relayWakeQuietMs after reconnecting, at
  // most relayWakeMaxMs after it started (then Android may let the app sleep again).
  relayWakeQuietMs: [500, 10_000, 2_000],
  relayWakeMaxMs: [3_000, 120_000, 15_000],
});

let current = Object.fromEntries(Object.entries(RANGES).map(([key, [, , fallback]]) => [key, fallback]));

/** The timings in effect now. */
export function pushTuning() {
  return current;
}

/** Takes the server's answer: known keys only, each clamped to its range. */
export function applyPushTuning(given) {
  if (!given || typeof given !== 'object') return current;
  const next = { ...current };
  for (const [key, [min, max]] of Object.entries(RANGES)) {
    const value = Number(given[key]);
    if (Number.isFinite(value)) next[key] = Math.min(max, Math.max(min, Math.round(value)));
  }
  current = next;
  return current;
}

/** Asks the server once per sign-in (GET /api/v1/push/config); a failure keeps what is in effect. */
export async function refreshPushTuning(sessionToken) {
  try {
    const response = await apiFetch('/api/v1/push/config', { headers: { Authorization: `Bearer ${sessionToken}` } });
    if (response.ok) return applyPushTuning(await response.json());
  } catch { /* offline or an older server: defaults */ }
  return current;
}
