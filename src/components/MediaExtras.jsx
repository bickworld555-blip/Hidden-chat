// View once photos and videos, round video notes and stickers made from your own photos (WhatsApp parity).
// All three are attachments encrypted on the device (src/mediaCrypto.js) inside end-to-end encrypted messages:
//   "viewonce:<attachment>"  opened once by the recipient (POST /messages/:id/view-once), then "media-opened:"
//   "vnote:<attachment>"     a round video up to VIDEO_NOTE_SECONDS, recorded with the front camera
//   "csticker:<attachment>"  a 512 px sticker cut from a photo; kept in "My stickers" on this device
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';

// The opened view once photo/video lives here, not in its bubble: opening it turns the message into "Opened" on the
// server, which replaces the bubble, so the viewer must outlive it (ViewOnceViewerHost shows it).
const useViewOnce = create(() => ({ viewing: null }));
export function ViewOnceViewerHost() {
  const viewing = useViewOnce((state) => state.viewing);
  if (!viewing) return null;
  const close = () => { URL.revokeObjectURL(viewing.url); useViewOnce.setState({ viewing: null }); };
  return createPortal(
    <div className="view-once-viewer" role="dialog" aria-label="View once" onContextMenu={(event) => event.preventDefault()}>
      <button type="button" className="icon-button view-once-close" onClick={close} aria-label="Close"><X size={22} /></button>
      {viewing.video
        ? <video src={viewing.url} autoPlay playsInline controls controlsList="nodownload" disablePictureInPicture />
        : <img src={viewing.url} alt="View once" draggable="false" />}
      <p><Eye size={14} aria-hidden="true" /> View once: it can’t be opened again.</p>
    </div>,
    document.body,
  );
}
import { Camera, Circle, Eye, ImagePlus, Square, Trash2, X } from 'lucide-react';
import { apiFetch } from '../api.js';
import { parseMediaRef } from '../media.js';
import { decryptMedia, parseEncryptedMediaRef } from '../mediaCrypto.js';
import { useMediaBlob } from './mediaHooks.js';
import { secureGet, secureSet } from '../secureStorage.js';

import { CUSTOM_STICKER_PREFIX, VIDEO_NOTE_PREFIX, VIDEO_NOTE_SECONDS, VIEW_ONCE_PREFIX, refOf, VIDEO_EXTENSIONS } from '../mediaExtras.js';
export const STICKER_PX = 512;
const MY_STICKERS_LIMIT = 30;

// --- View once -----------------------------------------------------------------------------------------

