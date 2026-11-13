// Voice message transcripts, made on the phone (VoiceTranscriber.java, Android 13+) and kept on this device only
// (encrypted with the rest of local storage), like WhatsApp's.
import { create } from 'zustand';
import { secureGet, secureSet } from './secureStorage.js';
import { nativeDownloadSpeechLanguage, nativeDownloadWhisperModel, nativeSecurityStatus, nativeShell, nativeTranscribeAudio } from './native.js';
import { blobToBase64 } from './fileSave.js';
import { loadMediaBlob } from './media.js';
import { VOICE_LANGUAGE_AUTO, cleanVoiceLang, resolveVoiceLanguage } from './voiceLanguage.js';

const KEY = 'hm:voice-transcripts-v1';
const MAX_KEPT = 500;

export const useTranscripts = create(() => ({ texts: {}, pending: {}, errors: {}, missingPacks: {}, available: null, loaded: false }));

let loading = null;
function loadSaved() {
  loading ??= secureGet(KEY).then((saved) => {
    useTranscripts.setState((state) => ({ texts: { ...(saved && typeof saved === 'object' ? saved : {}), ...state.texts }, loaded: true }));
  }).catch(() => useTranscripts.setState({ loaded: true }));
  return loading;
}

/** Whether this device can transcribe (asked once). */
export function checkTranscription() {
  loadSaved();
  if (useTranscripts.getState().available !== null) return;
  if (!nativeShell()) {
    useTranscripts.setState({ available: false });
    return;
  }
  nativeSecurityStatus().then((status) => useTranscripts.setState({ available: Boolean(status?.transcription) })).catch(() => useTranscripts.setState({ available: false }));
}

// lang: the language the sender spoke (inside the encrypted voice message, src/voiceLanguage.js). Older notes carry
// none; then the phone's own language is the best guess.
export async function transcribe(mediaId, sessionToken, lang = '') {
  const state = useTranscripts.getState();
  if (state.pending[mediaId] || state.texts[mediaId]) return;
  const { [mediaId]: _retried, ...missingPacks } = state.missingPacks;
  useTranscripts.setState({ pending: { ...state.pending, [mediaId]: true }, errors: { ...state.errors, [mediaId]: undefined }, missingPacks });
  try {
    const blob = await loadMediaBlob(mediaId, sessionToken);
    const language = cleanVoiceLang(lang) || resolveVoiceLanguage(VOICE_LANGUAGE_AUTO);
    const result = await nativeTranscribeAudio(await blobToBase64(blob), language);
    // Something to download first: Android's pack for the language, or (no pack exists) the offline speech model.
    if (result?.code === 'language_pack_missing' || result?.code === 'speech_model_missing') {
      useTranscripts.setState((current) => ({ missingPacks: { ...current.missingPacks, [mediaId]: { language, code: result.code } } }));
    }
    if (!result?.text) throw new Error(result?.error || 'This voice message can’t be transcribed on this phone.');
    await loadSaved();
    const texts = { ...useTranscripts.getState().texts, [mediaId]: result.text };
    const kept = Object.fromEntries(Object.entries(texts).slice(-MAX_KEPT));
    useTranscripts.setState({ texts: kept });
    await secureSet(KEY, kept);
  } catch (error) {
    useTranscripts.setState((current) => ({ errors: { ...current.errors, [mediaId]: error.message } }));
  } finally {
    useTranscripts.setState((current) => {
      const pending = { ...current.pending };
      delete pending[mediaId];
      return { pending };
    });
  }
}

/**
 * The phone has no on-device pack for the language a note was spoken in: ask Android's speech service to download it
 * (it shows its own progress), then the person taps Transcribe again. Transcripts never fall back to a server.
 */
export async function downloadSpeechPack(mediaId) {
  const missing = useTranscripts.getState().missingPacks[mediaId];
  if (!missing) return;
  if (missing.code === 'speech_model_missing') {
    useTranscripts.setState((current) => ({ errors: { ...current.errors, [mediaId]: 'Downloading the offline speech model (190 MB)…' } }));
    const done = await nativeDownloadWhisperModel().catch(() => null);
    useTranscripts.setState((current) => {
      const missingPacks = { ...current.missingPacks };
      delete missingPacks[mediaId];
      return { missingPacks, errors: { ...current.errors, [mediaId]: done?.ok ? 'The speech model is ready. Tap Transcribe again.' : (done?.error || 'The speech model could not be downloaded.') } };
    });
    return;
  }
  const result = await nativeDownloadSpeechLanguage(missing.language).catch(() => null);
  useTranscripts.setState((current) => {
    const missingPacks = { ...current.missingPacks };
    delete missingPacks[mediaId];
    return {
      missingPacks,
      errors: { ...current.errors, [mediaId]: result?.started ? 'Downloading the speech pack. Tap Transcribe again when it’s done.' : (result?.error || 'The speech pack could not be downloaded on this phone.') },
    };
  });
}
