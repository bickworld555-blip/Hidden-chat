// The chat list's picture for the next cold start (Android app, LaunchSnapshot.java). Android needs about 0.7 s to
// start the web view engine before this code runs, so the app shows a saved picture of the chat list until the live
// one has drawn. This module tells the native side when the screen is one worth keeping, and when the live screen is
// up.
//
// The picture shows names and last messages, so it is taken only of the plain chat list: signed in, the phone
// layout's list (not a chat or another tab), nothing open over it (the back stack is empty), no call, the app not
// locked, and the list itself not in its locked folder, archive, search, a menu or a selection (ChatsList reports
// that). It is never kept while app lock or screen security is on.
import { backStackDepth, onBackStackChange } from './backStack.js';
import { nativeLaunchReady, nativeSetLaunchSnapshot, nativeShell } from './native.js';

/** { onShow, allowed } for the native side, from what the app and the list report. Pure. */
export function launchSnapshotState({ signedIn = false, listScreen = false, listPlain = false, overlays = 0, inCall = false, locked = false, appLock = false, screenSecurity = false } = {}) {
  const allowed = Boolean(signedIn) && !appLock && !screenSecurity;
  const onShow = allowed && Boolean(listScreen) && Boolean(listPlain) && overlays === 0 && !inCall && !locked;
  return { onShow, allowed };
}

const facts = { signedIn: false, listScreen: false, listPlain: false, inCall: false, locked: false, appLock: false, screenSecurity: false };
let sent = '';
let watching = false;
// Nothing is told to the native side before the app has reported once: its "allowed: false" deletes the picture, and
// the first render does not know yet whether an account is signed in.
let reported = false;

function sync() {
  if (!reported || !nativeShell()) return;
  if (!watching) {
    watching = true;
    onBackStackChange(sync);
  }
  const state = launchSnapshotState({ ...facts, overlays: backStackDepth() });
  const key = `${state.onShow}:${state.allowed}`;
  if (key === sent) return;
  sent = key;
  nativeSetLaunchSnapshot(state);
}

/** App.jsx, once the saved account is known: { signedIn, listScreen, inCall, locked, appLock, screenSecurity }. */
export function reportLaunchSnapshotApp(next) {
  Object.assign(facts, next);
  reported = true;
  sync();
}

/** ChatsList: true while it shows the plain list (not the locked folder, archive, search, a menu or a selection). */
export function reportChatListPlain(plain) {
  facts.listPlain = Boolean(plain);
  sync();
}

let readySent = false;
/** The live screen has drawn: after two frames (so it is on the glass) the saved picture goes away. Once per page. */
export function launchScreenReady() {
  if (readySent || !nativeShell()) return;
  readySent = true;
  const frame = globalThis.requestAnimationFrame ?? ((run) => setTimeout(run, 16));
  frame(() => frame(() => nativeLaunchReady()));
}
