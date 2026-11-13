// One registry for Hidden Messenger's settings, like WhatsApp's settings screens built from typed preference rows
// (WaPreference / WaListPreference / WaCheckBoxPreference) over separate stores:
//   • every setting is declared once: section, label, type (choice / switch), options, default, scope;
//   • scope 'device' lives on this phone (versioned record, with migrations from older keys);
//   • scope 'account' lives on the server and follows the account to every device (privacy, like WhatsApp's
//     MexPrivacySettingsHandler); changes apply at once and roll back if the server refuses them;
//   • values are validated on the way in and on the way out (a damaged or old value falls back to the default).
import { VOICE_LANGUAGE_AUTO, VOICE_LANGUAGES } from './voiceLanguage.js';
import { useSyncExternalStore } from 'react';
import { deviceStorage } from './deviceStorage.js';

export const SETTINGS_VERSION = 1;
export const DEVICE_SETTINGS_KEY = 'hm:settings';

const AUDIENCE = Object.freeze([
  { id: 'everyone', label: 'Everyone' },
  { id: 'contacts', label: 'My contacts' },
  { id: 'nobody', label: 'Nobody' },
]);

const MEDIA_KINDS = Object.freeze([
  { id: 'photos', label: 'Photos' }, { id: 'audio', label: 'Audio' }, { id: 'videos', label: 'Videos' }, { id: 'documents', label: 'Documents' },
]);

export const SETTINGS = Object.freeze({
  // --- Privacy (account, enforced by the server) ---
  'privacy.lastSeen': { section: 'privacy', scope: 'account', remote: 'lastSeen', type: 'choice', label: 'Last seen', options: AUDIENCE, default: 'everyone' },
  'privacy.online': {
    section: 'privacy', scope: 'account', remote: 'online', type: 'choice', label: 'Online',
    options: Object.freeze([{ id: 'everyone', label: 'Everyone' }, { id: 'same_as_last_seen', label: 'Same as last seen' }]),
    default: 'same_as_last_seen',
  },
  'privacy.profilePhoto': { section: 'privacy', scope: 'account', remote: 'profilePhoto', type: 'choice', label: 'Profile photo', options: AUDIENCE, default: 'everyone' },
  'privacy.about': { section: 'privacy', scope: 'account', remote: 'about', type: 'choice', label: 'About', options: AUDIENCE, default: 'everyone' },
  'privacy.readReceipts': {
    section: 'privacy', scope: 'account', remote: 'readReceipts', type: 'switch', label: 'Read receipts', default: true,
    hint: "If you turn off read receipts, you won't be able to send or receive read receipts.",
  },
  'privacy.defaultTimer': {
    section: 'privacy', scope: 'account', remote: 'defaultTimer', type: 'choice', label: 'Default message timer',
    options: Object.freeze([{ id: 86400, label: '24 hours' }, { id: 604800, label: '7 days' }, { id: 7776000, label: '90 days' }, { id: 0, label: 'Off' }]),
    default: 0, hint: 'Start new chats with disappearing messages set to your timer.',
  },
  // People find you only by your exact @username (or an invite link you share); off = only through your links.
  'privacy.discoverableByUsername': {
    section: 'privacy', scope: 'account', remote: 'discoverableByUsername', type: 'switch', label: 'Discoverable by username', default: true,
    hint: 'People who type your exact @username can find you. Turn off to be found only through invite links you share.',
  },
  'privacy.silenceUnknownCallers': {
    section: 'privacy', scope: 'account', remote: 'silenceUnknownCallers', type: 'switch', label: 'Silence unknown callers', default: false,
    hint: 'Calls from people you haven’t saved won’t ring. They still show in Calls.',
  },
  // --- Calls (this device) ---
  'calls.noiseCancellation': {
    section: 'calls', scope: 'device', type: 'switch', label: 'Noise cancellation', default: true,
    legacyKey: 'hm:noise-cancellation',
  },
  // --- Chats (this device) ---
  // The language you speak in voice messages; it travels inside the end-to-end encryption so the receiver's phone
  // transcribes it correctly (src/voiceLanguage.js). "Same as the phone" maps the phone's language.
  'chats.voiceLanguage': {
    section: 'chats', scope: 'device', type: 'choice', label: 'Voice message language',
    options: Object.freeze([{ id: VOICE_LANGUAGE_AUTO, label: 'Same as the phone' }, ...VOICE_LANGUAGES]),
    default: 'auto', hint: 'The language you speak in voice messages, so people you send them to can transcribe them on their phone.',
  },
  'chats.keepArchived': {
    section: 'chats', scope: 'device', type: 'switch', label: 'Keep chats archived', default: true,
    hint: 'Archived chats stay archived when you get a new message.',
  },
  // --- Storage and data (this device) ---
  'media.uploadQuality': {
    section: 'storage', scope: 'device', type: 'choice', label: 'Media upload quality',
    options: Object.freeze([{ id: 'standard', label: 'Standard quality' }, { id: 'hd', label: 'HD quality' }]),
    default: 'standard', hint: 'For photos and videos. Standard sends faster and uses less data (videos up to 720p in the Android app); HD sends them at full resolution.',
  },
  // Media auto-download (WhatsApp's rules): which kinds download on their own on each kind of connection. Voice
  // messages always do. A kind left off downloads when tapped; the server keeps it for 30 days until then.
  'media.autoDownload.mobile': { section: 'storage', scope: 'device', type: 'set', label: 'When using mobile data', options: MEDIA_KINDS, default: Object.freeze(['photos']) },
  'media.autoDownload.wifi': { section: 'storage', scope: 'device', type: 'set', label: 'When connected on Wi-Fi', options: MEDIA_KINDS, default: Object.freeze(['photos', 'audio', 'videos', 'documents']) },
  'media.autoDownload.roaming': { section: 'storage', scope: 'device', type: 'set', label: 'When roaming', options: MEDIA_KINDS, default: Object.freeze([]) },
  // --- Security (this device) ---
  'security.appLock': {
    section: 'security', scope: 'device', type: 'choice', label: 'App lock',
    options: Object.freeze([
      { id: 'off', label: 'Off' }, { id: 'immediately', label: 'Immediately' },
      { id: '1m', label: 'After 1 minute' }, { id: '30m', label: 'After 30 minutes' },
    ]),
    default: 'off',
  },
  'security.notifications': {
    section: 'security', scope: 'device', type: 'switch', label: 'Security notifications', default: true,
    hint: 'A notice in the chat when a contact’s security code changes.',
  },
  'security.screenSecurity': {
    section: 'security', scope: 'device', type: 'switch', label: 'Screen security', default: false,
    hint: 'Block screenshots and hide the app’s content in recent apps.',
  },
});

