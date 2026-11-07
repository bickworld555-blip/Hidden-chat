import { Plus, Eye } from 'lucide-react';
import { useChatStore } from '../store.js';
import Avatar from './Avatar.jsx';

export default function UpdatesView() {
  const chats = useChatStore((state) => state.chats);

  return (
    <div className="updates-view-container">
      <div className="updates-header">
        <h2>Updates</h2>
        <button className="icon-button" title="Post a status" aria-label="Post new status">
          <Plus size={18} />
        </button>
      </div>

      <div className="updates-content">
        {/* Your Status */}
        <div className="my-status-section">
          <div className="my-status-card">
            <div className="my-status-avatar">
              <Avatar name="You" online={false} size="medium" />
              <span className="status-add-indicator">
                <Plus size={14} />
              </span>
            </div>
            <div className="my-status-info">
              <strong>Your status</strong>
              <small>Tap to add update</small>
            </div>
          </div>
        </div>

        {/* Recent Updates from Contacts */}
        <div className="recent-updates-section">
          <h3>Recent updates</h3>
          {chats && chats.length > 0 ? (
            <div className="updates-list">
              {chats.map((chat) => (
                <button key={chat.id} className="update-item">
                  <Avatar
                    name={chat.name}
                    status={chat.status}
                    online={chat.online}
                    size="small"
                  />
                  <div className="update-item-info">
                    <strong>{chat.name}</strong>
                    <small>Few moments ago</small>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <Eye size={48} strokeWidth={1.5} />
              <p>No status updates yet</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
