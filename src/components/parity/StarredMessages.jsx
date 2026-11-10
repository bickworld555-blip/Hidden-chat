// Starred messages from every chat (they follow the account, so every device shows the same list).
import { useEffect } from 'react';
import { Star, Users } from 'lucide-react';
import { toggleStar, useAccountData } from '../../accountData.js';
import { listStars } from '../../parityApi.js';
import { previewFor } from '../../store.js';
import { formatMessageDate, formatMessageTime } from '../../time.js';
import Panel from './Panel.jsx';

export default function StarredMessages({ token, userId, onClose, onOpenChat, onOpenGroup }) {
  const list = useAccountData((state) => state.starList);
  // The account store keeps the list current; refreshing on open picks up text edited since.
  useEffect(() => { listStars(token).then((items) => useAccountData.setState({ starList: items })).catch(() => {}); }, [token]);
  return (
    <Panel title="Starred messages" onClose={onClose}>
      {list.length === 0 && (
        <p className="hm-empty"><Star size={32} aria-hidden="true" /><br />Tap and hold any message to star it, so you can easily find it later.</p>
      )}
      <ul className="hm-starred-list">
        {list.map((item) => {
          const group = item.chatKey.startsWith('group:');
          return (
            <li key={item.messageId}>
              <button type="button" className="hm-starred-open" onClick={() => (group ? onOpenGroup(item.chatKey.slice(6)) : onOpenChat(item.chatKey, item.messageId))}>
                <span className="hm-starred-head">
                  <strong>{item.senderId === userId ? 'You' : item.senderName}</strong>
                  {group && <small><Users size={12} aria-hidden="true" /> {item.groupName}</small>}
                  <time>{formatMessageDate(item.timestamp)} {formatMessageTime(item.timestamp)}</time>
                </span>
                <span className="hm-starred-text">{previewFor(item.content)}</span>
              </button>
              <button type="button" className="icon-button" aria-label="Unstar" onClick={() => toggleStar(item.messageId, item.chatKey, false).catch(() => {})}>
                <Star size={16} fill="currentColor" />
              </button>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
