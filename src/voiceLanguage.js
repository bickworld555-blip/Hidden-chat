// The language a voice message is spoken in. The sender's app writes it into the voice message itself
// ("voice:<id>:<seconds>:<once>:<key>:<lang>", src/voice.js), which travels end-to-end encrypted: the server never
// sees it. The receiver's phone then transcribes (and, in the lab build, translates) in the right language instead of
// guessing from its own settings.
export const VOICE_LANGUAGES = Object.freeze([
  { id: 'bn-BD', label: 'বাংলা (Bangla)' },
  { id: 'en-US', label: 'English' },
  { id: 'hi-IN', label: 'हिन्दी (Hindi)' },
  { id: 'ar-SA', label: 'العربية (Arabic)' },
]);
export const VOICE_LANGUAGE_AUTO = 'auto';

// A BCP 47 tag of the simple kind speech recognisers take: "bn", "bn-BD", "fil-PH". Anything else is dropped.
const TAG = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;
export const cleanVoiceLang = (value) => (typeof value === 'string' && TAG.test(value) ? value : '');

const BY_PREFIX = Object.freeze({ bn: 'bn-BD', en: 'en-US', hi: 'hi-IN', ar: 'ar-SA' });

/** The language to record in: the chosen one, or (auto) the phone's language mapped to a supported voice language. */
export function resolveVoiceLanguage(choice, deviceLanguage = globalThis.navigator?.language ?? '') {
  const chosen = cleanVoiceLang(choice);
  if (chosen) return chosen;
  const [prefix = '', region = ''] = String(deviceLanguage).split(/[-_]/);
  const base = prefix.toLowerCase();
  if (BY_PREFIX[base]) return BY_PREFIX[base];
  return cleanVoiceLang(region ? `${base}-${region.toUpperCase()}` : base) || 'en-US';
}

export const voiceLanguageLabel = (id) => VOICE_LANGUAGES.find((item) => item.id === id)?.label ?? id;
