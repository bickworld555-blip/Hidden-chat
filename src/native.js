// Bridge to the Android shell's "HiddenNative" plugin (runtime permissions, background connection,
// channel notifications and the incoming-call notification). Everything here is a no-op in a browser
// and in older APKs that do not ship the plugin, so callers can use it unconditionally.
let pluginPromise = null;
let notificationsEnabled = false;

export function nativeShell(win = globalThis) {
  const capacitor = win?.Capacitor;
  return Boolean(capacitor?.isNativePlatform?.() && capacitor.isPluginAvailable?.('HiddenNative'));
}

// registerPlugin() returns a Proxy that answers every property, including `then`; resolving a promise with it
// would call the non-existent HiddenNative.then(), so the plugin travels wrapped in a plain
// object and callers unwrap it only after awaiting.
function plugin() {
  if (!nativeShell()) return Promise.resolve(null);
  pluginPromise ??= import('@capacitor/core').then(({ registerPlugin }) => ({ native: registerPlugin('HiddenNative') }));
  return pluginPromise;
}

async function invoke(method, options) {
  const native = (await plugin())?.native;
  if (!native) return null;
  try {
    return await native[method](options);
  } catch (error) {
    console.warn(`HiddenNative.${method} failed`, error);
    return null;
  }
}

function remember(state) {
  if (state && typeof state.notificationsEnabled === 'boolean') notificationsEnabled = state.notificationsEnabled;
  return state;
}

export const nativeState = async () => remember(await invoke('getState'));
export const nativeRequestStartupPermissions = async () => remember(await invoke('requestStartupPermissions'));
export const nativeRequestBatteryExemption = async () => remember(await invoke('requestBatteryExemption'));
export const nativeStartBackground = () => invoke('startBackground');
export const nativeStopBackground = () => invoke('stopBackground');
export const nativeNotify = (options) => invoke('notify', options);
export const nativeShowIncomingCall = (options) => invoke('showIncomingCall', options);
export const nativeCancelIncomingCall = () => invoke('cancelIncomingCall');
export const nativeEndCallWindow = () => invoke('endCallWindow');

// While the app is in the background inside the Android shell with notifications allowed, the native
// channel (its own sound) is what alerts; the web app stays quiet so nothing plays twice.
export function nativeAlertsActive(doc = globalThis.document) {
  return nativeShell() && notificationsEnabled && doc?.visibilityState === 'hidden';
}

async function listen(eventName, handler) {
  const native = (await plugin())?.native;
  return native ? native.addListener(eventName, handler) : null;
}

// Returns an unsubscribe function; safe to call before the listener is attached.
export function onNative(eventName, handler) {
  let handle = null;
  let removed = false;
  listen(eventName, handler).then((result) => {
    handle = result;
    if (removed) handle?.remove();
  });
  return () => {
    removed = true;
    handle?.remove();
  };
}

export function resetNativeStateForTests() {
  pluginPromise = null;
  notificationsEnabled = false;
}
