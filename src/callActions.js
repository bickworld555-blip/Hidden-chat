// Actions on a call that come from Android (the notification, the lock screen, a headset, car or watch) reach the
// call screen as "callAction" events, which Android keeps until a call screen listens. One kept from an earlier call
// must not answer or end the next call.
// How long an action from Android (notification, headset, lock screen) stays valid: an Answer covers the app starting
// from closed while the call still rings; the others act on a call that is on screen now.
export const CALL_ACTION_MAX_AGE_MS = { accept: 60_000, default: 15_000 };
export function staleCallAction(action, at, now = Date.now()) {
  if (typeof at !== 'number' || !Number.isFinite(at)) return false; // an APK that does not say when: as before
  return now - at > (CALL_ACTION_MAX_AGE_MS[action] ?? CALL_ACTION_MAX_AGE_MS.default);
}
