import { Phone, Video, ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import { useChatStore } from '../store.js';
import { formatViewerTimestamp } from '../time.js';
import { groupCallLogs } from '../callLogGroups.js';
import { presentName } from '../profile.js';
import Avatar from './Avatar.jsx';

function describeDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total} secs`;
  const minutes = Math.floor(total / 60);
  return `${minutes}m ${total % 60}s`;
}

// Calls tab: a "Recent" list where back-to-back calls with the same person are one row with a count.
export default function CallsView({ onCall }) {
  const callLogs = useChatStore((state) => state.callLogs);
  const chats = useChatStore((state) => state.chats);
  const header = <div className="calls-header"><h2>Calls</h2></div>;

  if (!callLogs || callLogs.length === 0) {
    return (
      <div className="calls-view-container">
        {header}
        <div className="empty-state">
          <Phone size={48} strokeWidth={1.5} />
          <h3>No call history</h3>
          <p>Your call history will appear here</p>
        </div>
      </div>
    );
  }

  return (
    <div className="calls-view-container">
      {header}
      <div className="calls-list-content">
        <h3 className="calls-section">Recent</h3>
        {groupCallLogs(callLogs).map((row) => {
          const chat = chats.find((c) => c.id === row.peerId);
          const name = (chat && presentName(chat)) || chat?.name || 'Unknown';
          const isIncoming = row.direction === 'incoming';
          const missed = !row.answered;
          const Arrow = isIncoming ? ArrowDownLeft : ArrowUpRight;
          const ModeIcon = row.mode === 'video' ? Video : Phone;

          return (
            <div key={row.key} className="call-log-item">
              <Avatar
                name={name}
                initials={chat?.initials ?? name.slice(0, 2).toUpperCase()}
                color={chat?.color}
                image={chat?.avatar}
                online={chat?.online}
                size="small"
              />
              <div className="call-log-details">
                <div className="call-log-header">
                  <strong className={missed && isIncoming ? 'call-log-missed' : ''}>{name}{row.count > 1 && <span className="call-log-count"> ({row.count})</span>}</strong>
                  <span className="call-log-time">{formatViewerTimestamp(row.timestamp)}</span>
                </div>
                <div className="call-log-meta">
                  <span className={`call-status ${missed && isIncoming ? 'call-log-missed' : ''}`}>
                    <Arrow size={12} />
                    {isIncoming ? 'Incoming' : 'Outgoing'}
                    {' · '}
                    {row.answered ? describeDuration(row.duration) : isIncoming ? 'Missed' : 'No answer'}
                  </span>
                </div>
              </div>
              <button
                type="button"
                className="call-action-btn"
                onClick={() => onCall?.(row.peerId, row.mode)}
                title={`${row.mode === 'video' ? 'Video' : 'Voice'} call ${name}`}
                aria-label={`${row.mode === 'video' ? 'Video' : 'Voice'} call ${name}`}
              >
                <ModeIcon size={18} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
