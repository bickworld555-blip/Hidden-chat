// Android switches that calls depend on, as reported by the native shell's state().
export const CALL_ACCESS_ASKED_KEY = 'hm:call-access-asked-v1';

// What the phone still blocks for calls: [] when everything is allowed (or the state is unknown).
export function missingCallAccess(state) {
  if (!state) return [];
  return [
    ...(state.fullScreenCalls === false ? ['fullScreen'] : []),
    ...(state.pictureInPicture === false ? ['pictureInPicture'] : []),
  ];
}
