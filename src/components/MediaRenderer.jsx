import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Download, ExternalLink, FileText, Maximize2, Music, Pause, Play, Video } from 'lucide-react';
import { playExclusiveAudio, stopExclusiveAudio } from '../audioManager.js';
import {
  canOpenInBrowser,
  canPreviewSize,
  fileTone,
  fileTypeLabel,
  formatFileSize,
  mediaKind,
  isEncryptedMedia,
  loadMediaBlob,
  parseMediaRef,
  requestMediaLink,
} from '../media.js';
import { useMediaBlob, useMediaInfo } from './mediaHooks.js';
import DownloadProgress from './DownloadProgress.jsx';
import { downloadWithProgress, useDownloadProgress } from '../downloads.js';
import { nativeShell } from '../native.js';
import { openMediaOnPhone } from '../mediaSave.js';

// "1 page • 0.94 MB • PDF", like WhatsApp under a document.
export function fileMetaLine({ pages, size, label }) {
  return [pages ? `${pages} page${pages === 1 ? '' : 's'}` : '', size, label].filter(Boolean).join(' • ');
}

// Shared by every attachment: downloads run through the progress manager (streamed to disk where the
// browser allows it), and the overlay shows percentage and time left while they run.
function useDownload(id, filename, sessionToken) {
  const progress = useDownloadProgress(id);
  const download = useCallback(() => downloadWithProgress(id, filename, sessionToken), [id, filename, sessionToken]);
  return { download, status: progress?.status === 'running' ? 'loading' : progress?.status === 'error' ? 'error' : 'idle', error: progress?.error ?? '' };
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function ProgressRing({ progress }) {
  const radius = 15;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg className="wa-file-progress" viewBox="0 0 36 36" aria-hidden="true">
      <circle cx="18" cy="18" r={radius} className="wa-file-progress-track" />
      <circle
        cx="18"
        cy="18"
        r={radius}
        className="wa-file-progress-value"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - Math.max(progress, 0.04))}
      />
    </svg>
  );
}

function DownloadButton({ status, progress, onClick, filename }) {
  const loading = status === 'loading';
  return (
    <button
      type="button"
      className={`wa-file-download ${loading ? 'is-loading' : ''}`}
      onClick={(event) => {
        event.stopPropagation();
        if (!loading) onClick();
      }}
      aria-label={loading ? `Downloading ${filename}, ${Math.round(progress * 100)}%` : `Download ${filename}`}
      title={loading ? `${Math.round(progress * 100)}%` : 'Download'}
    >
      {loading ? <ProgressRing progress={progress} /> : <Download size={18} />}
    </button>
  );
}

export function FileCard({ id, filename, sessionToken, info, infoError }) {
  const saver = useDownload(id, filename, sessionToken);
  const contentType = info?.contentType ?? '';
  // In the Android app every document opens with the phone's "Open with" chooser (Drive, a PDF reader…).
  const onPhone = nativeShell();
  const openable = onPhone || canOpenInBrowser(contentType);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState('');
  const tone = fileTone(filename);
  const size = formatFileSize(info?.size ?? NaN);
  const label = fileTypeLabel(filename);

  const download = saver.download;

  // Streams the file inline in a new tab; the tab is opened synchronously so popup blockers allow it.
  const open = () => {
    if (onPhone) {
      if (opening) return;
      setOpening(true);
      setOpenError('');
      openMediaOnPhone({ id, filename, contentType, sessionToken })
        .catch((error) => setOpenError(error?.message || 'Could not open the file.'))
        .finally(() => setOpening(false));
      return;
    }
    const tab = window.open('', '_blank');
    if (tab) tab.opener = null;
    // End-to-end encrypted: the server link would serve ciphertext, so the tab gets the decrypted copy instead.
    const target = isEncryptedMedia(id)
      ? loadMediaBlob(id, sessionToken).then((blob) => ({ url: URL.createObjectURL(blob) }))
      : requestMediaLink(id, sessionToken, { inline: true });
    target
      .then((link) => {
        if (tab) tab.location.href = link.url;
        else download();
      })
      .catch(() => tab?.close());
  };

  return (
    <div className="wa-file">
      <div
        className="wa-file-card"
        role="button"
        tabIndex={0}
        onClick={(event) => {
          event.stopPropagation();
          if (openable) open();
          else download();
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          if (openable) open();
          else download();
        }}
        title={openable ? `Open ${filename}` : `Download ${filename}`}
      >
        <span className={`wa-file-icon tone-${tone}`} aria-hidden="true">
          <FileText size={22} />
          <span className="wa-file-icon-label">{label}</span>
        </span>
        <span className="wa-file-body">
          <span className="wa-file-name" title={filename}>{filename}</span>
          <span className="wa-file-meta">
            {infoError ? infoError : opening ? 'Opening…' : fileMetaLine({ pages: info?.pages, size, label })}
          </span>
        </span>
        {!infoError && <DownloadButton status={saver.status} progress={0} onClick={download} filename={filename} />}
      </div>
      <DownloadProgress id={id} />
      {openable && !onPhone && !infoError && (
        <div className="wa-file-actions">
          <button type="button" onClick={(event) => { event.stopPropagation(); open(); }}><ExternalLink size={14} /> Open</button>
          <button type="button" onClick={(event) => { event.stopPropagation(); download(); }}><Download size={14} /> Save as…</button>
        </div>
      )}
      {saver.status === 'error' && <span className="wa-file-error" role="alert"><AlertCircle size={12} /> {saver.error}</span>}
      {openError && <span className="wa-file-error" role="alert"><AlertCircle size={12} /> {openError}</span>}
    </div>
  );
}

