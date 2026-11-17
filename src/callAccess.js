// What the phone still blocks for calls, as reported by the native shell's state() (HiddenNativePlugin.state,
// WakeSettings.java). Shown as the "Make calls ring" guide in the Calls tab (CallAccessNotice), never as a popup.
//
// - fullScreen: Android 14+ keeps the full-screen lock-screen ring off for apps installed outside the Play Store.
// - pictureInPicture: the floating video window.
// - battery: Android's battery optimization can delay or drop the wake-up a call push brings (checkable).
// - autostart: Xiaomi, Vivo, Oppo, Realme, Huawei… block apps from starting in the background unless "Autostart" is
//   on. Apps cannot read it, so the step stays until the person says it is done (`confirmed`).
// - sleeping: Samsung's "Sleeping apps" stops an app's background work; "Never sleeping apps" exempts it. Not readable
//   either: confirmed by the person.

export const CALL_ACCESS_CONFIRMED_KEY = 'hm.callAccess.confirmed';
// Steps the app cannot check: the person confirms them after changing the setting.
export const MANUAL_CALL_ACCESS = Object.freeze(['autostart', 'sleeping']);

/** What the phone still blocks for calls, most important first: [] when everything is allowed (or unknown). */
export function missingCallAccess(state, confirmed = []) {
  if (!state) return [];
  const done = new Set(confirmed);
  return [
    ...(state.batteryUnrestricted === false ? ['battery'] : []),
    ...(state.autostartPage === true && !done.has('autostart') ? ['autostart'] : []),
    ...(state.sleepingPage === true && !done.has('sleeping') ? ['sleeping'] : []),
    ...(state.fullScreenCalls === false ? ['fullScreen'] : []),
    ...(state.pictureInPicture === false ? ['pictureInPicture'] : []),
  ];
}

/** Where the switch is on this maker's phones, for the autostart step. */
export function autostartHint(maker = '') {
  const name = String(maker).toLowerCase();
  if (/xiaomi|redmi|poco/.test(name)) return 'Security › Permissions › Autostart: turn on Hidden Messenger. Also Battery saver › No restrictions.';
  if (/vivo|iqoo/.test(name)) return 'Background startup (or High background power consumption): allow Hidden Messenger.';
  if (/oppo|realme|oneplus/.test(name)) return 'Startup manager (Auto launch): allow Hidden Messenger. Also Battery › Allow background activity.';
  if (/huawei|honor/.test(name)) return 'App launch: switch Hidden Messenger to Manage manually and allow all three.';
  return 'Allow Hidden Messenger to start in the background (Autostart).';
}

export function readConfirmed(storage = globalThis.localStorage) {
  try {
    const value = JSON.parse(storage?.getItem(CALL_ACCESS_CONFIRMED_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((item) => MANUAL_CALL_ACCESS.includes(item)) : [];
  } catch {
    return [];
  }
}

export function saveConfirmed(list, storage = globalThis.localStorage) {
  try { storage?.setItem(CALL_ACCESS_CONFIRMED_KEY, JSON.stringify([...new Set(list)].filter((item) => MANUAL_CALL_ACCESS.includes(item)))); } catch {}
}
