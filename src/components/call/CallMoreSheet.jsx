import { AudioLines, MessageSquareText, MonitorUp } from 'lucide-react';
import { CALL_REACTIONS } from '../../callEngine.js';

// Loaded on first use (like WhatsApp's ViewStub panels): the call screen starts without it.
// The ⋯ sheet: quick reactions, then Share screen, Send message and Noise cancellation.
export default function CallMoreSheet({ onReact, canShareScreen, screenSharing, onShareScreen, onSendMessage, noiseSuppression, onNoiseSuppression, onClose }) {
  return (
    <div className="wa-call-more-layer" onClick={onClose} role="presentation">
      <div className="wa-call-more" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="More call options">
        <div className="wa-call-reactions" role="toolbar" aria-label="Send a reaction">
          {CALL_REACTIONS.map((emoji) => <button type="button" key={emoji} onClick={() => onReact(emoji)} aria-label={`React ${emoji}`}>{emoji}</button>)}
        </div>
        <div className="wa-call-more-menu">
          {canShareScreen && (
            <button type="button" onClick={onShareScreen}>
              <span className="wa-call-more-icon"><MonitorUp size={20} /></span>
              <span>{screenSharing ? 'Stop sharing screen' : 'Share screen'}</span>
            </button>
          )}
          <button type="button" onClick={onSendMessage}>
            <span className="wa-call-more-icon"><MessageSquareText size={20} /></span>
            <span>Send message</span>
          </button>
          <button type="button" role="switch" aria-checked={noiseSuppression} onClick={() => onNoiseSuppression(!noiseSuppression)}>
            <span className="wa-call-more-icon"><AudioLines size={20} /></span>
            <span>Noise cancellation</span>
            <span className={`wa-switch${noiseSuppression ? ' on' : ''}`} aria-hidden="true"><span /></span>
          </button>
        </div>
      </div>
    </div>
  );
}