function ImageAttachment({ id, filename, sessionToken, info, onOpen, meta = null }) {
  const media = useMediaBlob(id, sessionToken);
  const [broken, setBroken] = useState(false);
  const { load } = media;
  const previewable = canPreviewSize(info?.size ?? 0);

  // Photos download automatically, as in WhatsApp; other formats wait for a tap.
  useEffect(() => {
    if (previewable) load().catch(() => {});
  }, [load, previewable]);

  if (!previewable || broken || media.status === 'error') return <><FileCard id={id} filename={filename} sessionToken={sessionToken} info={info} />{meta}</>;

  // The time and ticks sit on the photo's bottom-right corner, over a soft shade, as on WhatsApp.
  return (
    <div className={`wa-visual ${meta ? 'has-meta' : ''}`}>
    <button
      type="button"
      className="wa-image"
      onClick={(event) => {
        event.stopPropagation();
        if (media.url) onOpen?.();
      }}
      aria-label={`View ${filename}`}
    >
      {media.url
        ? <img src={media.url} alt={filename} onError={() => setBroken(true)} />
        : <span className="wa-image-loading" aria-busy="true"><ProgressRing progress={media.progress} /></span>}
    </button>
    {meta && <span className="wa-media-overlay">{meta}</span>}
    </div>
  );
}

// Playback source: small files come from the in-memory blob (cached and reusable), large ones stream
// from a short-lived link so seeking uses range requests instead of a full download.
function usePlaybackSource(id, sessionToken, info, media) {
  const [streamUrl, setStreamUrl] = useState('');
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  // An encrypted file cannot be streamed (ranges of ciphertext are not playable): it plays from the decrypted blob.
  const large = !canPreviewSize(info?.size ?? 0) && !isEncryptedMedia(id);
  const prepare = useCallback(() => {
    if (!large) return media.load();
    if (streamUrl) return Promise.resolve(streamUrl);
    setStatus('loading');
    return requestMediaLink(id, sessionToken, { inline: true })
      .then((link) => { setStreamUrl(link.url); setStatus('ready'); return link.url; })
      .catch((caught) => { setStatus('error'); setError(caught?.message || 'Could not play this file.'); throw caught; });
  }, [large, media, streamUrl, id, sessionToken]);
  return large
    ? { url: streamUrl, status, progress: 0, error, prepare }
    : { url: media.url, status: media.status, progress: media.progress, error: media.error, prepare };
}

// One card: size bottom-left, time and ticks bottom-right, download (or full screen) top-right. While it plays the
// player's own controls take the bottom, so the time moves under it.
function VideoAttachment({ id, filename, sessionToken, info, onOpen, meta = null }) {
  const media = useMediaBlob(id, sessionToken);
  const source = usePlaybackSource(id, sessionToken, info, media);
  const saver = useDownload(id, filename, sessionToken);
  const [playing, setPlaying] = useState(false);
  const size = formatFileSize(info?.size ?? NaN);

  return (
    <div className="wa-video">
      <div className={`wa-visual ${meta && !(playing && source.url) ? 'has-meta' : ''}`}>
      {playing && source.url ? (
        <video className="wa-video-player" src={source.url} controls autoPlay playsInline onClick={(event) => event.stopPropagation()} />
      ) : (
        <button
          type="button"
          className="wa-video-poster"
          onClick={(event) => {
            event.stopPropagation();
            source.prepare().then(() => setPlaying(true)).catch(() => {});
          }}
          aria-label={`Play ${filename}`}
        >
          <span className="wa-video-play">
            {source.status === 'loading' ? <ProgressRing progress={source.progress} /> : <Play size={26} fill="currentColor" />}
          </span>
          <span className="wa-video-caption"><Video size={14} /> {size || fileTypeLabel(filename)}</span>
        </button>
      )}
      <span className="wa-media-tools">
        {playing && media.url && onOpen && (
          <button type="button" className="wa-media-link" onClick={(event) => { event.stopPropagation(); onOpen(); }} aria-label={`Open ${filename} full screen`}><Maximize2 size={14} /></button>
        )}
        <DownloadButton status={saver.status} progress={0} onClick={saver.download} filename={filename} />
      </span>
      {meta && !(playing && source.url) && <span className="wa-media-overlay">{meta}</span>}
      </div>
      {meta && playing && source.url && meta}
      <DownloadProgress id={id} />
      {(source.status === 'error' || saver.status === 'error') && <span className="wa-file-error" role="alert"><AlertCircle size={12} /> {source.error || saver.error}</span>}
    </div>
  );
}

