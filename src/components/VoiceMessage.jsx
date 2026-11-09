import { useEffect, useMemo, useRef, useState } from 'react';
import { Mic, Pause, Play } from 'lucide-react';
import { formatClock, voiceMimeFromDisposition, waveformPeaks } from '../voice.js';
import { loadMediaBlob, loadMediaInfo } from '../media.js';
import { playExclusiveAudio, stopExclusiveAudio } from '../audioManager.js';
import Avatar from './Avatar.jsx';

const SPEEDS = [1, 1.5, 2];

// `played`: the recipient has listened to it (mic and dot turn from green to blue, like WhatsApp). `onPlayed` is
// given to the recipient only, and runs the first time they play it.
export default function VoiceMessage({ id, seconds, sessionToken, sender, played = false, onPlayed, children }) {
  const audioRef = useRef(null);
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
      <span className="voice-avatar">
        <Avatar name={sender?.name} initials={sender?.initials ?? sender?.name?.slice(0, 2)?.toUpperCase() ?? '?'} color={sender?.color} image={sender?.avatar} />
        <span className="voice-badge"><Mic size={11} /></span>
      </span>
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
          {children}
        </div>
        {error && <span className="attachment-error">{error}</span>}
      </div>
    </div>
  );
}
