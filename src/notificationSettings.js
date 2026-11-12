// Device-level notification settings (like OS settings, not per account), persisted in localStorage.
// Pure helpers live here so the panel, the playback engine and tests share one definition.
import { useSyncExternalStore } from 'react';
import { deviceStorage } from './deviceStorage.js';

export const STORAGE_KEY = 'relay:notification-settings';

export const VIBRATE_OPTIONS = Object.freeze([
  { id: 'default', label: 'Default', pattern: [200, 100, 200] },
  { id: 'short', label: 'Short', pattern: [80] },
  { id: 'long', label: 'Long', pattern: [650] },
  { id: 'off', label: 'Off', pattern: [] },
]);

export const LIGHT_OPTIONS = Object.freeze([
  { id: 'white', label: 'White' }, { id: 'red', label: 'Red' }, { id: 'yellow', label: 'Yellow' },
  { id: 'green', label: 'Green' }, { id: 'cyan', label: 'Cyan' }, { id: 'blue', label: 'Blue' },
  { id: 'purple', label: 'Purple' }, { id: 'none', label: 'None' },
]);

// Tone choices: 'default' | 'silent' | a library tone id | 'custom:<id>' (an uploaded file).
export const DEFAULT_SETTINGS = Object.freeze({
  conversationTones: true,
  reminders: true,
  messages: { tone: 'default', vibrate: 'default', light: 'white', highPriority: true, reactions: true },
  groups: { tone: 'default', vibrate: 'default', light: 'white', highPriority: true, reactions: true },
  calls: { ringtone: 'default', vibrate: 'default' },
  status: { tone: 'default', vibrate: 'default', highPriority: true, reactions: true },
  appBadge: true,
  volume: { notification: 0.8, ringtone: 1 },
});

// Which settings section governs each playback category.
export const CATEGORY_SECTIONS = Object.freeze({
  message: 'messages',
  reaction: 'messages',
  group: 'groups',
  status: 'status',
  incomingCall: 'calls',
});

const VIBRATE_IDS = new Set(VIBRATE_OPTIONS.map((option) => option.id));
const LIGHT_IDS = new Set(LIGHT_OPTIONS.map((option) => option.id));

function pickBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function pickChoice(value, fallback) {
  // Phone sound choices carry a title and a content URI, so they are longer than library ids.
  return typeof value === 'string' && value.length > 0 && value.length <= 1000 ? value : fallback;
}

function pickEnum(value, allowed, fallback) {
  return allowed.has(value) ? value : fallback;
}

function pickVolume(value, fallback) {
  return typeof value === 'number' && value >= 0 && value <= 1 ? value : fallback;
}

// Fills gaps and drops unknown values, so stored settings from older versions never break the UI.
export function normalizeSettings(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const section = (name, defaults) => {
    const given = input[name] && typeof input[name] === 'object' ? input[name] : {};
    const result = {};
    for (const [key, fallback] of Object.entries(defaults)) {
      if (key === 'tone' || key === 'ringtone') result[key] = pickChoice(given[key], fallback);
      else if (key === 'vibrate') result[key] = pickEnum(given[key], VIBRATE_IDS, fallback);
      else if (key === 'light') result[key] = pickEnum(given[key], LIGHT_IDS, fallback);
      else result[key] = pickBoolean(given[key], fallback);
    }
    return result;
  };
  return {
    conversationTones: pickBoolean(input.conversationTones, DEFAULT_SETTINGS.conversationTones),
    reminders: pickBoolean(input.reminders, DEFAULT_SETTINGS.reminders),
    messages: section('messages', DEFAULT_SETTINGS.messages),
    groups: section('groups', DEFAULT_SETTINGS.groups),
    calls: section('calls', DEFAULT_SETTINGS.calls),
    status: section('status', DEFAULT_SETTINGS.status),
    appBadge: pickBoolean(input.appBadge, DEFAULT_SETTINGS.appBadge),
    volume: {
      notification: pickVolume(input.volume?.notification, DEFAULT_SETTINGS.volume.notification),
      ringtone: pickVolume(input.volume?.ringtone, DEFAULT_SETTINGS.volume.ringtone),
    },
  };
}