function AudioAttachment({ id, filename, sessionToken, info }) {
  const media = useMediaBlob(id, sessionToken);
  const source = usePlaybackSource(id, sessionToken, info, media);
  const saver = useDownload(id, filename, sessionToken);
  const audioRef = useRef(null);
  const playWhenReadyRef = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const exclusiveId = `media:${id}`;
  const size = formatFileSize(info?.size ?? NaN);

  useEffect(() => () => stopExclusiveAudio(exclusiveId), [exclusiveId]);

  const startPlayback = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    playExclusiveAudio(exclusiveId, () => {
      audio.pause();
      setPlaying(false);
    });
    audio.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
  }, [exclusiveId]);

  useEffect(() => {
    if (source.url && playWhenReadyRef.current) {
      playWhenReadyRef.current = false;
      startPlayback();
    }
  }, [source.url, startPlayback]);

  const toggle = () => {
    const audio = audioRef.current;
    if (playing && audio) {
      audio.pause();
      setPlaying(false);
      stopExclusiveAudio(exclusiveId);
      return;
    }
    if (source.url) {
      startPlayback();
      return;
    }
    playWhenReadyRef.current = true;
    source.prepare().catch(() => {
      playWhenReadyRef.current = false;
    });
  };

  const seek = (event) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    const rect = event.currentTarget.getBoundingClientRect();
    audio.currentTime = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1) * duration;
  };

  return (
    <div className="wa-audio" onClick={(event) => event.stopPropagation()}>
      <audio
        ref={audioRef}
        src={source.url || undefined}
        preload="metadata"
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onEnded={() => {
          setPlaying(false);
          setCurrentTime(0);
          stopExclusiveAudio(exclusiveId);
        }}
      />
      <span className="wa-audio-icon" aria-hidden="true"><Music size={20} /></span>
      <button type="button" className="wa-audio-toggle" onClick={toggle} aria-label={playing ? `Pause ${filename}` : `Play ${filename}`}>
        {source.status === 'loading' ? <ProgressRing progress={source.progress} /> : playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
      </button>
      <span className="wa-audio-body">
        <span className="wa-file-name" title={filename}>{filename}</span>
        <span className="wa-audio-track" onClick={seek} role="presentation">
          <span className="wa-audio-fill" style={{ width: `${duration ? (currentTime / duration) * 100 : 0}%` }} />
        </span>
        <span className="wa-file-meta">
          {duration ? `${formatDuration(currentTime)} / ${formatDuration(duration)}` : [fileTypeLabel(filename), size].filter(Boolean).join(' • ')}
        </span>
      </span>
      <DownloadButton status={saver.status} progress={0} onClick={saver.download} filename={filename} />
      <DownloadProgress id={id} compact />
      {(source.status === 'error' || saver.status === 'error') && <span className="wa-file-error" role="alert"><AlertCircle size={12} /> {source.error || saver.error}</span>}
    </div>
  );
}

// onOpen opens the chat's full-screen viewer for this message's photo or video.
// `meta` (optional): the message's time and ticks. Photos and videos show it on the media's bottom-right corner, as
// WhatsApp does; files, audio files and the loading and error states show it below.
export default function MediaRenderer({ mediaRef, sessionToken, onOpen, meta = null }) {
  const ref = parseMediaRef(mediaRef);
  const id = ref?.id ?? '';
  const filename = ref?.filename ?? 'attachment';
  const { info, error } = useMediaInfo(id, sessionToken);

  if (!ref || !id || !sessionToken) {
    return <><span className="wa-file-error" role="alert"><AlertCircle size={12} /> Attachment unavailable</span>{meta}</>;
  }
  if (!info && !error) {
    return (
      <div className="wa-file wa-file-pending" aria-busy="true">
        <div className="wa-file-card">
          <span className={`wa-file-icon tone-${fileTone(filename)}`} aria-hidden="true"><FileText size={22} /></span>
          <span className="wa-file-body">
            <span className="wa-file-name">{filename}</span>
            <span className="wa-file-meta">Loading…</span>
          </span>
        </div>
        {meta}
      </div>
    );
  }

  const props = { id, filename, sessionToken, info };
  const kind = info ? mediaKind(info.contentType) : 'file';
  if (kind === 'image') return <ImageAttachment {...props} onOpen={onOpen} meta={meta} />;
  if (kind === 'video') return <VideoAttachment {...props} onOpen={onOpen} meta={meta} />;
  if (kind === 'audio') return <><AudioAttachment {...props} />{meta}</>;
  return <><FileCard {...props} infoError={error} />{meta}</>;
}