const sectionKeys = (name) => Object.keys(SETTINGS).filter((key) => SETTINGS[key].section === name);
export const SECTIONS = Object.freeze({
  privacy: { title: 'Privacy', keys: sectionKeys('privacy') },
  calls: { title: 'Calls', keys: sectionKeys('calls') },
  storage: { title: 'Storage and data', keys: sectionKeys('storage') },
  security: { title: 'Security', keys: sectionKeys('security') },
});

/** App lock delay in milliseconds (null = off). */
export function appLockDelayMs(value) {
  return { immediately: 0, '1m': 60_000, '30m': 30 * 60_000 }[value] ?? null;
}

/** The value if valid for this setting, otherwise its default. */
export function validSetting(key, value) {
  const definition = SETTINGS[key];
  if (!definition) throw new Error(`Unknown setting ${key}`);
  if (definition.type === 'switch') return typeof value === 'boolean' ? value : definition.default;
  if (definition.type === 'choice') return definition.options.some((option) => option.id === value) ? value : definition.default;
  // 'set': several options at once, kept in the options' order (an empty set is a valid choice: "No media").
  if (definition.type === 'set') return Array.isArray(value) ? definition.options.map((option) => option.id).filter((id) => value.includes(id)) : definition.default;
  return definition.default;
}

export function optionLabel(key, value) {
  return SETTINGS[key]?.options?.find((option) => option.id === value)?.label ?? '';
}

/**
 * Migrations from older storage, applied in order to the device record. Each takes the record and a reader of the
 * old localStorage keys and returns the next record.
 */
export const MIGRATIONS = Object.freeze([
  // v0 → v1: the noise cancellation switch had its own key ("on"/"off", missing = on).
  (record, readLegacy) => {
    const raw = readLegacy(SETTINGS['calls.noiseCancellation'].legacyKey);
    const next = { ...record };
    if (raw === 'on' || raw === 'off') next['calls.noiseCancellation'] = raw === 'on';
    return next;
  },
]);

/** Brings a stored device record up to SETTINGS_VERSION; returns { version, values }. */
export function migrateDeviceRecord(stored, readLegacy = () => null) {
  const version = Number.isInteger(stored?.version) && stored.version >= 0 ? stored.version : 0;
  let values = stored?.values && typeof stored.values === 'object' ? { ...stored.values } : {};
  for (let step = version; step < SETTINGS_VERSION; step += 1) values = MIGRATIONS[step](values, readLegacy);
  return { version: SETTINGS_VERSION, values };
}

