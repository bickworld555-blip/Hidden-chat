// Voice message translation, entirely on this phone (Android app). A voice message spoken in another language than
// the person's (its language travels inside the end-to-end encryption, src/voiceLanguage.js) gets "Play in …":
//   decrypt (media.js) → on-device speech-to-text (Android's pack, or whisper.cpp) → ML Kit translation → an offline
//   voice speaks it (VoiceLanguages/VoiceTranslator/VoiceSpeaker.java).
// Nothing is sent anywhere. The transcript and translation are kept on this device, encrypted (secureSet), so a
// second play skips straight to speaking. Models are downloaded only from Settings › Chats › Voice message translation.
import { create } from 'zustand';
import { blobToBase64 } from './fileSave.js';
import { loadMediaBlob } from './media.js';
import {
  nativeDeleteTranslationModel, nativeDeleteWhisperModel, nativeDownloadSpeechLanguage, nativeDownloadTranslationModel,
  nativeDownloadWhisperModel, nativeOpenVoiceInstaller, nativeShell, nativeSpeakText, nativeStopSpeaking,
  nativeTranslateVoice, nativeVoiceLanguageStatus, onNative,
} from './native.js';
import { secureGet, secureSet } from './secureStorage.js';
import { VOICE_LANGUAGES, cleanVoiceLang } from './voiceLanguage.js';

const KEY = 'hm:voice-translations-v1';
const MAX_KEPT = 300;
export const TRANSLATION_LANGUAGES = VOICE_LANGUAGES.map((language) => language.id);

/** Whether a note in `from` needs translating for someone who reads `to` (same base language: no). */
export function needsTranslation(from, to) {
  const source = cleanVoiceLang(from).split('-')[0];
  const target = cleanVoiceLang(to).split('-')[0];
  return Boolean(source && target && source !== target);
}

/**
 * What a language still needs before "Play in …" works, from the native status: the speech step (a system pack or
 * the whisper model), the translation model, an offline voice. Empty when ready.
 */
export function missingFor(status, tag, { speaking = true } = {}) {
  const language = status?.languages?.[tag];
  if (!language) return ['status'];
  const missing = [];
  if (!['system', 'whisper'].includes(language.speech)) missing.push(`speech:${language.speech}`);
  if (!language.translation) missing.push('translation');
  if (speaking && !language.voice) missing.push('voice');
  return missing;
}

export const useVoiceTranslation = create(() => ({
  status: null, checking: false, whisperProgress: null, busy: {}, results: {}, errors: {}, codes: {}, playing: null, loaded: false,
}));
const set = (patch) => useVoiceTranslation.setState(typeof patch === 'function' ? patch : () => patch);

let loading = null;
export function loadSaved() {
  loading ??= secureGet(KEY).then((saved) => {
    set((state) => ({ results: { ...(saved && typeof saved === 'object' ? saved : {}), ...state.results }, loaded: true }));
  }).catch(() => set({ loaded: true }));
  return loading;
}

let progressListening = false;
export async function refreshStatus() {
  if (!nativeShell()) return null;
  if (!progressListening) {
    progressListening = true;
    onNative('whisperDownload', ({ received = 0, total = 0 } = {}) => set({ whisperProgress: { received, total } }));
  }
  set({ checking: true });
  const status = await nativeVoiceLanguageStatus(TRANSLATION_LANGUAGES).catch(() => null);
  set({ status, checking: false });
  return status;
}

async function run(key, work) {
  set((state) => ({ busy: { ...state.busy, [key]: true }, errors: { ...state.errors, [key]: undefined } }));
  try {
    const result = await work();
    if (result && result.ok === false) throw new Error(result.error || 'That did not work on this phone.');
    return result;
  } catch (error) {
    set((state) => ({ errors: { ...state.errors, [key]: error.message } }));
    return null;
  } finally {
    set((state) => { const busy = { ...state.busy }; delete busy[key]; return { busy }; });
    refreshStatus();
  }
}

export const downloadWhisper = () => run('whisper', () => nativeDownloadWhisperModel()).finally(() => set({ whisperProgress: null }));
export const deleteWhisper = () => run('whisper', () => nativeDeleteWhisperModel());
export const downloadTranslation = (tag) => run(`translation:${tag}`, () => nativeDownloadTranslationModel(tag));
export const deleteTranslation = (tag) => run(`translation:${tag}`, () => nativeDeleteTranslationModel(tag));
export const downloadSystemSpeech = (tag) => run(`speech:${tag}`, async () => {
  const result = await nativeDownloadSpeechLanguage(tag);
  return result?.started ? { ok: true } : { ok: false, error: result?.error };
});
export const openVoiceInstaller = () => run('voice', async () => {
  const result = await nativeOpenVoiceInstaller();
  return result?.opened ? { ok: true } : { ok: false, error: 'This phone has no voice installer. Add voices in Android’s text-to-speech settings.' };
});

const resultKey = (mediaId, to) => `${mediaId}|${to}`;

/** Transcribes and translates a voice message (or reuses the kept result), then speaks the translation. */
export async function playTranslated(mediaId, sessionToken, from, to) {
  const key = resultKey(mediaId, to);
  await loadSaved();
  let result = useVoiceTranslation.getState().results[key];
  set((state) => ({ busy: { ...state.busy, [key]: true }, errors: { ...state.errors, [key]: undefined } }));
  try {
    if (!result) {
      const blob = await loadMediaBlob(mediaId, sessionToken);
      const reply = await nativeTranslateVoice(await blobToBase64(blob), from, to);
      if (!reply?.translation) throw Object.assign(new Error(reply?.error || 'This voice message can’t be translated on this phone.'), { code: reply?.code });
      result = { transcript: reply.transcript, translation: reply.translation, engine: reply.engine ?? '' };
      const results = Object.fromEntries(Object.entries({ ...useVoiceTranslation.getState().results, [key]: result }).slice(-MAX_KEPT));
      set({ results });
      await secureSet(KEY, results);
    }
    set({ playing: key });
    const spoken = await nativeSpeakText(result.translation, to);
    if (spoken && spoken.ok === false) throw Object.assign(new Error(spoken.error), { code: spoken.code });
  } catch (error) {
    set((state) => ({ errors: { ...state.errors, [key]: error.message }, codes: { ...state.codes, [key]: error.code } }));
  } finally {
    set((state) => { const busy = { ...state.busy }; delete busy[key]; return { busy, playing: state.playing === key ? null : state.playing }; });
  }
}

export function stopTranslated() {
  set({ playing: null });
  nativeStopSpeaking();
}

export const translationKey = resultKey;
