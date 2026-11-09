// Android switches that calls depend on, as reported by the native shell's state(). Asked about once, after the
// first sign-in, like a standard app: "Later" is respected; the switches stay reachable from Android's app settings.
export const CALL_ACCESS_ASKED_KEY = 'hm:call-access-asked-v3';

// What the phone still blocks for calls: [] when everything is allowed (or the state is unknown).
export function missingCallAccess(state) {
  if (!state) return [];
  return [
    ...(state.fullScreenCalls === false ? ['fullScreen'] : []),
    ...(state.pictureInPicture === false ? ['pictureInPicture'] : []),
  ];
}

// Whether to show the sheet now: something is blocked and it has never been shown on this phone.
export function shouldAskCallAccess(state, askedBefore) {
  return missingCallAccess(state).length > 0 && !askedBefore;
}