export function vibrationPattern(id) {
  return VIBRATE_OPTIONS.find((option) => option.id === id)?.pattern ?? VIBRATE_OPTIONS[0].pattern;
}

// The tone choice and vibration a playback category should use, honouring the master switches.
export function soundPlan(category, settings) {
  const sectionName = CATEGORY_SECTIONS[category];
  const section = sectionName ? settings[sectionName] : null;
  if (category === 'incomingCall') {
    return { tone: section.ringtone, vibrate: vibrationPattern(section.vibrate), volume: settings.volume.ringtone };
  }
  if (category === 'outgoingCall') return { tone: 'default', vibrate: [], volume: settings.volume.ringtone };
  if (category === 'sent') {
    return { tone: settings.conversationTones ? 'default' : 'silent', vibrate: [], volume: settings.volume.notification };
  }
  if (!section) return { tone: 'default', vibrate: [], volume: settings.volume.notification };
  const allowed = settings.conversationTones && (category !== 'reaction' || section.reactions);
  return {
    tone: allowed ? section.tone : 'silent',
    vibrate: allowed ? vibrationPattern(section.vibrate) : [],
    volume: settings.volume.notification,
  };
}

// Whether a system notification should be shown for a category while the app is in the background.
export function systemNotificationAllowed(category, settings) {
  const sectionName = CATEGORY_SECTIONS[category];
  const section = sectionName ? settings[sectionName] : null;
  if (!section?.highPriority) return false;
  if (category === 'reaction') return Boolean(section.reactions);
  return true;
}

export const REMINDER_INTERVAL_MS = 30 * 60 * 1000;

// Occasional reminder while the app is open but not being looked at: only when something is unseen
// and at most once per interval.
export function shouldRemind({ enabled, unseenCount, hidden, lastRemindedAt, now }) {
  if (!enabled || !hidden || unseenCount <= 0) return false;
  return now - (lastRemindedAt ?? 0) >= REMINDER_INTERVAL_MS;
}

// Missed calls since the Calls tab was last opened: the Calls tab badge, and part of the app icon badge. Opening
// the tab moves callsSeenAt forward, so the next missed call counts from 1 again.
export function unseenMissedCalls(callLogs = [], callsSeenAt = 0) {
  return callLogs.filter((log) => log.status === 'missed' && Date.parse(log.timestamp) > callsSeenAt).length;
}

// Badge count = chats with unread messages + missed calls not yet viewed in the Calls tab.
export function badgeCount({ enabled, chats = [], callLogs = [], callsSeenAt = 0 }) {
  if (!enabled) return 0;
  const unreadChats = chats.filter((chat) => (chat.unread ?? 0) > 0).length;
  return unreadChats + unseenMissedCalls(callLogs, callsSeenAt);
}

// --- Tiny external store -------------------------------------------------------------------------

const listeners = new Set();
let current = null;

function read() {
  if (current) return current;
  let stored = null;
  try { stored = JSON.parse(deviceStorage.getItem(STORAGE_KEY) ?? 'null'); } catch { stored = null; }
  current = normalizeSettings(stored);
  return current;
}

export function getNotificationSettings() {
  return read();
}

export function updateNotificationSettings(update) {
  const next = normalizeSettings(typeof update === 'function' ? update(read()) : { ...read(), ...update });
  current = next;
  try { deviceStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  for (const listener of listeners) listener(next);
  return next;
}

export function setSectionValue(sectionName, key, value) {
  return updateNotificationSettings((settings) => ({ ...settings, [sectionName]: { ...settings[sectionName], [key]: value } }));
}

export function subscribeNotificationSettings(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useNotificationSettings() {
  return useSyncExternalStore(subscribeNotificationSettings, read, read);
}

// Test hook: forget the cached settings so the next read goes back to storage.
export function resetNotificationSettingsCache() {
  current = null;
}
