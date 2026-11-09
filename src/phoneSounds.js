// The "Default" tone choice: inside the Android app it means the phone's own sound (whatever the user picked in
// Android's sound settings — Samsung, Xiaomi, Pixel… each brand has its own); in a browser, which cannot reach
// system sounds, the app's built-in default tone plays instead.
import { getNotificationSettings, soundPlan } from './notificationSettings.js';
import { nativeShell } from './native.js';

export const PHONE_SOUND_CATEGORIES = Object.freeze(['message', 'reaction', 'group', 'status', 'incomingCall']);

export function usesPhoneSound(category, settings = getNotificationSettings(), inApp = nativeShell()) {
  return inApp && PHONE_SOUND_CATEGORIES.includes(category) && soundPlan(category, settings).tone === 'default';
}

// What the background service needs to choose its notification channels while the app is closed.
export function phoneSoundSession(settings = getNotificationSettings()) {
  return {
    phoneMessageSound: settings.messages?.tone === 'default',
    phoneGroupSound: settings.groups?.tone === 'default',
    phoneRingtone: settings.calls?.ringtone === 'default',
  };
}
