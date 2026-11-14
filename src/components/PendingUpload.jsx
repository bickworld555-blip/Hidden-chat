import { Clock3, FileText, Mic, Video, X } from 'lucide-react';
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

// The outgoing bubble shown while an attachment uploads, in place of a separate progress bar. A photo or video shows
// itself at full brightness at once (a video its own frame, src/mediaThumb.js videoPreview), at its own shape; the
// progress, size counter and cancel sit in a slim strip along the bottom edge, never over the middle of the picture.
export default function PendingUpload({ upload, onCancel }) {
  const fraction = upload.total > 0 ? upload.sent / upload.total : 0;
  const status = upload.preparing ? 'Preparing…' : `${formatFileSize(upload.sent)} / ${formatFileSize(upload.total)}`;
  const visual = upload.kind === 'image' || upload.kind === 'video';
  const picture = upload.kind === 'image' ? upload.previewUrl : upload.poster;
  const shape = upload.aspect > 0 ? { aspectRatio: String(Math.min(16 / 9, Math.max(9 / 16, upload.aspect))) } : undefined;
  return (
    <div className="message-line mine pending-upload-line" role="status" aria-live="polite" aria-label={`Sending ${upload.filename}, ${Math.floor(fraction * 100)}%`}>
      <div className={`message-bubble outgoing attachment-bubble pending-upload is-${upload.kind}`}>
        {visual ? (
          <div className={`pending-upload-visual${picture ? '' : ' is-empty'}`} style={shape}>
            {picture
              ? <img src={picture} alt="" className="pending-upload-media" />
              : <span className="pending-upload-placeholder" aria-hidden="true">{upload.kind === 'video' && <Video size={28} />}</span>}
            <div className="pending-upload-bar">
              <ProgressRing fraction={fraction} onCancel={onCancel} preparing={upload.preparing} size={28} iconSize={13} />
              <small className="pending-upload-status">{status}</small>
              <span className="pending-upload-meta">
                {upload.kind === 'video' && upload.seconds > 0 && <span className="pending-upload-length"><Video size={13} /> {formatVideoLength(upload.seconds)}</span>}
                {!upload.caption && <Clock3 size={12} aria-label="Sending" />}
              </span>
            </div>
          </div>
        ) : (
          <div className="pending-upload-file">
            <ProgressRing fraction={fraction} onCancel={onCancel} preparing={upload.preparing} size={44} iconSize={18} />
            <span className="pending-upload-file-icon">{upload.kind === 'voice' ? <Mic size={20} /> : <FileText size={20} />}</span>
            <span className="pending-upload-file-text">
              <strong title={upload.filename}>{upload.kind === 'voice' ? 'Voice message' : upload.filename}</strong>
              <small>{status}</small>
            </span>
          </div>
        )}
        {/* The caption sits under the photo with a clock until it is sent, as on WhatsApp. */}
        {upload.caption && <p className="wa-media-caption pending-upload-caption" dir="auto">{upload.caption}<span className="pending-upload-clock" aria-label="Sending"><Clock3 size={13} /></span></p>}
      </div>
    </div>
  );
}
