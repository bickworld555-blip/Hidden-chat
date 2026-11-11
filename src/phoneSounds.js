// The phone's own sounds, inside the Android app: "Default" means the phone's default sound (whatever the user
// picked in Android's sound settings — Samsung, Xiaomi, Pixel… each brand has its own), and a 'phone:' choice is one
// sound picked from the phone's list. A browser cannot reach system sounds, so there the app's own tones play.
import { getNotificationSettings, soundPlan } from './notificationSettings.js';
import { nativeShell } from './native.js';
import { parsePhoneToneChoice } from './tones.js';

export const PHONE_SOUND_CATEGORIES = Object.freeze(['message', 'reaction', 'group', 'status', 'incomingCall']);

// The sound the native side plays for a tone choice: '' (the app's own tone), 'default' or a content:// URI.
export function nativeSoundFor(choice, inApp = nativeShell()) {
  if (!inApp) return '';
  if (choice === 'default') return 'default';
  return parsePhoneToneChoice(choice)?.uri ?? '';
}

export function phoneSoundFor(category, settings = getNotificationSettings(), inApp = nativeShell()) {
  if (!PHONE_SOUND_CATEGORIES.includes(category)) return '';
  return nativeSoundFor(soundPlan(category, settings).tone, inApp);
}

export function usesPhoneSound(category, settings = getNotificationSettings(), inApp = nativeShell()) {
  return phoneSoundFor(category, settings, inApp) !== '';
}

// What the background service needs to choose its notification channels while the app is closed.
export function phoneSoundSession(settings = getNotificationSettings()) {
  return {
    messageSound: nativeSoundFor(settings.messages?.tone, true),
    groupSound: nativeSoundFor(settings.groups?.tone, true),
    ringtoneSound: nativeSoundFor(settings.calls?.ringtone, true),
  };
}
