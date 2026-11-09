import { ArrowDownLeft, ArrowUpRight, Phone, PhoneMissed, Video, VideoOff } from 'lucide-react';
import { callCardView } from '../callCard.js';

// A finished call in the chat, laid out like WhatsApp's: icon tile, "Voice call" / "Missed video call", the
// duration or "No answer" underneath, and the time in the corner. Tapping it calls the person back.
export default function CallStatusBubble({ callData, isOutgoing, timestamp, onCallBack }) {
  const view = callCardView(callData, isOutgoing);
  const Icon = view.missed ? (view.video ? VideoOff : PhoneMissed) : view.video ? Video : Phone;
  const Arrow = isOutgoing ? ArrowUpRight : ArrowDownLeft;
  return (
    <button
      type="button"
      className={`message-bubble call-card ${isOutgoing ? 'outgoing' : 'incoming'} ${view.missed ? 'is-missed' : ''}`}
      onClick={onCallBack ? () => onCallBack(view.video ? 'video' : 'audio') : undefined}
      aria-label={`${view.title}, ${view.detail}, ${timestamp}. Call back`}
    >
      <span className="call-card-icon" aria-hidden="true"><Icon size={20} /></span>
      <span className="call-card-text">
        <strong>{view.title}</strong>
        <small>
          {!view.missed && <Arrow size={13} className={view.answered ? 'call-card-arrow' : 'call-card-arrow is-unanswered'} aria-hidden="true" />}
          {view.detail}
        </small>
      </span>
      <time className="call-card-time">{timestamp}</time>
    </button>
  );
}
