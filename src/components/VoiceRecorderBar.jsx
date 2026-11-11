import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ChevronLeft, ChevronUp, Lock, Mic, Pause, Play, Send, Square, Trash2 } from 'lucide-react';
import { formatClock } from '../voice.js';
import { createRecordingClock, voiceAudioConstraints, voiceRecorderOptions } from '../voiceRecording.js';
import { levelFromSamples } from '../audioLevel.js';
import { drawWaveform } from '../waveformCanvas.js';

const SAMPLE_MS = 90;
const MAX_BARS = 36;

// `hold`: while the mic is held, how far the finger has moved ({ x, y } in px, both <= 0); null once locked.
// The parent tracks the gesture and calls the ref's send() (released) or discard() (slid left).
const VoiceRecorderBar = forwardRef(function VoiceRecorderBar({ onSend, onCancel, onError, allowViewOnce = false, hold = null }, ref) {
  const [seconds, setSeconds] = useState(0);
  const [paused, setPaused] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  // The waveform lives on a canvas, fed from a ref: recording never re-renders the bar for a new sample.
  const canvasRef = useRef(null);
  const [viewOnce, setViewOnce] = useState(false);
  const [toast, setToast] = useState('');
  const viewOnceRef = useRef(false);
  const sessionRef = useRef(null);
  const callbacksRef = useRef({ onSend, onCancel, onError });
  callbacksRef.current = { onSend, onCancel, onError };

  useEffect(() => {
    let disposed = false;
    const session = {
      recorder: null, stream: null, chunks: [], mode: 'cancel',
      clock: createRecordingClock(), ctx: null, analyser: null, timer: 0, frame: 0, levels: [], preview: null, previewUrl: '',
    };
    sessionRef.current = session;

    // Recorded length in seconds; paused stretches never count.
    session.elapsedNow = () => session.clock.elapsed();
    session.stopPreview = () => {
      session.preview?.pause();
      session.preview = null;
      if (session.previewUrl) URL.revokeObjectURL(session.previewUrl);
      session.previewUrl = '';
      setPreviewing(false);
    };
    session.release = () => {
      clearInterval(session.timer);
      cancelAnimationFrame(session.frame);
      session.stopPreview();
      session.stream?.getTracks().forEach((track) => track.stop());
      session.stream = null;
      session.ctx?.close?.().catch(() => {});
      session.ctx = null;
    };

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        callbacksRef.current.onError('Voice recording is not supported in this browser.');
        callbacksRef.current.onCancel();
        return;
      }
      let stream;
      try {
        // Noise suppression, echo cancellation and automatic gain (the phone's own audio effects where it has them).
        stream = await navigator.mediaDevices.getUserMedia(voiceAudioConstraints(navigator.mediaDevices.getSupportedConstraints?.() ?? {}));
      } catch {
        if (!disposed) {
          callbacksRef.current.onError('Microphone access was denied.');
          callbacksRef.current.onCancel();
        }
        return;
      }
      if (disposed) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      session.stream = stream;
      // Opus at a voice bitrate (small, clear notes); falls back to the browser's default format if it must.
      let recorder;
      try {
        recorder = new MediaRecorder(stream, voiceRecorderOptions(MediaRecorder));
      } catch {
        recorder = new MediaRecorder(stream);
      }
      session.recorder = recorder;
      recorder.ondataavailable = (event) => { if (event.data?.size) session.chunks.push(event.data); };
      recorder.onstop = () => {
        const send = session.mode === 'send' && session.chunks.length > 0;
        const type = recorder.mimeType || 'audio/webm';
        const duration = Math.max(1, Math.round(session.clock.elapsed()));
        const blob = send ? new Blob(session.chunks, { type }) : null;
        session.release();
        if (blob) callbacksRef.current.onSend(blob, duration, type, { viewOnce: viewOnceRef.current });
        else callbacksRef.current.onCancel();
      };

      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        try {
          session.ctx = new AudioContextClass();
          session.analyser = session.ctx.createAnalyser();
          session.analyser.fftSize = 256;
          session.ctx.createMediaStreamSource(stream).connect(session.analyser);
        } catch {
          session.analyser = null;
        }
      }
      const samples = new Uint8Array(256);
      // A new bar every SAMPLE_MS while recording (frozen while paused); the seconds only re-render when they change.
      session.timer = setInterval(() => {
        if (recorder.state !== 'recording') return;
        setSeconds(Math.floor(session.elapsedNow()));
        if (!session.analyser) return;
        session.analyser.getByteTimeDomainData(samples);
        session.levels.push(levelFromSamples(samples));
        if (session.levels.length > MAX_BARS) session.levels.shift();
      }, SAMPLE_MS);
      // Drawn once per screen frame from the ref, like WhatsApp's VoiceParticipantAudioWave (canvas, not views).
      const paint = () => {
        session.frame = requestAnimationFrame(paint);
        drawWaveform(canvasRef.current, session.levels, MAX_BARS);
      };
      session.frame = requestAnimationFrame(paint);

      // Slices every second, so a pause can preview everything recorded so far.
      recorder.start(1000);
      session.clock.start();
    })();

    return () => {
      disposed = true;
      session.mode = 'cancel';
      if (session.recorder && session.recorder.state !== 'inactive') session.recorder.stop();
      else session.release();
    };
  }, []);

  function discard() {
    const session = sessionRef.current;
    if (!session) return;
    session.mode = 'cancel';
    if (session.recorder && session.recorder.state !== 'inactive') session.recorder.stop();
    else {
      session.release();
      callbacksRef.current.onCancel();
    }
  }

  function send() {
    const session = sessionRef.current;
    const recorder = session?.recorder;
    // Released before the microphone opened: nothing was recorded.
    if (!recorder) return discard();
    if (recorder.state === 'inactive') return;
    session.clock.pause();
    session.mode = 'send';
    recorder.stop();
  }

  useImperativeHandle(ref, () => ({ send, discard }));

  function togglePause() {
    const session = sessionRef.current;
    const recorder = session?.recorder;
    if (!recorder) return;
    if (recorder.state === 'recording') {
      recorder.pause();
      session.clock.pause();
      // Flush what was recorded so far, so the preview plays all of it.
      recorder.requestData();
      setSeconds(Math.floor(session.clock.elapsed()));
      setPaused(true);
    } else if (recorder.state === 'paused') {
      session.stopPreview();
      recorder.resume();
      session.clock.resume();
      setPaused(false);
    }
  }

  function toggleViewOnce() {
    const next = !viewOnceRef.current;
    viewOnceRef.current = next;
    setViewOnce(next);
    setToast(next ? 'Voice message set to view once' : 'View once turned off');
  }

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(''), 2200);
    return () => clearTimeout(timer);
  }, [toast]);

  function togglePreview() {
    const session = sessionRef.current;
    if (!session || !paused) return;
    if (session.preview) {
      session.stopPreview();
      return;
    }
    if (session.chunks.length === 0) return;
    session.previewUrl = URL.createObjectURL(new Blob(session.chunks, { type: session.recorder?.mimeType || 'audio/webm' }));
    const audio = new Audio(session.previewUrl);
    audio.onended = () => session.stopPreview();
    session.preview = audio;
    audio.play().then(() => setPreviewing(true)).catch(() => session.stopPreview());
  }

  if (hold) {
    // Held: only the clock, "slide to cancel" (following the finger) and the lock above the mic.
    return (
      <div className="composer recording-mode is-held" role="group" aria-label="Recording voice message: release to send, slide left to cancel, slide up to lock">
        <span className="recording-indicator" aria-live="off">
          <i className="recording-dot" />
          {formatClock(seconds)}
        </span>
        <span className="recording-slide" style={{ transform: `translateX(${hold.x}px)`, opacity: Math.max(0.2, 1 + hold.x / 160) }}>
          <ChevronLeft size={16} aria-hidden="true" /> Slide to cancel
        </span>
        <span className="recording-lock" style={{ transform: `translateY(${hold.y}px)` }} aria-hidden="true">
          <Lock size={16} />
          <ChevronUp size={14} />
        </span>
        <span className="recording-held-mic" aria-hidden="true"><Mic size={24} /></span>
      </div>
    );
  }

  return (
    <div className="composer recording-mode" role="group" aria-label="Recording voice message">
      <button type="button" className="recording-trash" onClick={discard} aria-label="Discard voice message"><Trash2 size={20} /></button>
      <span className={`recording-indicator ${paused ? 'paused' : ''}`} aria-live="off">
        <i className="recording-dot" />
        {formatClock(seconds)}
      </span>
      <canvas ref={canvasRef} className="recording-wave" aria-hidden="true" />
      <button type="button" className="recording-pause" onClick={togglePause} aria-label={paused ? 'Resume recording' : 'Pause recording'}>
        {paused ? <Play size={18} /> : <Pause size={18} />}
      </button>
      <button type="button" className="recording-preview" onClick={togglePreview} disabled={!paused} aria-label={previewing ? 'Stop preview' : 'Preview recording'}>
        {previewing ? <Square size={15} /> : <Play size={15} />}
      </button>
      {allowViewOnce && (
        <button
          type="button"
          className={`recording-view-once${viewOnce ? ' is-on' : ''}`}
          onClick={toggleViewOnce}
          aria-pressed={viewOnce}
          aria-label={viewOnce ? 'View once on' : 'Send as view once'}
          title="View once"
        >
          1
        </button>
      )}
      <button type="button" className="send-button voice-send" onClick={send} aria-label={viewOnce ? 'Send view once voice message' : 'Send voice message'}><Send size={19} /></button>
      {toast && <span className="recording-toast" role="status">{toast}</span>}
    </div>
  );
});

export default VoiceRecorderBar;
