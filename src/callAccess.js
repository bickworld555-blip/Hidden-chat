// Android switches that calls depend on, as reported by the native shell's state().
// When the sheet was last shown (ms). It comes back every few days while something is still blocked: asking once
// and never again left lock-screen calls as small banners for anyone who tapped "Later".
export const CALL_ACCESS_ASKED_KEY = 'hm:call-access-asked-at-v2';
export const CALL_ACCESS_REASK_MS = 3 * 24 * 60 * 60 * 1000;

// What the phone still blocks for calls: [] when everything is allowed (or the state is unknown).
// "Display over other apps" is the second way to show calls full screen on the lock screen, so it is only asked for
// while full-screen notifications are off.
export function missingCallAccess(state) {
  if (!state) return [];
  return [
    ...(state.fullScreenCalls === false ? ['fullScreen'] : []),
    ...(state.fullScreenCalls === false && state.overlay === false ? ['overlay'] : []),
    ...(state.pictureInPicture === false ? ['pictureInPicture'] : []),
  ];
}

// Whether to show the sheet now: something is blocked and it was not shown in the last few days.
export function shouldAskCallAccess(state, lastAskedAt, now = Date.now()) {
  if (missingCallAccess(state).length === 0) return false;
  const last = Number(lastAskedAt);
  return !Number.isFinite(last) || last <= 0 || now - last >= CALL_ACCESS_REASK_MS;
}
