import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Forward,
  MoreVertical,
  Music,
  Play,
  RotateCw,
  Send,
  SmilePlus,
  Star,
  Undo2,
  X,
} from 'lucide-react';
import { fileTone, fileTypeLabel, formatFileSize, mediaKind, parseMediaRef } from '../media.js';
import { downloadWithProgress } from '../downloads.js';
import DownloadProgress from './DownloadProgress.jsx';
import { EXTENDED_REACTIONS, QUICK_REACTIONS, VIEWER_REACTIONS } from '../reactions.js';
import { formatViewerTimestamp } from '../time.js';
import { FileCard } from './MediaRenderer.jsx';
import { useMediaBlob, useMediaInfo } from './mediaHooks.js';

const SWIPE_THRESHOLD_PX = 60;
const TOAST_MS = 1800;
// Large photos are scaled down for editing so the canvas stays within mobile memory limits.
const MAX_EDIT_EDGE_PX = 4096;
const PEN_COLORS = ['#ffffff', '#000000', '#ff3b30', '#ffcc00', '#3474c7', '#0a84ff', '#af52de'];
const EDIT_OUTPUT_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

function isTypingTarget(target) {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}

function Spinner() {
  return <span className="wa-viewer-spinner" role="progressbar" aria-label="Loading" />;
}

function editedFilename(filename, type) {
  const extension = EDIT_OUTPUT_TYPES[type] ?? 'png';
  const dot = filename.lastIndexOf('.');
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  return `${base || 'photo'}-edited.${extension}`;
}

// Strokes are stored in unrotated image coordinates, so rotating keeps drawings attached to the photo.
function ImageEditor({ blob, filename, onCancel, onSend }) {
  const canvasRef = useRef(null);
  const activeStrokeRef = useRef(null);
  const [image, setImage] = useState(null);
  const [failed, setFailed] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [strokes, setStrokes] = useState([]);
  const [color, setColor] = useState(PEN_COLORS[2]);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let bitmap = null;
    let cancelled = false;
    createImageBitmap(blob)
      .then((loaded) => {
        if (cancelled) loaded.close();
        else {
          bitmap = loaded;
          setImage(loaded);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      bitmap?.close();
    };
  }, [blob]);

  const geometry = image ? (() => {
    const scale = Math.min(1, MAX_EDIT_EDGE_PX / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const sideways = rotation % 180 !== 0;
    return { width, height, canvasWidth: sideways ? height : width, canvasHeight: sideways ? width : height };
  })() : null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image || !geometry) return;
    canvas.width = geometry.canvasWidth;
    canvas.height = geometry.canvasHeight;
    const context = canvas.getContext('2d');
    context.save();
    context.translate(geometry.canvasWidth / 2, geometry.canvasHeight / 2);
    context.rotate((rotation * Math.PI) / 180);
    context.translate(-geometry.width / 2, -geometry.height / 2);
    context.drawImage(image, 0, 0, geometry.width, geometry.height);
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.lineWidth = Math.max(3, Math.round(Math.max(geometry.width, geometry.height) / 160));
    for (const stroke of strokes) {
      context.strokeStyle = stroke.color;
      context.beginPath();
      stroke.points.forEach(([x, y], index) => (index ? context.lineTo(x, y) : context.moveTo(x, y)));
      if (stroke.points.length === 1) context.lineTo(stroke.points[0][0] + 0.1, stroke.points[0][1]);
      context.stroke();
    }
    context.restore();
  });

  function toImagePoint(event) {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * geometry.canvasWidth - geometry.canvasWidth / 2;
    const y = ((event.clientY - rect.top) / rect.height) * geometry.canvasHeight - geometry.canvasHeight / 2;
    const angle = (-rotation * Math.PI) / 180;
    return [
      x * Math.cos(angle) - y * Math.sin(angle) + geometry.width / 2,
      x * Math.sin(angle) + y * Math.cos(angle) + geometry.height / 2,
    ];
  }

  function handlePointerDown(event) {
    if (!geometry) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const stroke = { color, points: [toImagePoint(event)] };
    activeStrokeRef.current = stroke;
    setStrokes((current) => [...current, stroke]);
  }

  function handlePointerMove(event) {
    const stroke = activeStrokeRef.current;
    if (!stroke) return;
    stroke.points.push(toImagePoint(event));
    setStrokes((current) => [...current]);
  }

  function handlePointerUp() {
    activeStrokeRef.current = null;
  }

  function send() {
    const canvas = canvasRef.current;
    if (!canvas || sending) return;
    setSending(true);
    const type = EDIT_OUTPUT_TYPES[blob.type] ? blob.type : 'image/png';
    canvas.toBlob((output) => {
      if (!output) {
        setSending(false);
        setFailed(true);
        return;
      }
      // Browsers without an encoder for the requested type fall back to PNG; name the file after what was produced.
      onSend(output, editedFilename(filename, output.type));
    }, type, 0.92);
  }

  return (
    <div className="wa-viewer-editor" role="dialog" aria-modal="true" aria-label="Edit photo">
      <header className="wa-viewer-editor-bar">
        <button type="button" onClick={onCancel} aria-label="Cancel editing"><X size={22} /></button>
        <span className="wa-viewer-editor-tools">
          <button type="button" onClick={() => setStrokes((current) => current.slice(0, -1))} disabled={!strokes.length} aria-label="Undo"><Undo2 size={20} /></button>
          <button type="button" onClick={() => setRotation((current) => (current + 90) % 360)} aria-label="Rotate"><RotateCw size={20} /></button>
        </span>
      </header>
      <div className="wa-viewer-editor-stage">
        {failed && <p className="wa-viewer-error"><AlertCircle size={16} /> This photo can’t be edited.</p>}
        {!failed && !image && <Spinner />}
        {!failed && image && (
          <canvas
            ref={canvasRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            aria-label="Draw on photo"
          />
        )}
      </div>
      <footer className="wa-viewer-editor-foot">
        <span className="wa-viewer-pen-colors" role="radiogroup" aria-label="Pen colour">
          {PEN_COLORS.map((swatch) => (
            <button
              type="button"
              key={swatch}
              role="radio"
              aria-checked={color === swatch}
              aria-label={`Pen ${swatch}`}
              className={color === swatch ? 'active' : ''}
              style={{ background: swatch }}
              onClick={() => setColor(swatch)}
            />
          ))}
        </span>
        <button type="button" className="wa-viewer-send" onClick={send} disabled={!image || failed || sending} aria-label="Send edited photo"><Send size={20} /></button>
      </footer>
    </div>
  );
}

