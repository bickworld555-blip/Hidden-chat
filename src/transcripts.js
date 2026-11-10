// Voice message transcripts, made on the phone (VoiceTranscriber.java, Android 13+) and kept on this device only
// (encrypted with the rest of local storage), like WhatsApp's.
import { create } from 'zustand';
import { secureGet, secureSet } from './secureStorage.js';
import { nativeSecurityStatus, nativeShell, nativeTranscribeAudio } from './native.js';
import { blobToBase64 } from './fileSave.js';
import { loadMediaBlob } from './media.js';

const KEY = 'hm:voice-transcripts-v1';
const MAX_KEPT = 500;

export const useTranscripts = create(() => ({ texts: {}, pending: {}, errors: {}, available: null, loaded: false }));

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

export async function transcribe(mediaId, sessionToken) {
  const state = useTranscripts.getState();
  if (state.pending[mediaId] || state.texts[mediaId]) return;
  useTranscripts.setState({ pending: { ...state.pending, [mediaId]: true }, errors: { ...state.errors, [mediaId]: undefined } });
  try {
    const blob = await loadMediaBlob(mediaId, sessionToken);
    const result = await nativeTranscribeAudio(await blobToBase64(blob), navigator.language || '');
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
