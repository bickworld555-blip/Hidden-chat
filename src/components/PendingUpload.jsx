import { AlertCircle, Clock3, FileText, Mic, RotateCw, Video, X } from 'lucide-react';
import { formatFileSize, formatVideoLength } from '../media.js';

// WhatsApp-style progress ring: the arc fills as bytes go up; the X in the middle cancels.
// While the file is still being prepared (compressed, thumbnail made) the arc spins instead of filling.
function ProgressRing({ fraction, onCancel, preparing = false, size = 48, iconSize = 18 }) {
  const radius = size / 2 - 4;
  const circumference = 2 * Math.PI * radius;
  const shown = Math.max(0.04, Math.min(1, fraction));
  return (
    <button type="button" className={`pending-upload-ring${preparing ? ' is-preparing' : ''}`} style={{ '--ring': `${size}px` }} onClick={onCancel} aria-label="Cancel sending">
      <svg className="pending-upload-ring-svg" viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={radius} className="pending-upload-ring-track" />
        <circle cx={size / 2} cy={size / 2} r={radius} className="pending-upload-ring-fill" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - shown)} />
      </svg>
      <X size={iconSize} />
    </button>
  );
}

// A failed upload: Retry in place of the ring (as on WhatsApp), and a small X to dismiss it.
function RetryButton({ onRetry, onDismiss, size = 48, iconSize = 18 }) {
  return (
    <span className="pending-upload-retry-wrap">
      <button type="button" className="pending-upload-ring pending-upload-retry" style={{ '--ring': `${size}px` }} onClick={onRetry} aria-label="Retry sending">
        <RotateCw size={iconSize} />
      </button>
      <button type="button" className="pending-upload-dismiss" onClick={onDismiss} aria-label="Remove"><X size={12} /></button>
    </span>
  );
}

// The outgoing bubble shown while an attachment uploads, in place of a separate progress bar. A photo or video shows
// itself at full brightness at once (a video its own frame, src/mediaThumb.js videoPreview), at its own shape; the
// progress, size counter and cancel sit in a slim strip along the bottom edge, never over the middle of the picture.
export default function PendingUpload({ upload, onCancel, onRetry }) {
  const fraction = upload.total > 0 ? upload.sent / upload.total : 0;
  const failed = Boolean(upload.failed);
  const status = failed ? 'Not sent · Tap to retry' : upload.preparing ? 'Preparing…' : `${formatFileSize(upload.sent)} / ${formatFileSize(upload.total)}`;
  const control = (size, iconSize) => (failed
    ? <RetryButton onRetry={onRetry} onDismiss={onCancel} size={size} iconSize={iconSize} />
    : <ProgressRing fraction={fraction} onCancel={onCancel} preparing={upload.preparing} size={size} iconSize={iconSize} />);
  const visual = upload.kind === 'image' || upload.kind === 'video';
  const picture = upload.kind === 'image' ? upload.previewUrl : upload.poster;
  const shape = upload.aspect > 0 ? { aspectRatio: String(Math.min(16 / 9, Math.max(9 / 16, upload.aspect))) } : undefined;
  return (
    <div className="message-line mine pending-upload-line" role="status" aria-live="polite" aria-label={failed ? `${upload.filename} was not sent: ${upload.error || 'upload failed'}` : `Sending ${upload.filename}, ${Math.floor(fraction * 100)}%`}>
      <div className={`message-bubble outgoing attachment-bubble pending-upload is-${upload.kind}${failed ? ' is-failed' : ''}`} title={failed ? upload.error : undefined}>
        {visual ? (
          <div className={`pending-upload-visual${picture ? '' : ' is-empty'}`} style={shape}>
            {picture
              ? <img src={picture} alt="" className="pending-upload-media" />
              : <span className="pending-upload-placeholder" aria-hidden="true">{upload.kind === 'video' && <Video size={28} />}</span>}
            <div className="pending-upload-bar">
              {control(28, 13)}
              <small className="pending-upload-status">{status}</small>
              <span className="pending-upload-meta">
                {upload.kind === 'video' && upload.seconds > 0 && <span className="pending-upload-length"><Video size={13} /> {formatVideoLength(upload.seconds)}</span>}
                {failed ? <AlertCircle size={13} aria-label="Not sent" /> : !upload.caption && <Clock3 size={12} aria-label="Sending" />}
              </span>
            </div>
          </div>
        ) : (
          <div className="pending-upload-file">
            {control(44, 18)}
            <span className="pending-upload-file-icon">{upload.kind === 'voice' ? <Mic size={20} /> : <FileText size={20} />}</span>
            <span className="pending-upload-file-text">
              <strong title={upload.filename}>{upload.kind === 'voice' ? 'Voice message' : upload.filename}</strong>
              <small>{status}</small>
            </span>
          </div>
        )}
        {/* The caption sits under the photo with a clock until it is sent, as on WhatsApp. */}
        {upload.caption && <p className="wa-media-caption pending-upload-caption" dir="auto">{upload.caption}<span className="pending-upload-clock" aria-label={failed ? 'Not sent' : 'Sending'}>{failed ? <AlertCircle size={13} /> : <Clock3 size={13} />}</span></p>}
      </div>
    </div>
  );
}