export function GalleryTile({ message, sessionToken, active, onSelect }) {
  const ref = parseMediaRef(message.content);
  const { info } = useMediaInfo(ref?.id, sessionToken);
  const media = useMediaBlob(ref?.id, sessionToken);
  const kind = info ? mediaKind(info.contentType) : null;
  const { load } = media;

  useEffect(() => {
    if (kind === 'image') load().catch(() => {});
  }, [kind, load]);

  const filename = ref?.filename ?? 'attachment';
  return (
    <button type="button" className={`wa-viewer-tile ${active ? 'active' : ''}`} onClick={onSelect} aria-label={filename} aria-current={active || undefined}>
      {kind === 'image' && media.url && <img src={media.url} alt="" />}
      {kind === 'image' && !media.url && <Spinner />}
      {kind === 'video' && <span className="wa-viewer-tile-icon"><Play size={22} fill="currentColor" /></span>}
      {kind === 'audio' && <span className="wa-viewer-tile-icon"><Music size={22} /></span>}
      {(kind === 'file' || !kind) && <span className={`wa-viewer-tile-badge tone-${fileTone(filename)}`}>{fileTypeLabel(filename)}</span>}
      {kind && kind !== 'image' && <span className="wa-viewer-tile-name">{kind === 'video' ? formatFileSize(info?.size ?? NaN) : filename}</span>}
    </button>
  );
}

function MediaGallery({ items, sessionToken, currentId, onSelect, onClose }) {
  const newestFirst = [...items].reverse();
  return (
    <div className="wa-viewer-gallery" role="dialog" aria-modal="true" aria-label="All media">
      <header className="wa-viewer-top">
        <button type="button" onClick={onClose} aria-label="Back to photo"><ArrowLeft size={22} /></button>
        <span className="wa-viewer-title"><strong>All media</strong><small>{items.length} item{items.length === 1 ? '' : 's'}</small></span>
      </header>
      <div className="wa-viewer-grid">
        {newestFirst.map((message) => (
          <GalleryTile
            key={message.id}
            message={message}
            sessionToken={sessionToken}
            active={message.id === currentId}
            onSelect={() => onSelect(message.id)}
          />
        ))}
      </div>
    </div>
  );
}

