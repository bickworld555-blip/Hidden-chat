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
// "wifi", "mobile", "roaming", "none" or "unknown" (HiddenNativePlugin.networkState), or null outside the app.
export const nativeNetworkKind = async () => (await invoke('networkState'))?.kind ?? null;
// Settings › Appearance › App icon (HiddenNativePlugin.getAppIcon / setAppIcon): 'default', 'midnight' or 'teal'.
export const nativeGetAppIcon = async () => (await invoke('getAppIcon'))?.id ?? null;
export const nativeSetAppIcon = async (id) => (await invoke('setAppIcon', { id }))?.id ?? null;
// Settings › Storage and data › Proxy (HiddenNativePlugin.getProxy / setProxy, AppProxy.java). setProxy throws the
// phone's reason when it refuses (bad host or port, a web view without proxy support).
export const nativeGetProxy = () => invoke('getProxy');
export async function nativeSetProxy(host, port) {
  const native = (await plugin())?.native;
  if (!native) throw new Error('A proxy can be set in the Android app.');
  return native.setProxy({ host, port: Number(port) || 0 });
}
// Status and navigation bar icons follow the app's theme (dark icons on the light theme).
export const nativeSetSystemBarsTheme = (theme) => invoke('setSystemBarsTheme', { theme });
export const nativeRequestStartupPermissions = async () => remember(await invoke('requestStartupPermissions'));
// The service needs the account before it starts (it stops itself without one), so starting waits for any
// session hand-over still in flight.
let sessionSaved = Promise.resolve(null);
// The *Sound values come from phoneSoundSession(): '' (the app's tone), 'default' or a phone sound URI.
export function nativeSetSession({ origin, token, userId, mutedChats = [], mutedGroups = [], messageSound = '', groupSound = '', ringtoneSound = '' }) {
  sessionSaved = invoke('setSession', { origin, token, userId, mutedChats, mutedGroups, messageSound, groupSound, ringtoneSound });
  return sessionSaved;
}
export const nativeClearSession = () => invoke('clearSession');
// Uploads in progress: { count, label, progress (0-100) }; count 0 ends the "Sending…" foreground service.
export const nativeSetUploads = (state) => invoke('setUploads', state);
// Android Keystore sealing for the local data key (src/secureStorage.js): { sealed } / { value }, null outside the app.
export const nativeSealSecret = (value) => invoke('sealSecret', { value });
export const nativeOpenSecret = (sealed) => invoke('openSecret', { sealed });
// While a call is live the service also holds the microphone/camera, so the call keeps working in the background,
// and shows "<name> · Ongoing call" with a Hang up button (which arrives as callAction "hangup").
// The call is over: the native side clears the call state, Android's call, audio and notifications at once.
export const nativeEndCall = () => invoke('endCall');
export const nativeCallHeartbeat = () => invoke('callHeartbeat');
export const nativeSetCallActive = (active, video = false, name = '', callId = '') => invoke('setCallActive', { active: Boolean(active), video: Boolean(video), name: String(name || ''), callId: String(callId || '') });
// Loudspeaker on/off during a call (off = earpiece, or a headset when one is connected). Resolves { speaker }.
export const nativeSetSpeaker = (on) => invoke('setSpeaker', { on: Boolean(on) });
// Video call with both cameras off: the phone goes to the ear (earpiece + proximity sensor); a camera back on → loudspeaker.
export const nativeSetCallVideoShown = (shown) => invoke('setCallVideoShown', { shown: Boolean(shown) });
// The phone's own sounds: `sound` is 'default' or a URI from nativeListSystemSounds; `ringtone` picks the call stream.
export const nativePlaySystemSound = ({ key, sound = 'default', ringtone = false, loop = false }) => invoke('playSystemSound', { key, sound, ringtone, loop });
// The phone's ringtones (ringtone true) or notification sounds: [{ uri, title }], empty outside the app.
export const nativeListSystemSounds = async (ringtone) => (await invoke('listSystemSounds', { ringtone: Boolean(ringtone) }))?.sounds ?? [];
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
// Link previews made on the phone (LinkFetcher.java): { html, url, contentType } and { data (base64), contentType }.
export const nativeFetchPage = (url) => invoke('fetchPage', { url });
export const nativeFetchImage = (url) => invoke('fetchImage', { url });
// A document opened with Android's "Open with" chooser; rejects with the reason (e.g. no app opens this type).
// `data` (base64) opens bytes the app already has, e.g. an end-to-end encrypted file decrypted on the phone.
export async function nativeOpenMedia({ url, data, filename, mimeType = '' }) {
  const native = (await plugin())?.native;
  if (!native) return null;
  return native.openMedia(data ? { data, filename, mimeType } : { url, filename, mimeType });
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
// "Reply" / "Mark as read" taken on a notification while the app's screen was gone: [{ action, open, text }].
// Missed-call notifications: all of them (Calls tab opened) or one person's (their chat was opened).
export const nativeClearMissedCalls = (peerId) => invoke('clearMissedCalls', peerId ? { peerId } : {});
export const nativeTakeMessageActions = async () => (await invoke('takeMessageActions'))?.actions ?? [];
// Stops the ringing notification; `missed`: the caller hung up first, so a "Missed call" notification takes its place.
export const nativeCancelIncomingCall = ({ missed = false } = {}) => invoke('cancelIncomingCall', { missed: Boolean(missed) });
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
// App lock and screen security (AppSecurity.java): { biometric: 'available'|'none'|'unsupported', secureScreen, transcription }.
export const nativeSecurityStatus = () => invoke('securityStatus');
// The phone's own unlock (fingerprint / face / screen-lock PIN): resolves { ok, error? } (null outside the app).
export const nativeAuthenticate = (title, subtitle = '') => invoke('authenticate', { title, subtitle });
export const nativeSetSecureScreen = (enabled) => invoke('setSecureScreen', { enabled: Boolean(enabled) });
// Saves bytes made on the phone into Download/Hidden Messenger: resolves { saved, path }; rejects with the reason.
export async function nativeSaveBytes({ data, filename, mimeType = '' }) {
  const native = (await plugin())?.native;
  if (!native) return null;
  return native.saveBytes({ data, filename, mimeType });
}
// A voice message transcript made on the phone (Android 13+, VoiceTranscriber.java): { text } or { error }.
export const nativeTranscribeAudio = (data, language = '') => invoke('transcribeAudio', { data, language });
