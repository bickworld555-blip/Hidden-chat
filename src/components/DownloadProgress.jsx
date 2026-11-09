import { X } from 'lucide-react';
import { cancelDownload, formatEta, formatRate, useDownloadProgress } from '../downloads.js';
import { formatFileSize } from '../media.js';

// WhatsApp-style progress ring with percentage and time left; shown over any attachment being saved.
export default function DownloadProgress({ id, compact = false }) {
  const progress = useDownloadProgress(id);
  if (progress?.status === 'done' && progress.savedTo) {
    // Android app: where the file landed (gallery + file manager).
    return (
      <div className={`dl-overlay is-saved ${compact ? 'is-compact' : ''}`} role="status" aria-live="polite" onClick={(event) => event.stopPropagation()}>
        <span className="dl-text">{compact ? 'Saved' : `Saved to ${progress.savedTo.split('/').slice(0, -1).join('/')}`}</span>
      </div>
    );
  }
  if (!progress || (progress.status !== 'running' && progress.status !== 'error')) return null;
  const percent = Math.round((progress.fraction ?? 0) * 100);
  const radius = compact ? 13 : 20;
  const circumference = 2 * Math.PI * radius;
  const size = compact ? 34 : 50;
  return (
    <div className={`dl-overlay ${compact ? 'is-compact' : ''} ${progress.status === 'error' ? 'is-error' : ''}`} role="status" aria-live="polite" onClick={(event) => event.stopPropagation()}>
      {progress.status === 'running' ? (
        <>
          <button type="button" className="dl-ring" onClick={() => cancelDownload(id)} aria-label={`Cancel download, ${percent}%`} title="Cancel">
            <svg viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
              <circle cx={size / 2} cy={size / 2} r={radius} className="dl-ring-track" />
              <circle cx={size / 2} cy={size / 2} r={radius} className="dl-ring-value" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - Math.max(progress.fraction ?? 0, 0.02))} />
            </svg>
            <span className="dl-ring-label">{progress.total ? `${percent}%` : <X size={14} />}</span>
          </button>
          {!compact && (
            <span className="dl-text">
              {progress.total ? `${formatFileSize(progress.received)} of ${formatFileSize(progress.total)}` : 'Starting…'}
              {progress.etaSeconds !== null && progress.etaSeconds !== undefined ? ` · ${formatEta(progress.etaSeconds)}` : ''}
              {progress.rate ? ` · ${formatRate(progress.rate)}` : ''}
            </span>
          )}
        </>
      ) : (
        <span className="dl-text">{progress.error}</span>
      )}
    </div>
  );
}