function ViewerFrame({
  message,
  items,
  sessionToken,
  senderName,
  starred,
  myReaction,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  onNavigate,
  onClose,
  onReact,
  onReply,
  onStar,
  onForward,
  onDelete,
  onShowInChat,
  onSendEdited,
}) {
  const ref = parseMediaRef(message.content);
  const filename = ref?.filename ?? 'attachment';
  const { info, error: infoError } = useMediaInfo(ref?.id, sessionToken);
  const media = useMediaBlob(ref?.id, sessionToken);
  const { load } = media;
  const kind = info ? mediaKind(info.contentType) : null;
  const [menuOpen, setMenuOpen] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [trayOpen, setTrayOpen] = useState(false);
  const [chromeHidden, setChromeHidden] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [reply, setReply] = useState('');
  const [toast, setToast] = useState('');
  const swipeRef = useRef(null);
  const toastTimerRef = useRef(null);

  useEffect(() => {
    if (kind === 'image' || kind === 'video' || kind === 'audio') load().catch(() => {});
  }, [kind, load]);

  useEffect(() => () => clearTimeout(toastTimerRef.current), []);

  const showToast = useCallback((text) => {
    clearTimeout(toastTimerRef.current);
    setToast(text);
    toastTimerRef.current = setTimeout(() => setToast(''), TOAST_MS);
  }, []);

  useEffect(() => {
    const onKey = (event) => {
      if (editing) {
        if (event.key === 'Escape') setEditing(false);
        return;
      }
      if (event.key === 'Escape') {
        if (menuOpen) setMenuOpen(false);
        else if (trayOpen) setTrayOpen(false);
        else if (galleryOpen) setGalleryOpen(false);
        else onClose();
        return;
      }
      if (isTypingTarget(event.target) || menuOpen || galleryOpen) return;
      if (event.key === 'ArrowLeft' && hasPrev) onPrev();
      if (event.key === 'ArrowRight' && hasNext) onNext();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing, menuOpen, trayOpen, galleryOpen, hasPrev, hasNext, onPrev, onNext, onClose]);

  const save = () => downloadWithProgress(ref?.id, filename, sessionToken);

  // The system share sheet when the browser can share files; otherwise WhatsApp's in-app forward.
  async function share() {
    try {
      const blob = await load();
      const file = new File([blob], filename, { type: blob.type || info?.contentType || 'application/octet-stream' });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file] });
        return;
      }
    } catch (caught) {
      if (caught?.name === 'AbortError') return;
    }
    onForward();
  }

  const loaded = Boolean(media.blob);
  const isImage = kind === 'image';
  const menuItems = [
    isImage && loaded && { key: 'edit', label: 'Edit', run: () => setEditing(true) },
    { key: 'all-media', label: 'All media', run: () => setGalleryOpen(true) },
    { key: 'show-in-chat', label: 'Show in chat', run: onShowInChat },
    !infoError && { key: 'share', label: 'Share', run: share },
    !infoError && { key: 'save', label: 'Save', run: save },
    isImage && { key: 'rotate', label: 'Rotate', run: () => setRotation((current) => (current + 90) % 360) },
    { key: 'delete', label: 'Delete', run: onDelete },
  ].filter(Boolean);

  function submitReply(event) {
    event.preventDefault();
    const text = reply.trim();
    if (!text) return;
    if (onReply(text)) {
      setReply('');
      showToast('Reply sent');
    }
  }

  function react(emoji) {
    onReact(emoji);
    setTrayOpen(false);
  }

  const quickReactions = myReaction && !VIEWER_REACTIONS.includes(myReaction) ? [myReaction, ...VIEWER_REACTIONS] : VIEWER_REACTIONS;

  let stage;
  if (infoError) stage = <p className="wa-viewer-error"><AlertCircle size={16} /> {infoError}</p>;
  else if (!kind) stage = <Spinner />;
  else if (kind === 'file') stage = <div className="wa-viewer-file"><FileCard id={ref.id} filename={filename} sessionToken={sessionToken} info={info} /></div>;
  else if (media.status === 'error') stage = <p className="wa-viewer-error"><AlertCircle size={16} /> {media.error}</p>;
  else if (!media.url) stage = <Spinner />;
  else if (kind === 'image') {
    stage = (
      <img
        src={media.url}
        alt={filename}
        className={rotation % 180 ? 'is-sideways' : ''}
        style={{ transform: `rotate(${rotation}deg)` }}
        onClick={(event) => {
          event.stopPropagation();
          setChromeHidden((current) => !current);
        }}
        draggable={false}
      />
    );
  } else if (kind === 'video') stage = <video src={media.url} controls autoPlay playsInline />;
  else stage = <div className="wa-viewer-audio"><Music size={48} /><strong>{filename}</strong><audio src={media.url} controls autoPlay /></div>;

  return (
    <div className={`wa-viewer ${chromeHidden ? 'chrome-hidden' : ''}`} role="dialog" aria-modal="true" aria-label={`${senderName} media`}>
      <header className="wa-viewer-top">
        <button type="button" onClick={onClose} aria-label="Back"><ArrowLeft size={22} /></button>
        <span className="wa-viewer-title">
          <strong>{senderName}</strong>
          <small>{formatViewerTimestamp(message.timestamp)}</small>
        </span>
        <button type="button" onClick={onStar} aria-pressed={starred} aria-label={starred ? 'Unstar' : 'Star'}>
          <Star size={21} fill={starred ? 'currentColor' : 'none'} />
        </button>
        <button type="button" onClick={onForward} aria-label="Forward"><Forward size={22} /></button>
        <span className="wa-viewer-menu-anchor">
          <button type="button" onClick={() => setMenuOpen((open) => !open)} aria-expanded={menuOpen} aria-label="More options">
            <MoreVertical size={22} />
          </button>
          {menuOpen && (
            <>
              <span className="wa-viewer-menu-backdrop" onClick={() => setMenuOpen(false)} aria-hidden="true" />
              <ul className="wa-viewer-menu" role="menu">
                {menuItems.map((item) => (
                  <li key={item.key} role="none">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        item.run();
                      }}
                    >
                      {item.label}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </span>
      </header>

      <div
        className="wa-viewer-stage"
        onClick={() => setChromeHidden((current) => !current)}
        onTouchStart={(event) => {
          swipeRef.current = event.touches.length === 1 ? event.touches[0].clientX : null;
        }}
        onTouchEnd={(event) => {
          const start = swipeRef.current;
          swipeRef.current = null;
          if (start === null || rotation) return;
          const distance = event.changedTouches[0].clientX - start;
          if (distance > SWIPE_THRESHOLD_PX && hasPrev) onPrev();
          else if (distance < -SWIPE_THRESHOLD_PX && hasNext) onNext();
        }}
      >
        <span className="wa-viewer-media" onClick={(event) => event.stopPropagation()}>{stage}</span>
        {hasPrev && <button type="button" className="wa-viewer-nav prev" onClick={(event) => { event.stopPropagation(); onPrev(); }} aria-label="Previous media"><ChevronLeft size={28} /></button>}
        {hasNext && <button type="button" className="wa-viewer-nav next" onClick={(event) => { event.stopPropagation(); onNext(); }} aria-label="Next media"><ChevronRight size={28} /></button>}
      </div>

      {toast && <div className="wa-viewer-toast" role="status">{toast}</div>}
      {ref?.id && <div className="wa-viewer-download"><DownloadProgress id={ref.id} /></div>}

      <footer className="wa-viewer-bottom">
        {trayOpen && (
          <div className="wa-viewer-tray" role="group" aria-label="Reactions">
            {[...QUICK_REACTIONS, ...EXTENDED_REACTIONS].map((emoji) => (
              <button type="button" key={emoji} className={myReaction === emoji ? 'active' : ''} aria-pressed={myReaction === emoji} aria-label={`React ${emoji}`} onClick={() => react(emoji)}>
                {emoji}
              </button>
            ))}
          </div>
        )}
        <form className="wa-viewer-reply" onSubmit={submitReply}>
          <input value={reply} onChange={(event) => setReply(event.target.value)} placeholder="Reply" maxLength={4000} aria-label={`Reply to ${senderName}`} />
          {reply.trim() ? (
            <button type="submit" className="wa-viewer-send" aria-label="Send reply"><Send size={20} /></button>
          ) : (
            <>
              {quickReactions.map((emoji) => (
                <button type="button" key={emoji} className={`wa-viewer-react ${myReaction === emoji ? 'active' : ''}`} aria-pressed={myReaction === emoji} aria-label={`React ${emoji}`} onClick={() => react(emoji)}>
                  {emoji}
                </button>
              ))}
              <button type="button" className="wa-viewer-react" onClick={() => setTrayOpen((open) => !open)} aria-expanded={trayOpen} aria-label="Add reaction">
                <SmilePlus size={24} />
              </button>
            </>
          )}
        </form>
      </footer>

      {galleryOpen && (
        <MediaGallery
          items={items}
          sessionToken={sessionToken}
          currentId={message.id}
          onSelect={(id) => {
            setGalleryOpen(false);
            onNavigate(id);
          }}
          onClose={() => setGalleryOpen(false)}
        />
      )}
      {editing && media.blob && (
        <ImageEditor blob={media.blob} filename={filename} onCancel={() => setEditing(false)} onSend={onSendEdited} />
      )}
    </div>
  );
}

// Full-screen viewer for a chat's photos, videos, and files. `items` are the chat's media messages in order.
export default function MediaViewer({ message, items, onNavigate, ...props }) {
  const index = items.findIndex((item) => item.id === message.id);
  const previous = index > 0 ? items[index - 1] : null;
  const next = index >= 0 && index < items.length - 1 ? items[index + 1] : null;
  return createPortal(
    <ViewerFrame
      key={message.id}
      message={message}
      items={items}
      hasPrev={Boolean(previous)}
      hasNext={Boolean(next)}
      onPrev={() => previous && onNavigate(previous.id)}
      onNext={() => next && onNavigate(next.id)}
      onNavigate={onNavigate}
      {...props}
    />,
    document.body,
  );
}
