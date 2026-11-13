// In-app camera, as on WhatsApp: the chat's camera button opens a full-screen viewfinder inside Hidden Messenger.
// Tap the shutter for a photo, hold it to record a video (or switch to Video and tap to start and stop), flip between
// the front and back cameras, turn the flash (torch) on where the phone allows it, or open the gallery. The shot
// opens in a preview with a caption box; Send hands it to the chat (the caption follows as a message).
import { useCallback, useEffect, useRef, useState } from 'react';
import { Image as ImageIcon, RefreshCcw, Send, X, Zap, ZapOff } from 'lucide-react';
import { useBackHandler } from '../backStack.js';
import { cameraVideoType, clockOf } from '../cameraMedia.js';

const HOLD_MS = 350;
const MAX_VIDEO_SECONDS = 5 * 60;

export default function CameraCapture({ onClose, onSend, onGallery, onUnavailable }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const holdRef = useRef(null);
  const timerRef = useRef(null);
  const [facing, setFacing] = useState('environment');
  const [mode, setMode] = useState('photo');
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [torch, setTorch] = useState(null); // null: not supported; true/false: on/off
  const [shot, setShot] = useState(null); // { file, url, kind }
  const [caption, setCaption] = useState('');
  const [error, setError] = useState('');

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  useBackHandler(true, () => (shot ? retake() : close()));

  // The viewfinder: the chosen camera with sound (for videos); without a microphone, video-only.
  useEffect(() => {
    if (shot) return undefined;
    let cancelled = false;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) { onUnavailable?.(); return; }
      const video = { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } };
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video, audio: true });
      } catch {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
        } catch {
          if (!cancelled) onUnavailable?.();
          return;
        }
      }
      if (cancelled) { stream.getTracks().forEach((track) => track.stop()); return; }
      stopStream();
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play?.().catch(() => {});
      }
      const capabilities = stream.getVideoTracks()[0]?.getCapabilities?.() ?? {};
      setTorch(capabilities.torch ? false : null);
    })();
    return () => { cancelled = true; };
  }, [facing, shot, stopStream, onUnavailable]);

  useEffect(() => () => {
    clearInterval(timerRef.current);
    clearTimeout(holdRef.current);
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    stopStream();
  }, [stopStream]);

  useEffect(() => () => { if (shot?.url) URL.revokeObjectURL(shot.url); }, [shot]);

  function close() {
    stopStream();
    onClose();
  }

  async function toggleTorch() {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track || torch === null) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torch }] });
      setTorch(!torch);
    } catch {
      setTorch(null);
    }
  }

  function takePhoto() {
    const video = videoRef.current;
    if (!video?.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    // The front camera's preview is mirrored; the photo is saved the way others see you, as on WhatsApp.
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) { setError('The photo could not be taken.'); return; }
      const file = new File([blob], `IMG-${Date.now()}.jpg`, { type: 'image/jpeg' });
      stopStream();
      setShot({ file, url: URL.createObjectURL(file), kind: 'photo' });
    }, 'image/jpeg', 0.9);
  }

  function startRecording() {
    const stream = streamRef.current;
    if (!stream || typeof MediaRecorder === 'undefined' || recording) return;
    const type = cameraVideoType();
    let recorder;
    try {
      recorder = new MediaRecorder(stream, type ? { mimeType: type, videoBitsPerSecond: 4_000_000 } : undefined);
    } catch {
      setError('Video recording is not supported here.');
      return;
    }
    chunksRef.current = [];
    recorder.ondataavailable = (event) => { if (event.data?.size) chunksRef.current.push(event.data); };
    recorder.onstop = () => {
      clearInterval(timerRef.current);
      setRecording(false);
      const kind = recorder.mimeType || type || 'video/webm';
      const blob = new Blob(chunksRef.current, { type: kind });
      if (!blob.size) return;
      const file = new File([blob], `VID-${Date.now()}.${kind.includes('mp4') ? 'mp4' : 'webm'}`, { type: kind.split(';')[0] });
      stopStream();
      setShot({ file, url: URL.createObjectURL(file), kind: 'video' });
    };
    recorder.start(1000);
    recorderRef.current = recorder;
    setSeconds(0);
    setRecording(true);
    const started = Date.now();
    timerRef.current = setInterval(() => {
      const elapsed = (Date.now() - started) / 1000;
      setSeconds(elapsed);
      if (elapsed >= MAX_VIDEO_SECONDS) recorder.stop();
    }, 250);
  }

  function stopRecording() {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  }

  // Photo mode: tap = photo, hold = video while held. Video mode: tap to start, tap again to stop.
  function shutterDown() {
    if (mode === 'video') return;
    holdRef.current = setTimeout(() => { holdRef.current = 'held'; startRecording(); }, HOLD_MS);
  }
  function shutterUp() {
    if (mode === 'video') {
      if (recording) stopRecording(); else startRecording();
      return;
    }
    if (holdRef.current === 'held') { holdRef.current = null; stopRecording(); return; }
    clearTimeout(holdRef.current);
    holdRef.current = null;
    takePhoto();
  }

  function retake() {
    setShot(null);
    setCaption('');
    setError('');
  }

  if (shot) {
    return (
      <div className="camera-capture is-preview" role="dialog" aria-modal="true" aria-label={shot.kind === 'photo' ? 'Photo preview' : 'Video preview'}>
        <div className="camera-top">
          <button type="button" onClick={retake} aria-label="Retake"><X size={26} /></button>
        </div>
        {shot.kind === 'photo'
          ? <img className="camera-preview" src={shot.url} alt="" />
          : <video className="camera-preview" src={shot.url} controls playsInline autoPlay />}
        <form className="camera-send" onSubmit={(event) => { event.preventDefault(); onSend(shot.file, caption.trim()); }}>
          <input value={caption} onChange={(event) => setCaption(event.target.value)} placeholder="Add a caption…" aria-label="Caption" maxLength={1000} />
          <button type="submit" aria-label="Send"><Send size={22} /></button>
        </form>
      </div>
    );
  }

  return (
    <div className="camera-capture" role="dialog" aria-modal="true" aria-label="Camera">
      <video ref={videoRef} className={`camera-viewfinder${facing === 'user' ? ' is-mirrored' : ''}`} playsInline muted autoPlay />
      <div className="camera-top">
        <button type="button" onClick={close} aria-label="Close camera"><X size={26} /></button>
        {torch !== null && <button type="button" onClick={toggleTorch} aria-label={torch ? 'Flash off' : 'Flash on'}>{torch ? <Zap size={24} /> : <ZapOff size={24} />}</button>}
      </div>
      {recording && <p className="camera-timer" role="status"><span aria-hidden="true" /> {clockOf(seconds)}</p>}
      {error && <p className="camera-error" role="alert">{error}</p>}
      <div className="camera-bottom">
        <div className="camera-controls">
          <button type="button" className="camera-round" onClick={() => { stopStream(); onGallery?.(); }} aria-label="Gallery"><ImageIcon size={24} /></button>
          <button type="button" className={`camera-shutter${recording ? ' is-recording' : ''}${mode === 'video' ? ' is-video' : ''}`}
            onPointerDown={shutterDown} onPointerUp={shutterUp} onPointerLeave={() => { if (holdRef.current === 'held') { holdRef.current = null; stopRecording(); } }}
            onContextMenu={(event) => event.preventDefault()}
            aria-label={mode === 'video' ? (recording ? 'Stop recording' : 'Start recording') : 'Take photo (hold for video)'} />
          <button type="button" className="camera-round" onClick={() => setFacing((side) => (side === 'user' ? 'environment' : 'user'))} disabled={recording}
            aria-label={facing === 'user' ? 'Switch to back camera' : 'Switch to front camera'}><RefreshCcw size={24} /></button>
        </div>
        <div className="camera-modes" role="tablist" aria-label="Camera mode">
          <button type="button" role="tab" aria-selected={mode === 'video'} disabled={recording} onClick={() => setMode('video')}>Video</button>
          <button type="button" role="tab" aria-selected={mode === 'photo'} disabled={recording} onClick={() => setMode('photo')}>Photo</button>
        </div>
        <p className="camera-hint">{mode === 'photo' ? 'Hold for video, tap for photo' : 'Tap to start and stop recording'}</p>
      </div>
    </div>
  );
}
