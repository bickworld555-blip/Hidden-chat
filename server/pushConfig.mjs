// Push and background-delivery timings, tunable on the server without a new APK or web bundle (like WhatsApp's
// server-sent push config: how long its push handler waits, when it falls back).
//
// Set PUSH_TUNING to a JSON object of the keys below (e.g. {"fallbackNoticeMs":10000,"priority":{"react":"normal"}});
// unknown keys are ignored and every value is clamped to its range, so a typo cannot stop pushes or keep a phone awake.
//
// Who reads what:
// - the server: deliveryPushMs, hiddenSettleMs, dedupWindowMs, priority;
// - the phone's push handler (PushService.java): the `cfg` inside each encrypted wake-up push (pushCfg below);
// - the app (src/pushTuning.js, GET /api/v1/push/config): relayWakeQuietMs, relayWakeMaxMs.

const RANGES = Object.freeze({
  // A message written to an open screen is pushed anyway when no device confirmed it within this time.
  deliveryPushMs: [1_000, 60_000, 8_000],
  // Leaving the app announces "offline" once the state has held this long.
  hiddenSettleMs: [0, 30_000, 2_000],
  // The same push (same push id) to the same phone within this window is sent once.
  dedupWindowMs: [5_000, 10 * 60_000, 2 * 60_000],
  // Phone: when the sealed "🔒 Message" stands in for a living app / a cold background page that has not notified yet.
  fallbackNoticeMs: [3_000, 60_000, 8_000],
  headlessFallbackMs: [5_000, 90_000, 12_000],
  // Phone: the latest the sealed notice may wait while a fetch is still running (it is never shown after the fetch
  // finished and notified).
  fallbackMaxMs: [5_000, 120_000, 25_000],
  // Phone: how long the short foreground service ("Checking for new messages") and the wake lock may last at most.
  backgroundFetchMs: [5_000, 170_000, 20_000],
  fetchWakeMs: [5_000, 170_000, 15_000],
  // App: a relay wake-up is done once nothing arrived for relayWakeQuietMs after reconnecting, at most relayWakeMaxMs.
  relayWakeQuietMs: [500, 10_000, 2_000],
  relayWakeMaxMs: [3_000, 120_000, 15_000],
});

// FCM priority per push type. HIGH wakes a phone in Doze at once; Android lowers an app's high-priority pushes that
// show nothing, so only pushes the person sees are high. Every type shows something today.
const PUSH_TYPES = Object.freeze(['msg', 'gmsg', 'react', 'call', 'call_end', 'missed', 'xwake']);
const DEFAULT_PRIORITY = Object.freeze(Object.fromEntries(PUSH_TYPES.map((type) => [type, 'high'])));

function clamp(value, [min, max, fallback]) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

/** The effective tuning: defaults, overridden by PUSH_TUNING (JSON) where valid. */
export function loadPushTuning(env = process.env) {
  let given = {};
  if (env.PUSH_TUNING) {
    try {
      const parsed = JSON.parse(env.PUSH_TUNING);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) given = parsed;
      else console.error('PUSH_TUNING is not a JSON object: defaults used.');
    } catch {
      console.error('PUSH_TUNING is not valid JSON: defaults used.');
    }
  }
  const tuning = {};
  for (const [key, range] of Object.entries(RANGES)) tuning[key] = key in given ? clamp(given[key], range) : range[2];
  // The sealed notice never waits less than its first check.
  tuning.fallbackMaxMs = Math.max(tuning.fallbackMaxMs, tuning.fallbackNoticeMs, tuning.headlessFallbackMs);
  const priority = { ...DEFAULT_PRIORITY };
  for (const [type, value] of Object.entries(given.priority ?? {})) {
    if (PUSH_TYPES.includes(type) && (value === 'high' || value === 'normal')) priority[type] = value;
  }
  tuning.priority = Object.freeze(priority);
  return Object.freeze(tuning);
}

/** The FCM priority ("HIGH" | "NORMAL") for a push body. */
export function fcmPriority(tuning, body) {
  return tuning.priority[body?.t] === 'normal' ? 'NORMAL' : 'HIGH';
}

/** What the phone's push handler reads from a wake-up push (short keys: it travels inside every encrypted push). */
export function pushCfg(tuning) {
  return { f: tuning.fallbackNoticeMs, h: tuning.headlessFallbackMs, x: tuning.fallbackMaxMs, b: tuning.backgroundFetchMs, w: tuning.fetchWakeMs };
}

/** What the app reads (GET /api/v1/push/config). */
export function clientTuning(tuning) {
  return { relayWakeQuietMs: tuning.relayWakeQuietMs, relayWakeMaxMs: tuning.relayWakeMaxMs };
}