export function ViewOnceMediaBubble({ message, mine, sessionToken, children }) {
  const ref = parseMediaRef(refOf(message.content, VIEW_ONCE_PREFIX));
  const video = VIDEO_EXTENSIONS.test(ref?.filename ?? '');
  const [state, setState] = useState('idle');
  const [error, setError] = useState('');

  async function open() {
    if (mine || state === 'loading') return;
    setState('loading');
    setError('');
    try {
      const response = await apiFetch(`/api/v1/messages/${encodeURIComponent(message.id)}/view-once`, { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}` } });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setError(body?.error ?? 'This message could not be opened.');
        setState(response.status === 410 ? 'done' : 'idle');
        return;
      }
      const received = await response.blob();
      const sealed = parseEncryptedMediaRef(refOf(message.content, VIEW_ONCE_PREFIX));
      const plain = sealed ? await decryptMedia(received, sealed.descriptor) : received;
      useViewOnce.setState({ viewing: { url: URL.createObjectURL(plain), video } });
      setState('done');
    } catch (failure) {
      console.error('View once message could not be opened:', failure);
      setError('This message could not be opened.');
      setState('idle');
    }
  }

  return (
    <>
      <button type="button" className="view-once-media" onClick={open} disabled={mine || state === 'done'} aria-label={mine ? 'View once message' : `Open view once ${video ? 'video' : 'photo'}`}>
        <span className="view-once-mark" aria-hidden="true">1</span>
        <span className="view-once-copy">
          <strong>{video ? 'Video' : 'Photo'}</strong>
          <small>{mine ? 'View once · sent' : state === 'loading' ? 'Opening…' : state === 'done' ? 'Opened' : 'View once · tap to open'}</small>
          {error && <small className="view-once-error">{error}</small>}
        </span>
        {children}
      </button>
    </>
  );
}

export function MediaOpenedBubble({ children }) {
  return (
    <div className="view-once-media is-opened">
      <span className="view-once-mark is-opened" aria-hidden="true">1</span>
      <span className="view-once-copy"><strong>Opened</strong></span>
      {children}
    </div>
  );
}

// --- Video notes -----------------------------------------------------------------------------------------

export function VideoNoteBubble({ content, sessionToken, children }) {
  const ref = parseMediaRef(refOf(content, VIDEO_NOTE_PREFIX));
  const media = useMediaBlob(ref?.id, sessionToken);
  const videoRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  useEffect(() => { media.load().catch(() => {}); }, [media.load]);
  const toggle = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) { video.muted = false; video.play().then(() => setPlaying(true)).catch(() => {}); }
    else { video.pause(); setPlaying(false); }
  };
  return (
    <div className="video-note">
      <button type="button" className="video-note-circle" onClick={toggle} aria-label={playing ? 'Pause video note' : 'Play video note'}>
        {media.url ? <video ref={videoRef} src={media.url} playsInline muted loop={!playing} autoPlay onEnded={() => setPlaying(false)} /> : <span className="video-note-loading" />}
      </button>
      {children}
    </div>
  );
}

/** Records a round video note with the front camera; onSend(blob, seconds). */
export function VideoNoteRecorder({ onSend, onClose }) {
  const previewRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const startedRef = useRef(0);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 480 } }, audio: true })
      .then((stream) => {
        if (cancelled) { stream.getTracks().forEach((track) => track.stop()); return; }
        streamRef.current = stream;
        if (previewRef.current) previewRef.current.srcObject = stream;
      })
      .catch(() => setError('Allow the camera and microphone to record a video note.'));
    return () => {
      cancelled = true;
      recorderRef.current?.state === 'recording' && recorderRef.current.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    if (!recording) return undefined;
    const timer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedRef.current) / 1000);
      setSeconds(elapsed);
      if (elapsed >= VIDEO_NOTE_SECONDS) stop(true);
    }, 250);
    return () => clearInterval(timer);
  });

  function start() {
    if (!streamRef.current) return;
    const type = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find((candidate) => window.MediaRecorder?.isTypeSupported?.(candidate)) ?? '';
    const recorder = new MediaRecorder(streamRef.current, type ? { mimeType: type, videoBitsPerSecond: 600_000 } : undefined);
    chunksRef.current = [];
    recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
    recorderRef.current = recorder;
    startedRef.current = Date.now();
    setSeconds(0);
    recorder.start(500);
    setRecording(true);
  }

  function stop(send) {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== 'recording') return;
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'video/webm' });
      const length = Math.max(1, Math.round((Date.now() - startedRef.current) / 1000));
      if (send && blob.size) onSend(blob, Math.min(length, VIDEO_NOTE_SECONDS));
      onClose();
    };
    recorder.stop();
    setRecording(false);
  }

  return (
    <div className="video-note-recorder" role="dialog" aria-label="Record a video note">
      <video ref={previewRef} className="video-note-preview" autoPlay playsInline muted />
      {error ? <p className="attachment-error">{error}</p> : <p className="video-note-time">{recording ? `${seconds}s / ${VIDEO_NOTE_SECONDS}s` : 'Up to 60 seconds'}</p>}
      <div className="video-note-actions">
        <button type="button" className="icon-button" onClick={() => (recording ? stop(false) : onClose())} aria-label="Cancel"><Trash2 size={20} /></button>
        {recording
          ? <button type="button" className="video-note-record is-recording" onClick={() => stop(true)} aria-label="Stop and send"><Square size={22} /></button>
          : <button type="button" className="video-note-record" onClick={start} disabled={Boolean(error)} aria-label="Start recording"><Circle size={26} /></button>}
      </div>
    </div>
  );
}

// --- Stickers made from photos ------------------------------------------------------------------------------

/** A square sticker (STICKER_PX, transparent corners when round) from an image file: resolves a WebP/PNG blob. */
export async function makeSticker(file, { shape = 'round', caption = '' } = {}) {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = STICKER_PX;
  canvas.height = STICKER_PX;
  const context = canvas.getContext('2d');
  context.save();
  if (shape === 'round') {
    context.beginPath();
    context.arc(STICKER_PX / 2, STICKER_PX / 2, STICKER_PX / 2 - 8, 0, Math.PI * 2);
    context.clip();
  } else {
    const radius = 48;
    context.beginPath();
    context.roundRect?.(8, 8, STICKER_PX - 16, STICKER_PX - 16, radius);
    context.clip();
  }
  context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, STICKER_PX, STICKER_PX);
  context.restore();
  bitmap.close?.();
  const text = caption.trim().slice(0, 24);
  if (text) {
    context.font = 'bold 54px system-ui, sans-serif';
    context.textAlign = 'center';
    context.lineWidth = 10;
    context.strokeStyle = '#000';
    context.fillStyle = '#fff';
    context.strokeText(text, STICKER_PX / 2, STICKER_PX - 40);
    context.fillText(text, STICKER_PX / 2, STICKER_PX - 40);
  }
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.86));
  return blob && blob.type === 'image/webp' ? blob : new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

const myStickersKey = (userId) => `hm:my-stickers:${userId}`;

/** "My stickers": the stickers this account made on this device (data URLs, newest first). */
export async function loadMyStickers(userId) {
  const list = await secureGet(myStickersKey(userId)).catch(() => null);
  return Array.isArray(list) ? list : [];
}

export async function saveMySticker(userId, blob) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  const next = [dataUrl, ...(await loadMyStickers(userId)).filter((item) => item !== dataUrl)].slice(0, MY_STICKERS_LIMIT);
  await secureSet(myStickersKey(userId), next);
  return next;
}

export async function stickerBlobFrom(dataUrl) {
  return (await fetch(dataUrl)).blob();
}

/** Make a sticker from a photo (round or rounded square, optional caption), then send it or keep it. */
export function StickerMaker({ userId, onSend, onClose }) {
  const [file, setFile] = useState(null);
  const [shape, setShape] = useState('round');
  const [caption, setCaption] = useState('');
  const [preview, setPreview] = useState('');
  const [mine, setMine] = useState([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => { loadMyStickers(userId).then(setMine); }, [userId]);
  useEffect(() => {
    if (!file) return undefined;
    let url = '';
    let cancelled = false;
    makeSticker(file, { shape, caption }).then((blob) => {
      if (cancelled || !blob) return;
      url = URL.createObjectURL(blob);
      setPreview(url);
    }).catch(() => setPreview(''));
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [file, shape, caption]);

  async function send() {
    if (!file || busy) return;
    setBusy(true);
    try {
      const blob = await makeSticker(file, { shape, caption });
      setMine(await saveMySticker(userId, blob));
      await onSend(blob);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sticker-maker" role="dialog" aria-label="Create a sticker">
      <header><strong>Create sticker</strong><button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={20} /></button></header>
      <input ref={inputRef} type="file" accept="image/*" hidden onChange={(event) => { const [picked] = event.target.files ?? []; event.target.value = ''; if (picked) setFile(picked); }} />
      {preview ? <img className="sticker-maker-preview" src={preview} alt="Sticker preview" /> : (
        <button type="button" className="sticker-maker-pick" onClick={() => inputRef.current?.click()}><ImagePlus size={28} /><span>Choose a photo</span></button>
      )}
      {file && (
        <>
          <div className="sticker-maker-shapes" role="radiogroup" aria-label="Shape">
            <button type="button" role="radio" aria-checked={shape === 'round'} className={shape === 'round' ? 'is-on' : ''} onClick={() => setShape('round')}>Round</button>
            <button type="button" role="radio" aria-checked={shape === 'square'} className={shape === 'square' ? 'is-on' : ''} onClick={() => setShape('square')}>Square</button>
            <button type="button" onClick={() => inputRef.current?.click()}><Camera size={14} /> Another photo</button>
          </div>
          <input className="sticker-maker-caption" value={caption} maxLength={24} placeholder="Add text (optional)" onChange={(event) => setCaption(event.target.value)} />
          <button type="button" className="sticker-maker-send" onClick={send} disabled={busy}>{busy ? 'Sending…' : 'Send sticker'}</button>
        </>
      )}
      {mine.length > 0 && (
        <section className="sticker-maker-mine" aria-label="My stickers">
          <h4>My stickers</h4>
          <div>
            {mine.map((dataUrl) => (
              <button key={dataUrl.slice(-40)} type="button" onClick={async () => { await onSend(await stickerBlobFrom(dataUrl)); onClose(); }} aria-label="Send this sticker">
                <img src={dataUrl} alt="" />
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

export function CustomStickerBubble({ content, sessionToken, children }) {
  const ref = parseMediaRef(refOf(content, CUSTOM_STICKER_PREFIX));
  const media = useMediaBlob(ref?.id, sessionToken);
  useEffect(() => { media.load().catch(() => {}); }, [media.load]);
  return (
    <div className="custom-sticker">
      {media.url ? <img src={media.url} alt="Sticker" draggable="false" /> : <span className="custom-sticker-loading" />}
      {children}
    </div>
  );
}
