import { Phone, Video, ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import { useChatStore } from '../store.js';
import { formatViewerTimestamp } from '../time.js';
import Avatar from './Avatar.jsx';

function describeDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total} secs`;
  const minutes = Math.floor(total / 60);
  return `${minutes}m ${total % 60}s`;
}

export default function CallsView({ onCall }) {
  const callLogs = useChatStore((state) => state.callLogs);
  const chats = useChatStore((state) => state.chats);

  if (!callLogs || callLogs.length === 0) {
    return (
      <div className="calls-view-container">
        <div className="calls-header">
          <h2>Calls</h2>
        </div>
        <div className="empty-state">
          <Phone size={48} strokeWidth={1.5} />
          <h3>No call history</h3>
          <p>Your call history will appear here</p>
        </div>
      </div>
    );
  }

  const getChatInfo = (peerId) => {
    return chats.find((c) => c.id === peerId);
  };

  return (
    <div className="calls-view-container">
      <div className="calls-header">
        <h2>Calls</h2>
      </div>
      <div className="calls-list-content">
        {callLogs.map((log) => {
          const chat = getChatInfo(log.peerId);
          const name = chat?.name || 'Unknown';
          const isIncoming = log.direction === 'incoming';
          const answered = log.status === 'completed' && log.duration > 0;
          const missed = !answered;
          const Arrow = isIncoming ? ArrowDownLeft : ArrowUpRight;

          return (
            <div key={log.id} className="call-log-item">
              <Avatar
                name={name}
                initials={chat?.initials ?? name.slice(0, 2).toUpperCase()}
                color={chat?.color}
                online={chat?.online}
                size="small"
              />
              <div className="call-log-details">
                <div className="call-log-header">
                  <strong className={missed && isIncoming ? 'call-log-missed' : ''}>{name}</strong>
                  <span className="call-log-time">{formatViewerTimestamp(log.timestamp)}</span>
                </div>
                <div className="call-log-meta">
                  <span className={`call-status ${missed && isIncoming ? 'call-log-missed' : ''}`}>
                    <Arrow size={12} />
                    {isIncoming ? 'Incoming' : 'Outgoing'}
                    {' · '}
                    {answered ? describeDuration(log.duration) : isIncoming ? 'Missed' : 'No answer'}
                  </span>
                </div>
              </div>
              <button
                type="button"
                className="call-action-btn"
                onClick={() => onCall?.(log.peerId, log.mode)}
                title={`${log.mode === 'video' ? 'Video' : 'Voice'} call ${name}`}
                aria-label={`${log.mode === 'video' ? 'Video' : 'Voice'} call ${name}`}
              >
                {log.mode === 'video' ? <Video size={16} /> : <Phone size={16} />}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
