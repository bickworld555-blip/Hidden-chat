// Device-facing notification effects: vibration, system notifications, the app badge and reminders.
// Each one checks the settings and degrades silently where the browser lacks the capability.
import { badgeCount, getNotificationSettings, shouldRemind, soundPlan, systemNotificationAllowed } from './notificationSettings.js';
import { channelForCategory, conversationOpenParam } from './notificationChannels.js';
import { nativeNotify, nativeShell } from './native.js';
import { plainText } from './textFormat.js';
import { usesPhoneSound } from './phoneSounds.js';

export function vibrateFor(category) {
  const plan = soundPlan(category, getNotificationSettings());
  if (!plan.vibrate.length || typeof navigator === 'undefined' || !navigator.vibrate) return false;
  try { return navigator.vibrate(plan.vibrate); } catch { return false; }
}

export function stopVibration() {
  try { navigator.vibrate?.(0); } catch { /* unsupported */ }
}

export function notificationPermission() {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

export async function requestNotificationPermission() {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try { return await Notification.requestPermission(); } catch { return Notification.permission; }
}

// Shows a system notification for a category while the app is not being looked at. Sound and
// vibration are handled by the app itself (each channel has its own tone), so the notification is silent.
// Android Chrome only allows notifications from the service worker (the Notification constructor throws
// there), so the registration is used whenever one is active; clicks then arrive via postMessage.
// `messageId` lets Android show a message once even when a push and the app both deliver it.
export async function showSystemNotification(category, { title, body: rawBody, tag, conversation, onClick, count = 0, messageId } = {}) {
  // Formatting markers (*bold* …) read as noise in a notification: show the plain words.
  const body = typeof rawBody === 'string' ? plainText(rawBody) : rawBody;
  if (typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus?.()) return null;
  if (!systemNotificationAllowed(category, getNotificationSettings())) return null;
  const channel = channelForCategory(category);
  // Inside the Android app the native channel posts it (with that channel's own sound).
  if (nativeShell()) {
    // One notification per conversation (tag "chat:<id>" / "group:<id>", cleared when the chat is read), with its
    // unread count for the app icon badge; "Default" tone = the phone's own sound channel.
    const base = channel.id === 'group_messages' ? 'group_messages' : 'direct_messages';
    const open = conversationOpenParam(conversation);
    const result = await nativeNotify({
      channel: usesPhoneSound(category, undefined, true) ? `${base}_phone` : base,
      title,
      body,
      tag: category === 'reaction' ? `${channel.id}:${tag ?? open}` : (open || tag),
      open,
      count,
      ...(messageId ? { messageId } : {}),
    });
    return result?.shown ? 'native' : null;
  }
  if (notificationPermission() !== 'granted') return null;
  const options = {
    body,
    tag: `${channel.id}:${tag ?? conversationOpenParam(conversation)}`,
    silent: true,
    renotify: true,
    icon: '/icons/icon-192.png?v=2',
    data: { channel: channel.id, open: conversationOpenParam(conversation) },
  };
  try {
    const registration = await navigator.serviceWorker?.getRegistration?.();
    if (registration?.showNotification) {
      await registration.showNotification(title, options);
      return 'service-worker';
    }
  } catch { /* fall back to the page notification below */ }
  try {
    const notification = new Notification(title, options);
    notification.onclick = () => {
      window.focus();
      onClick?.();
      notification.close();
    };
    return notification;
  } catch {
    return null;
  }
}

const TITLE_PATTERN = /^\(\d+\)\s*/;

// Badging API for installed apps, with the tab title as the fallback everyone can see.
export function applyAppBadge({ chats, callLogs, callsSeenAt }) {
  const count = badgeCount({ enabled: getNotificationSettings().appBadge, chats, callLogs, callsSeenAt });
  try {
    if (count > 0) navigator.setAppBadge?.(count);
    else navigator.clearAppBadge?.();
  } catch { /* not installed */ }
  if (typeof document !== 'undefined') {
    const base = document.title.replace(TITLE_PATTERN, '');
    document.title = count > 0 ? `(${count}) ${base}` : base;
  }
  return count;
}

let lastReminderAt = 0;

export function maybeRemind({ unseenCount, now = Date.now() }) {
  const settings = getNotificationSettings();
  const hidden = typeof document !== 'undefined' && document.visibilityState !== 'visible';
  if (!shouldRemind({ enabled: settings.reminders, unseenCount, hidden, lastRemindedAt: lastReminderAt, now })) return false;
  lastReminderAt = now;
  if (notificationPermission() !== 'granted') return false;
  try {
    new Notification('Hidden Messenger', { body: `You have ${unseenCount} unseen ${unseenCount === 1 ? 'update' : 'updates'}.`, tag: 'relay-reminder', silent: true });
  } catch { /* ignore */ }
  return true;
}
