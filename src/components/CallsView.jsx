import { useMemo, useState } from 'react';
import { Phone, Video, ArrowDownLeft, ArrowUpRight, Heart, Link2, PhoneCall, Search, X } from 'lucide-react';
import { useChatStore } from '../store.js';
import { formatViewerTimestamp } from '../time.js';
import { groupCallLogs } from '../callLogGroups.js';
import { presentName } from '../profile.js';
import { useBackHandler } from '../backStack.js';
import Avatar from './Avatar.jsx';

function describeDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total} secs`;
  const minutes = Math.floor(total / 60);
  return `${minutes}m ${total % 60}s`;
}

const nameOf = (chat) => (chat && presentName(chat)) || chat?.name || 'Unknown';
const avatarOf = (chat, name) => ({ name, initials: chat?.initials ?? name.slice(0, 2).toUpperCase(), color: chat?.color, image: chat?.avatar });

// Choose a contact: to call (voice / video buttons) or to add to favourites (tap the row).
function ContactPicker({ title, chats, onClose, onPick, onCall }) {
  const [query, setQuery] = useState('');
  useBackHandler(true, onClose);
  const needle = query.trim().toLowerCase();
  const shown = chats.filter((chat) => !needle || nameOf(chat).toLowerCase().includes(needle) || (chat.username ?? '').toLowerCase().includes(needle));
  return (
    <div className="calls-picker" role="dialog" aria-modal="true" aria-label={title}>
      <header className="calls-picker-head">
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={20} /></button>
        <h2>{title}</h2>
      </header>
      <label className="calls-picker-search"><Search size={16} aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name or @username" aria-label="Search contacts" autoFocus /></label>
      <div className="calls-picker-list">
        {shown.map((chat) => {
          const name = nameOf(chat);
          return (
            <div key={chat.id} className="call-log-item">
              <button type="button" className="calls-picker-main" onClick={() => onPick?.(chat)} disabled={!onPick}>
                <Avatar {...avatarOf(chat, name)} size="small" />
                <span className="call-log-details"><strong>{name}</strong>{chat.username && <small className="call-log-meta">@{chat.username}</small>}</span>
              </button>
              {onCall && (
                <span className="call-actions">
                  <button type="button" className="call-action-btn" onClick={() => onCall(chat.id, 'audio')} aria-label={`Voice call ${name}`}><Phone size={18} /></button>
                  <button type="button" className="call-action-btn" onClick={() => onCall(chat.id, 'video')} aria-label={`Video call ${name}`}><Video size={18} /></button>
                </span>
              )}
            </div>
          );
        })}
        {!shown.length && <p className="calls-picker-empty">{needle ? `No contacts match “${query.trim()}”.` : 'No contacts yet.'}</p>}
      </div>
    </div>
  );
}

// Calls tab: shortcuts (new call, call links, favourites), Favourites (shared with the Favourites chat filter) with one-tap voice and video, the Recent list
// (back-to-back calls with the same person are one row with a count), and a new-call button.
export default function CallsView({ onCall, onSheet }) {
  const callLogs = useChatStore((state) => state.callLogs);
  const chats = useChatStore((state) => state.chats);
  const favouriteChatIds = useChatStore((state) => state.favouriteChatIds ?? []);
  const toggleFavouriteChat = useChatStore((state) => state.toggleFavouriteChat);
  const [picker, setPicker] = useState(null);
  const people = useMemo(() => chats.filter((chat) => !chat.isGroup && !chat.group && chat.id), [chats]);
  const favourites = favouriteChatIds.map((id) => people.find((chat) => chat.id === id)).filter(Boolean);
  const rows = groupCallLogs(callLogs ?? []);
  const call = (peerId, mode) => { setPicker(null); onCall?.(peerId, mode); };

  return (
    <div className="calls-view-container">
      <div className="calls-header"><h2>Calls</h2></div>
      <div className="calls-list-content">
        {/* Shortcuts in a row of round buttons, as on a business messenger's Calls tab. */}
        <div className="calls-quick" role="toolbar" aria-label="Call shortcuts">
          <button type="button" onClick={() => setPicker('call')}><span className="calls-quick-icon" aria-hidden="true"><Phone size={22} /></span>Call</button>
          <button type="button" onClick={() => onSheet?.('calllinks')}><span className="calls-quick-icon" aria-hidden="true"><Link2 size={22} /></span>Link</button>
          <button type="button" className="calls-add-favourite" onClick={() => setPicker('favourite')}><span className="calls-quick-icon" aria-hidden="true"><Heart size={22} /></span>Favourites</button>
        </div>
        {favourites.length > 0 && <h3 className="calls-section">Favourites</h3>}
        {favourites.map((chat) => {
          const name = nameOf(chat);
          return (
            <div key={chat.id} className="call-log-item">
              <Avatar {...avatarOf(chat, name)} online={chat.online} size="small" />
              <div className="call-log-details"><div className="call-log-header"><strong>{name}</strong></div></div>
              <span className="call-actions">
                <button type="button" className="call-action-btn" onClick={() => call(chat.id, 'audio')} aria-label={`Voice call ${name}`}><Phone size={18} /></button>
                <button type="button" className="call-action-btn" onClick={() => call(chat.id, 'video')} aria-label={`Video call ${name}`}><Video size={18} /></button>
              </span>
            </div>
          );
        })}

        <h3 className="calls-section">Recent</h3>
        {rows.length === 0 && (
          <div className="calls-empty">
            <Phone size={36} strokeWidth={1.5} aria-hidden="true" />
            <p>Your call history will appear here. Tap the call button to start one.</p>
          </div>
        )}
        {rows.map((row) => {
          const chat = chats.find((c) => c.id === row.peerId);
          const name = nameOf(chat);
          const isIncoming = row.direction === 'incoming';
          const missed = !row.answered;
          const Arrow = isIncoming ? ArrowDownLeft : ArrowUpRight;
          const ModeIcon = row.mode === 'video' ? Video : Phone;
          return (
            <div key={row.key} className="call-log-item">
              <Avatar {...avatarOf(chat, name)} online={chat?.online} size="small" />
              <div className="call-log-details">
                <div className="call-log-header">
                  <strong className={missed && isIncoming ? 'call-log-missed' : ''}>{name}{row.count > 1 && <span className="call-log-count"> ({row.count})</span>}</strong>
                </div>
                <div className="call-log-meta">
                  <span className={`call-status ${missed && isIncoming ? 'call-log-missed' : ''}`}>
                    <Arrow size={12} />
                    {row.answered ? `${formatViewerTimestamp(row.timestamp)} · ${describeDuration(row.duration)}` : formatViewerTimestamp(row.timestamp)}
                  </span>
                </div>
              </div>
              <button type="button" className="call-action-btn" onClick={() => call(row.peerId, row.mode)}
                title={`${row.mode === 'video' ? 'Video' : 'Voice'} call ${name}`} aria-label={`${row.mode === 'video' ? 'Video' : 'Voice'} call ${name}`}>
                <ModeIcon size={20} />
              </button>
            </div>
          );
        })}
      </div>
      <button type="button" className="calls-fab" onClick={() => setPicker('call')} aria-label="New call"><PhoneCall size={24} /></button>
      {picker === 'call' && <ContactPicker title="New call" chats={people} onClose={() => setPicker(null)} onCall={call} />}
      {picker === 'favourite' && (
        <ContactPicker title="Add favourite" chats={people.filter((chat) => !favouriteChatIds.includes(chat.id))} onClose={() => setPicker(null)}
          onPick={(chat) => { toggleFavouriteChat(chat.id); setPicker(null); }} />
      )}
    </div>
  );
}
