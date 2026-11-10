import { useEffect, useState } from 'react';
import { Pin, X } from 'lucide-react';

/**
 * The bar under a chat header with its pinned messages (up to three): tap to jump to the shown one and cycle to the
 * next; × unpins it (when allowed). `pins` are { messageId }, newest first; `describe(id)` gives its preview text.
 */
export default function PinnedBanner({ pins, describe, onJump, onUnpin, canUnpin = true }) {
  const [index, setIndex] = useState(0);
  useEffect(() => { if (index >= (pins?.length ?? 0)) setIndex(0); }, [pins, index]);
  if (!pins?.length) return null;
  const current = pins[Math.min(index, pins.length - 1)];
  return (
    <div className="hm-pinned-banner" role="region" aria-label="Pinned messages">
      {pins.length > 1 && (
        <span className="hm-pinned-steps" aria-hidden="true">
          {pins.map((pin, step) => <i key={pin.messageId} className={step === index ? 'is-current' : ''} />)}
        </span>
      )}
      <button type="button" className="hm-pinned-main" onClick={() => { onJump(current.messageId); setIndex((value) => (value + 1) % pins.length); }}
        aria-label={`Pinned message ${index + 1} of ${pins.length}: ${describe(current.messageId)}. Show in chat`}>
        <Pin size={16} aria-hidden="true" />
        <span>{describe(current.messageId)}</span>
      </button>
      {canUnpin && <button type="button" className="hm-pinned-close" onClick={() => onUnpin(current.messageId)} aria-label="Unpin message"><X size={16} /></button>}
    </div>
  );
}
