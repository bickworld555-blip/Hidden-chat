import { useEffect, useMemo, useRef, useState } from 'react';
import { AudioLines, Languages, Mic, Pause, Play, Square } from 'lucide-react';
import { checkTranscription, downloadSpeechPack, transcribe, useTranscripts } from '../transcripts.js';
import { formatClock, voiceMimeFromDisposition, waveformPeaks } from '../voice.js';
import { loadMediaBlob, loadMediaInfo } from '../media.js';
import { playExclusiveAudio, stopExclusiveAudio } from '../audioManager.js';
import Avatar from './Avatar.jsx';
import { nativeShell } from '../native.js';
import { useSetting } from '../settings.js';
import { resolveVoiceLanguage, voiceLanguageLabel } from '../voiceLanguage.js';
import { loadSaved as loadTranslations, needsTranslation, playTranslated, stopTranslated, translationKey, useVoiceTranslation } from '../voiceTranslation.js';

const SPEEDS = [1, 1.5, 2];

// `played`: the recipient has listened to it (mic and dot turn from green to blue, like WhatsApp). `onPlayed` is
// given to the recipient only, and runs the first time they play it. `forwarded`: someone else recorded it, so (as on
// WhatsApp) an orange mic stands in for the sender's photo.
export default function VoiceMessage({ id, seconds, lang = '', sessionToken, sender, played = false, forwarded = false, onPlayed, children }) {
  const audioRef = useRef(null);
  // Transcript (Android 13+, made on the phone): shown under the voice note once requested.
  const transcript = useTranscripts((state) => state.texts[id]);
  const transcribing = useTranscripts((state) => Boolean(state.pending[id]));
  const transcriptError = useTranscripts((state) => state.errors[id]);
  const canTranscribe = useTranscripts((state) => state.available);
  const missingPack = useTranscripts((state) => state.missingPacks[id]);
  useEffect(() => { checkTranscription(); }, []);
  // Voice message translation (Android app, Settings › Chats): "Play in Hindi" for a note spoken in another language.
  const translateOn = useSetting('chats.translateVoice');
  const translateTo = resolveVoiceLanguage(useSetting('chats.translateTo'));
  const offerTranslation = Boolean(translateOn && nativeShell() && id && needsTranslation(lang, translateTo));
  const tKey = translationKey(id, translateTo);
  const translated = useVoiceTranslation((state) => state.results[tKey]);
  const translating = useVoiceTranslation((state) => Boolean(state.busy[tKey]));
  const speakingTranslation = useVoiceTranslation((state) => state.playing === tKey);
  const translateError = useVoiceTranslation((state) => state.errors[tKey]);
  useEffect(() => { if (offerTranslation) loadTranslations(); }, [offerTranslation]);
  const urlRef = useRef('');
  const speedRef = useRef(1);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [speedIndex, setSpeedIndex] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(null);
  const peaks = useMemo(() => waveformPeaks(id), [id]);
  const total = Number(seconds) > 0 ? Number(seconds) : 0;
  const progress = total ? Math.min(1, current / total) : 0;

  useEffect(() => () => {
    audioRef.current?.pause();
    stopExclusiveAudio(`voice:${id}`);
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
  }, [id]);

  async function ensureAudio() {
    if (audioRef.current) return audioRef.current;
    // Streams the bytes with progress so the play button can show a percentage while it loads.
    setLoading(0);
    const blob = await loadMediaBlob(id, sessionToken, { onProgress: (fraction) => setLoading(Math.round(fraction * 100)) })
      .catch(() => { throw new Error('Voice message is unavailable.'); })
      .finally(() => setLoading(null));
    const info = await loadMediaInfo(id, sessionToken).catch(() => null);
    urlRef.current = URL.createObjectURL(new Blob([blob], { type: info?.contentType || voiceMimeFromDisposition(null) }));
    const audio = new Audio(urlRef.current);
    audio.playbackRate = speedRef.current;
    audio.ontimeupdate = () => setCurrent(audio.currentTime);
    audio.onended = () => {
      setPlaying(false);
      setCurrent(0);
      stopExclusiveAudio(`voice:${id}`);
    };
    audioRef.current = audio;
    return audio;
  }

  async function toggle() {
    setError('');
    try {
      const audio = await ensureAudio();
      if (audio.paused) {
        // Enforce exclusive playback: auto-pause and reset any other playing audio
        playExclusiveAudio(`voice:${id}`, () => {
          if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current.currentTime = 0;
          }
          setPlaying(false);
          setCurrent(0);
        });

        audio.playbackRate = speedRef.current;
        await audio.play();
        setPlaying(true);
        if (!played) onPlayed?.();
      } else {
        audio.pause();
        setPlaying(false);
        stopExclusiveAudio(`voice:${id}`);
      }
    } catch (caught) {
      setError(caught?.message || 'Voice message could not be played.');
      setPlaying(false);
      stopExclusiveAudio(`voice:${id}`);
    }
  }

  async function seek(event) {
    if (!total) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    try {
      const audio = await ensureAudio();
      audio.currentTime = ratio * total;
      setCurrent(audio.currentTime);
    } catch (caught) {
      setError(caught?.message || 'Voice message could not be played.');
    }
  }

  function cycleSpeed() {
    const next = (speedIndex + 1) % SPEEDS.length;
    speedRef.current = SPEEDS[next];
    if (audioRef.current) audioRef.current.playbackRate = SPEEDS[next];
    setSpeedIndex(next);
  }

  return (
    <div className={`voice-row ${played ? 'is-played' : 'is-unplayed'}`}>
      {forwarded ? (
        <span className="voice-avatar voice-forwarded" aria-hidden="true"><Mic size={22} /></span>
      ) : (
        <span className="voice-avatar">
          <Avatar name={sender?.name} initials={sender?.initials ?? sender?.name?.slice(0, 2)?.toUpperCase() ?? '?'} color={sender?.color} image={sender?.avatar} />
          <span className="voice-badge"><Mic size={11} /></span>
        </span>
      )}
      <div className="voice-main">
        <div className="voice-track">
          <button type="button" className={`voice-play ${loading !== null ? 'is-loading' : ''}`} onClick={toggle} disabled={loading !== null} aria-label={loading !== null ? `Loading voice message, ${loading}%` : playing ? 'Pause voice message' : 'Play voice message'}>
            {loading !== null ? <span className="voice-loading">{loading}%</span> : playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
          </button>
          <div className="voice-wave" onClick={seek} role="slider" aria-label="Voice message position" aria-valuemin={0} aria-valuemax={total} aria-valuenow={Math.round(current)}>
            {peaks.map((peak, index) => (
              <span key={index} className={index / peaks.length < progress ? 'played' : ''} style={{ height: `${peak}%` }} />
            ))}
            <i className="voice-thumb" style={{ left: `${progress * 100}%` }} />
          </div>
        </div>
        <div className="voice-foot">
          <span className="voice-duration">{formatClock(playing || current > 0 ? current : total)}</span>
          {(playing || current > 0) && (
            <button type="button" className="voice-speed" onClick={cycleSpeed} aria-label="Change playback speed">{SPEEDS[speedIndex]}×</button>
          )}
          {canTranscribe && !transcript && (
            <button type="button" className="voice-transcribe" onClick={() => transcribe(id, sessionToken, lang)} disabled={transcribing} aria-label="Transcribe voice message">
              <AudioLines size={14} aria-hidden="true" /> {transcribing ? 'Transcribing…' : 'Transcribe'}
            </button>
          )}
          {offerTranslation && (
            <button type="button" className="voice-transcribe voice-translate" disabled={translating && !speakingTranslation}
              onClick={() => (speakingTranslation ? stopTranslated() : playTranslated(id, sessionToken, lang, translateTo))}
              aria-label={speakingTranslation ? 'Stop the translation' : `Play in ${voiceLanguageLabel(translateTo)}`}>
              {speakingTranslation ? <Square size={12} aria-hidden="true" /> : <Languages size={14} aria-hidden="true" />}
              {speakingTranslation ? 'Stop' : translating ? 'Translating…' : `Play in ${voiceLanguageLabel(translateTo).split(' ')[0]}`}
            </button>
          )}
          {children}
        </div>
        {offerTranslation && translated && <p className="voice-transcript voice-translation" lang={translateTo}>{translated.translation}</p>}
        {offerTranslation && translateError && !translated && <span className="attachment-error">{translateError} Set it up in Settings › Chats › Voice message translation.</span>}
        {transcript && (
          <p className="voice-transcript" lang={typeof transcript === 'string' ? lang || undefined : transcript.language}>
            {typeof transcript === 'string' ? transcript : transcript.text}
            {typeof transcript !== 'string' && <small className="voice-transcript-note"> · in English, made on this phone</small>}
          </p>
        )}
        {transcriptError && !transcript && <span className="attachment-error">{transcriptError}</span>}
        {missingPack && !transcript && (
          <button type="button" className="voice-transcribe" onClick={() => downloadSpeechPack(id)}>{missingPack.code === 'speech_model_missing' ? 'Download speech model (190 MB)' : 'Download speech pack'}</button>
        )}
        {error && <span className="attachment-error">{error}</span>}
      </div>
    </div>
  );
}