/**
 * createSettings({ storage, remote }) → the settings store.
 * storage: { getItem, setItem, removeItem } (localStorage); remote: { load() → {…}, save(patch) → {…} } (privacy API).
 */
export function createSettings({ storage = deviceStorage, remote = null } = {}) {
  const listeners = new Set();
  let device = null;
  let account = {};
  let accountLoaded = false;
  let snapshot = null;

  const readLegacy = (key) => { try { return storage?.getItem(key) ?? null; } catch { return null; } };

  function loadDevice() {
    if (device) return device;
    let stored = null;
    try { stored = JSON.parse(storage?.getItem(DEVICE_SETTINGS_KEY) ?? 'null'); } catch { stored = null; }
    const migrated = migrateDeviceRecord(stored, readLegacy);
    device = migrated.values;
    if (!stored || stored.version !== migrated.version) persistDevice();
    return device;
  }

  function persistDevice() {
    try { storage?.setItem(DEVICE_SETTINGS_KEY, JSON.stringify({ version: SETTINGS_VERSION, values: device })); } catch { /* private mode */ }
  }

  function emit() {
    snapshot = null;
    for (const listener of listeners) listener();
  }

  function get(key) {
    const definition = SETTINGS[key];
    if (!definition) throw new Error(`Unknown setting ${key}`);
    const source = definition.scope === 'device' ? loadDevice() : account;
    return validSetting(key, source[key]);
  }

  return {
    get,
    /** Every setting's current value, plus whether account settings have arrived from the server. */
    snapshot() {
      snapshot ??= { ...Object.fromEntries(Object.keys(SETTINGS).map((key) => [key, get(key)])), accountLoaded };
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Fetches the account settings (privacy) from the server. */
    async loadAccount() {
      if (!remote) return;
      const values = await remote.load();
      account = Object.fromEntries(Object.entries(SETTINGS)
        .filter(([, definition]) => definition.scope === 'account')
        .map(([key, definition]) => [key, values?.[definition.remote]]));
      accountLoaded = true;
      emit();
    },

    /** Changes a setting. Account settings apply at once and roll back if the server refuses (the error is thrown). */
    async set(key, value) {
      const definition = SETTINGS[key];
      if (!definition) throw new Error(`Unknown setting ${key}`);
      const valid = validSetting(key, value);
      if (definition.type === 'set' ? JSON.stringify(valid) !== JSON.stringify(value) : valid !== value) throw new Error(`Invalid value for ${definition.label}.`);
      if (definition.scope === 'device') {
        loadDevice();
        device = { ...device, [key]: value };
        persistDevice();
        emit();
        return value;
      }
      const previous = account[key];
      account = { ...account, [key]: value };
      emit();
      try {
        const saved = await remote.save({ [definition.remote]: value });
        // The server answers with every privacy setting: adopt them (another device may have changed one).
        for (const [otherKey, otherDefinition] of Object.entries(SETTINGS)) {
          if (otherDefinition.scope === 'account' && saved && otherDefinition.remote in saved) account[otherKey] = saved[otherDefinition.remote];
        }
        account = { ...account };
        emit();
        return value;
      } catch (error) {
        account = { ...account, [key]: previous };
        emit();
        throw error;
      }
    },

    /** Signed out: forget the account's settings (device settings stay with the phone). */
    clearAccount() {
      account = {};
      accountLoaded = false;
      emit();
    },
  };
}

// --- The app's shared settings store ------------------------------------------------------------------------
let shared = null;
let sharedRemote = null;
export function appSettings() {
  shared ??= createSettings({ remote: { load: () => sharedRemote?.load?.() ?? {}, save: (patch) => sharedRemote.save(patch) } });
  return shared;
}

/** Points account settings at the signed-in account's server API (or null when signed out). */
export function connectAccountSettings(remote) {
  sharedRemote = remote;
  const settings = appSettings();
  if (!remote) settings.clearAccount();
  else settings.loadAccount().catch(() => {});
}

/** React: the current value of one setting; re-renders only when the settings change. */
export function useSetting(key) {
  const settings = appSettings();
  return useSyncExternalStore(settings.subscribe, () => settings.snapshot()[key], () => SETTINGS[key].default);
}

export function useAccountSettingsLoaded() {
  const settings = appSettings();
  return useSyncExternalStore(settings.subscribe, () => settings.snapshot().accountLoaded, () => false);
}
