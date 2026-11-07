import { Phone, PhoneOff, PhoneIncoming, PhoneMissed, Clock } from 'lucide-react';

function formatCallDuration(seconds) {
  if (!seconds || seconds < 0) return '0 secs';
  if (seconds < 60) return `${Math.floor(seconds)} secs`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingSeconds > 0 
    ? `${hours}h ${remainingMinutes}m ${remainingSeconds}s` 
    : `${hours}h ${remainingMinutes}m`;
}

export default function CallStatusBubble({ callData, isOutgoing, timestamp }) {
  const isNoAnswer = callData.status === 'no-answer' || callData.status === 'missed' || !callData.duration;
  const duration = callData.duration || 0;
  const isVideo = callData.mode === 'video';

  return (
    <div className={`call-status-bubble ${isOutgoing ? 'outgoing' : 'incoming'}`}>
      <div className="call-status-content">
        <div className="call-status-icon">
          {isNoAnswer ? (
            <>
              <PhoneMissed size={20} className="call-missed-icon" />
            </>
          ) : isOutgoing ? (
            <PhoneIncoming size={20} className="call-outgoing-icon" style={{ transform: 'rotate(135deg)' }} />
          ) : (
            <PhoneIncoming size={20} className="call-incoming-icon" />
          )}
        </div>
        
        <div className="call-status-info">
          <div className="call-status-type">
            {isNoAnswer ? (
              <>
                <span className="call-type-label">
                  {isVideo ? 'Video call' : 'Voice call'}
                </span>
                <span className="call-no-answer"> / No answer</span>
              </>
            ) : (
              <>
                <span className="call-type-label">
                  {isVideo ? 'Video call' : 'Voice call'}
                </span>
                {isOutgoing ? (
                  <span className="call-direction"> (outgoing)</span>
                ) : (
                  <span className="call-direction"> (incoming)</span>
                )}
              </>
            )}
          </div>
          
          {!isNoAnswer && (
            <div className="call-duration">
              <Clock size={14} />
              <span>{formatCallDuration(duration)}</span>
            </div>
          )}
          
          <div className="call-timestamp">
            {timestamp}
          </div>
        </div>
      </div>
    </div>
  );
}
