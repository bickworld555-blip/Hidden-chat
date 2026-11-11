// Android switches that add to calls (full-screen ring on the lock screen, the floating video window), as reported
// by the native shell's state(). Shown as a quiet row in the Calls tab (CallAccessNotice), never as a popup.

// What the phone still blocks for calls: [] when everything is allowed (or the state is unknown).
export function missingCallAccess(state) {
  if (!state) return [];
  return [
    ...(state.fullScreenCalls === false ? ['fullScreen'] : []),
    ...(state.pictureInPicture === false ? ['pictureInPicture'] : []),
  ];
}

