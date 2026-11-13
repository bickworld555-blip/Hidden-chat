import { useMemo, useState } from 'react';
import CallAccessNotice from './CallAccessNotice.jsx';
import { Phone, Video, ArrowDownLeft, ArrowUpRight, CalendarClock, Grid3x3, Heart, PhoneCall, Search, X } from 'lucide-react';
import { scheduledCallContent } from '../groupChat.js';
import { lookupUsername } from '../contactsApi.js';
import { useChatStore } from '../store.js';
import { formatViewerTimestamp } from '../time.js';
import { groupCallLogs } from '../callLogGroups.js';
import { presentName } from '../profile.js';
import { useBackHandler } from '../backStack.js';
import Avatar from './Avatar.jsx';
import TabMenu from './TabMenu.jsx';

function describeDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total} secs`;
  const minutes = Math.floor(total / 60);
  return `${minutes}m ${total % 60}s`;
}

const nameOf = (chat) => (chat && presentName(chat)) || chat?.name || 'Unknown';
const avatarOf = (chat, name) => ({ name, initials: chat?.initials ?? name.slice(0, 2).toUpperCase(), color: chat?.color, image: chat?.avatar });

// Calls › Schedule: a named call at a chosen time, sent to the chat as a card both sides can start it from.
function ScheduleSheet({ chat, onClose, onScheduled }) {
  const [title, setTitle] = useState('');
  const [when, setWhen] = useState(() => {
    const soon = new Date(Date.now() + 60 * 60 * 1000);
    soon.setMinutes(0, 0, 0);
    return new Date(soon.getTime() - soon.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  });
  const [mode, setMode] = useState('audio');
  const [error, setError] = useState('');
  useBackHandler(true, onClose);
  function submit(event) {
    event.preventDefault();
    try {
      const content = scheduledCallContent({ title: title || `Call with ${nameOf(chat)}`, at: new Date(when).getTime(), mode });
      if (!useChatStore.getState().sendMessage(chat.id, content)) throw new Error('Sign in again to send.');
      onScheduled(chat);
    } catch (caught) {
      setError(caught.message);
    }
  }
  return (
    <form className="calls-picker calls-schedule" role="dialog" aria-modal="true" aria-label="Schedule call" onSubmit={submit}>
      <header className="calls-picker-head">
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={20} /></button>
        <h2>Schedule call</h2>
      </header>
      <div className="calls-schedule-body">
        <p className="calls-schedule-with"><Avatar {...avatarOf(chat, nameOf(chat))} size="small" /> {nameOf(chat)}</p>
        <label>Call name<input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} placeholder={`Call with ${nameOf(chat)}`} /></label>
        <label>Date and time<input type="datetime-local" value={when} onChange={(event) => setWhen(event.target.value)} required /></label>
        <div className="calls-schedule-mode" role="radiogroup" aria-label="Call type">
          <button type="button" role="radio" aria-checked={mode === 'audio'} onClick={() => setMode('audio')}><Phone size={16} /> Voice</button>
          <button type="button" role="radio" aria-checked={mode === 'video'} onClick={() => setMode('video')}><Video size={16} /> Video</button>
        </div>
        {error && <p className="calls-picker-empty" role="alert">{error}</p>}
        <button type="submit" className="calls-schedule-send"><CalendarClock size={16} /> Schedule and send</button>
      </div>
    </form>
  );
}

// Calls › Keypad: Hidden Messenger has no phone numbers, so the keypad takes a @username and calls it.
function KeypadSheet({ onClose, onCall }) {
  const sessionToken = useChatStore((state) => state.sessionToken);
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useBackHandler(true, onClose);
  async function dial(mode) {
    const username = handle.trim().replace(/^@/, '').toLowerCase();
    if (!username) return;
    setBusy(true);
    setError('');
    try {
      const known = useChatStore.getState().chats.find((chat) => chat.username?.toLowerCase() === username);
      const person = known ?? await lookupUsername(sessionToken, username);
      if (!person) throw new Error(`No one is called @${username}.`);
      onCall(person.id, mode);
    } catch (caught) {
      setError(caught.message);
      setBusy(false);
    }
  }
  return (
    <div className="calls-picker calls-keypad" role="dialog" aria-modal="true" aria-label="Keypad">
      <header className="calls-picker-head">
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={20} /></button>
        <h2>Keypad</h2>
      </header>
      <div className="calls-keypad-body">
        <input className="calls-keypad-input" value={handle} onChange={(event) => setHandle(event.target.value)} placeholder="@username" aria-label="Username to call" autoFocus autoCapitalize="none" autoCorrect="off" spellCheck={false}
          onKeyDown={(event) => { if (event.key === 'Enter') dial('audio'); }} />
        <p className="calls-picker-empty">Hidden Messenger has no phone numbers: type the person&apos;s username.</p>
        {error && <p className="calls-picker-empty" role="alert">{error}</p>}
        <div className="calls-keypad-actions">
          <button type="button" onClick={() => dial('audio')} disabled={busy || !handle.trim()} aria-label="Voice call"><Phone size={24} /></button>
          <button type="button" onClick={() => dial('video')} disabled={busy || !handle.trim()} aria-label="Video call"><Video size={24} /></button>
        </div>
      </div>
    </div>
  );
}

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
export default function CallsView({ onCall, onSheet, onSettings, onOpenChat }) {
  const clearCallLogs = useChatStore((state) => state.clearCallLogs);
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
      <div className="calls-header"><h2>Calls</h2>
        <TabMenu items={[
          { label: 'Call links', onClick: () => onSheet?.('calllinks') },
          callLogs?.length > 0 && { label: 'Clear call log', onClick: () => { if (window.confirm('Clear your call log on this device?')) clearCallLogs(); } },
          { label: 'Settings', onClick: () => onSettings?.() },
        ]} />
      </div>
      <div className="calls-list-content">
        {/* Shortcuts in a row of round buttons, as on a business messenger's Calls tab. */}
        <div className="calls-quick" role="toolbar" aria-label="Call shortcuts">
          <button type="button" onClick={() => setPicker('call')}><span className="calls-quick-icon" aria-hidden="true"><Phone size={22} /></span>Call</button>
          <button type="button" onClick={() => setPicker('schedule')}><span className="calls-quick-icon" aria-hidden="true"><CalendarClock size={22} /></span>Schedule</button>
          <button type="button" onClick={() => setPicker('keypad')}><span className="calls-quick-icon" aria-hidden="true"><Grid3x3 size={22} /></span>Keypad</button>
          <button type="button" className="calls-add-favourite" onClick={() => setPicker('favourite')}><span className="calls-quick-icon" aria-hidden="true"><Heart size={22} /></span>Favourites</button>
        </div>
        <CallAccessNotice />
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
                    {row.answered ? `${formatViewerTimestamp(row.timestamp)} · ${describeDuration(row.duration)}` : row.silenced ? `Silenced · ${formatViewerTimestamp(row.timestamp)}` : formatViewerTimestamp(row.timestamp)}
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
      {picker === 'schedule' && <ContactPicker title="Schedule a call with" chats={people} onClose={() => setPicker(null)} onPick={(chat) => setPicker({ schedule: chat })} />}
      {picker?.schedule && <ScheduleSheet chat={picker.schedule} onClose={() => setPicker(null)} onScheduled={(chat) => { setPicker(null); onOpenChat?.(chat.id); }} />}
      {picker === 'keypad' && <KeypadSheet onClose={() => setPicker(null)} onCall={call} />}
      {picker === 'favourite' && (
        <ContactPicker title="Add favourite" chats={people.filter((chat) => !favouriteChatIds.includes(chat.id))} onClose={() => setPicker(null)}
          onPick={(chat) => { toggleFavouriteChat(chat.id); setPicker(null); }} />
      )}
    </div>
  );
}
