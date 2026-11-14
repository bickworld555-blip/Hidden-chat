import { Clock3, FileText, Mic, X } from 'lucide-react';
import { formatFileSize } from '../media.js';

// WhatsApp-style progress ring: the arc fills as bytes go up; the X in the middle cancels.
// While the file is still being prepared (compressed, thumbnail made) the arc spins instead of filling.
function ProgressRing({ fraction, onCancel, preparing = false }) {
  const radius = 20;
  const circumference = 2 * Math.PI * radius;
  const shown = Math.max(0.04, Math.min(1, fraction));
  return (
    <button type="button" className={`pending-upload-ring${preparing ? ' is-preparing' : ''}`} onClick={onCancel} aria-label="Cancel sending">
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <circle cx="24" cy="24" r={radius} className="pending-upload-ring-track" />
        <circle cx="24" cy="24" r={radius} className="pending-upload-ring-fill" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - shown)} />
      </svg>
      <X size={18} />
    </button>
  );
}

// The outgoing bubble shown while an attachment uploads, in place of a separate progress bar.
export default function PendingUpload({ upload, onCancel }) {
  const fraction = upload.total > 0 ? upload.sent / upload.total : 0;
  const status = upload.preparing ? 'Preparing…' : `${formatFileSize(upload.sent)} / ${formatFileSize(upload.total)}`;
  return (
    <div className="message-line mine pending-upload-line" role="status" aria-live="polite" aria-label={`Sending ${upload.filename}, ${Math.floor(fraction * 100)}%`}>
      <div className={`message-bubble outgoing attachment-bubble pending-upload is-${upload.kind}`}>
        {upload.previewUrl && upload.kind === 'image' && <img src={upload.previewUrl} alt="" className="pending-upload-media" />}
        {upload.previewUrl && upload.kind === 'video' && <video src={upload.previewUrl} muted playsInline preload="metadata" className="pending-upload-media" />}
        {(upload.kind === 'image' || upload.kind === 'video') ? (
          <div className="pending-upload-overlay">
            <ProgressRing fraction={fraction} onCancel={onCancel} preparing={upload.preparing} />
            <small>{status}</small>
          </div>
        ) : (
          <div className="pending-upload-file">
            <ProgressRing fraction={fraction} onCancel={onCancel} preparing={upload.preparing} />
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
