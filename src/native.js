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
// The service needs the account before it starts (it stops itself without one), so starting waits for any
// session hand-over still in flight.
let sessionSaved = Promise.resolve(null);
export function nativeSetSession({ origin, token, userId, mutedChats = [], mutedGroups = [], phoneMessageSound = false, phoneGroupSound = false, phoneRingtone = false }) {
  sessionSaved = invoke('setSession', { origin, token, userId, mutedChats, mutedGroups, phoneMessageSound, phoneGroupSound, phoneRingtone });
  return sessionSaved;
}
export const nativeClearSession = () => invoke('clearSession');
// While a call is live the service also holds the microphone/camera, so the call keeps working in the background,
// and shows "<name> · Ongoing call" with a Hang up button (which arrives as callAction "hangup").
export const nativeSetCallActive = (active, video = false, name = '') => invoke('setCallActive', { active: Boolean(active), video: Boolean(video), name: String(name || '') });
// Loudspeaker on/off during a call (off = earpiece, or a headset when one is connected). Resolves { speaker }.
export const nativeSetSpeaker = (on) => invoke('setSpeaker', { on: Boolean(on) });
// Video call with both cameras off: the phone goes to the ear (earpiece + proximity sensor); a camera back on → loudspeaker.
export const nativeSetCallVideoShown = (shown) => invoke('setCallVideoShown', { shown: Boolean(shown) });
// The phone's own default sounds, for the in-app "Default" tone choice.
export const nativePlaySystemSound = ({ key, ringtone = false, loop = false }) => invoke('playSystemSound', { key, ringtone, loop });
export const nativeStopSystemSound = (key) => invoke('stopSystemSound', { key });
// Outgoing-call ringback on the phone's call stream: earpiece for voice calls, following the Speaker button.
export const nativeStartRingback = async () => Boolean((await invoke('startRingback'))?.played);
export const nativeStopRingback = () => invoke('stopRingback');
// A chat was read: drop its notification and its share of the app icon badge (no tag: every chat).
export const nativeClearMessageNotifications = (tag) => invoke('clearMessageNotifications', tag ? { tag } : {});
// Saves into Download/Hidden Messenger/<Images|Video|Audio|Documents>; resolves { saved, path }.
// Unlike the other calls this one rejects with the reason, so the user can be told why a save failed.
export async function nativeSaveMedia({ id, url, filename, mimeType = '' }) {
  const native = (await plugin())?.native;
  if (!native) return null;
  return native.saveMedia({ id, url, filename, mimeType });
}
export const nativeMoveToBackground = () => invoke('moveToBackground');
// A document opened with Android's "Open with" chooser; rejects with the reason (e.g. no app opens this type).
export async function nativeOpenMedia({ url, filename, mimeType = '' }) {
  const native = (await plugin())?.native;
  if (!native) return null;
  return native.openMedia({ url, filename, mimeType });
}
// A call the background service rang while the app was closed: { event, ice[] } or null.
export const nativeTakePendingCall = async () => (await invoke('takePendingCall'))?.pending ?? null;
export const nativeStartBackground = async () => {
  await sessionSaved;
  return invoke('startBackground');
};
export const nativeStopBackground = () => invoke('stopBackground');
export const nativeNotify = (options) => invoke('notify', options);
export const nativeShowIncomingCall = (options) => invoke('showIncomingCall', options);
export const nativeCancelIncomingCall = () => invoke('cancelIncomingCall');
export const nativeEndCallWindow = () => invoke('endCallWindow');
// An incoming call rings inside the app: keeps it over the lock screen after the call notification is withdrawn.
export const nativeSetCallRinging = (ringing) => invoke('setCallRinging', { ringing: Boolean(ringing) });
// System settings page for 'fullScreen' (ringing calls on the lock screen, Android 14+) or 'pictureInPicture'.
export const nativeOpenCallSettings = (which) => invoke('openCallSettings', { which });
// Opens a link in the app that handles it (YouTube, Facebook, the browser); Back returns to Hidden Messenger.
// Resolves true when Android took it, false outside the app (the caller then opens it in a new tab).
export async function nativeOpenExternal(url) {
  if (!nativeShell()) return false;
  return (await invoke('openExternal', { url })) !== null;
}
export const nativeClearShare = () => invoke('clearShare');
// Recent chats for the top row of Android's share sheet: [{ kind, id, name, initials, color, avatar (base64) }].
export const nativeSetShareTargets = (targets) => invoke('setShareTargets', { targets });

function base64Bytes(data) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

// A file shared to the app from Android's share sheet, read in 512 KB parts into a File for uploading.
export async function nativeReadSharedFile({ index, name, mimeType }, onProgress) {
  const native = (await plugin())?.native;
  if (!native) throw new Error('Shared files can only be read in the Android app.');
  const parts = [];
  let offset = 0;
  for (;;) {
    const chunk = await native.readSharedChunk({ index, offset });
    if (chunk?.data) {
      const bytes = base64Bytes(chunk.data);
      parts.push(bytes);
      offset += bytes.length;
      onProgress?.(offset);
    }
    if (!chunk || chunk.done) break;
  }
  return new File(parts, name || 'shared-file', { type: mimeType || 'application/octet-stream' });
}

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
  sessionSaved = Promise.resolve(null);
  notificationsEnabled = false;
}
