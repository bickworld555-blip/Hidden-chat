import { useEffect, useMemo, useState } from 'react';
import { Archive, AtSign, Bell, ChevronDown, LogOut, MessageSquarePlus, MoreHorizontal, Pin, Search, Settings2, UserRoundPlus, Users, Volume2, VolumeX } from 'lucide-react';
import { useChatStore } from '../store.js';
import Avatar from './Avatar.jsx';
import ProfilePhoto from './ProfilePhoto.jsx';
import { useAccounts } from '../accounts.js';
import { presentName } from '../profile.js';
import { linkContact, searchPeople } from '../contactsApi.js';
import ShieldMark from './ShieldMark.jsx';
import { mergeGroupRows, unreadBadge } from '../groupRows.js';

export default function Sidebar({ onPair, onSounds, onNotifications, onAccountSettings, onSelectChat, onOpenAuth, onLogout, onAccounts, onGroups, groups = [], onOpenGroup }) {
  const [query, setQuery] = useState('');
  const [accountMenu, setAccountMenu] = useState(false);
  const [filter, setFilter] = useState('All');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [addingId, setAddingId] = useState('');
  const user = useChatStore((state) => state.user);
  const { accounts } = useAccounts();
  const userId = useChatStore((state) => state.userId);
  const sessionToken = useChatStore((state) => state.sessionToken);
  const chats = useChatStore((state) => state.chats);
  const pinnedChatIds = useChatStore((state) => state.pinnedChatIds ?? []);
  const mutedChatIds = useChatStore((state) => state.mutedChatIds ?? []);
  const presence = useChatStore((state) => state.presence);
  const activeChatId = useChatStore((state) => state.activeChatId);
  const setActiveChat = useChatStore((state) => state.setActiveChat);
  const addContact = useChatStore((state) => state.addContact);
  const normalizedQuery = query.trim().replace(/^@+/, '');
  const filtered = useMemo(() => {
    const list = chats
      .filter((chat) => chat.id !== userId)
      .filter((chat) => `${chat.name} ${chat.preview}`.toLowerCase().includes(query.toLowerCase()))
      .filter((chat) => filter !== 'Unread' || chat.unread > 0);
    return list.sort((a, b) => {
      const aPinned = pinnedChatIds.includes(a.id) ? 1 : 0;
      const bPinned = pinnedChatIds.includes(b.id) ? 1 : 0;
      return bPinned - aPinned;
    });
  }, [chats, filter, query, userId, pinnedChatIds]);
  const rows = useMemo(() => {
    const term = query.toLowerCase();
    const matching = groups.filter((group) => `${group.name} ${group.preview}`.toLowerCase().includes(term))
      .filter((group) => filter !== 'Unread' || group.unread > 0);
    return mergeGroupRows(filtered, matching, { leadingIds: pinnedChatIds });
  }, [filtered, groups, query, filter, pinnedChatIds]);

  useEffect(() => {
    if (!sessionToken || normalizedQuery.length === 0) {
      setSearchResults([]);
      setSearching(false);
      setSearchError('');
      return undefined;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearching(true);
      setSearchError('');
      try {
        setSearchResults(await searchPeople(sessionToken, normalizedQuery, { signal: controller.signal }));
      } catch (error) {
        if (error.name !== 'AbortError') setSearchError(error.message);
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, 220);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [normalizedQuery, sessionToken]);

  // Desktop people search: "Chat" opens a direct thread without saving the person as a contact.
  async function openContact(contact) {
    setAddingId(contact.id);
    setSearchError('');
    try {
      await addContact(await linkContact(sessionToken, contact.id, { save: false }));
      setQuery('');
      onSelectChat?.();
    } catch (error) {
      setSearchError(error.message);
    } finally {
      setAddingId('');
    }
  }

  return (
    <aside className="sidebar">
      <header className="sidebar-top">
        <ShieldMark className="brand-mark" />
        <div className="brand-copy"><strong>Hidden Messenger</strong><span>No Email. No Number. Only Privacy.</span></div>
        <div className="top-actions">
          <button className="icon-button" title="Pair a device" onClick={onPair}><Settings2 size={18} /></button>
          <button className="icon-button" title="Notification sounds" onClick={onSounds}><Volume2 size={18} /></button>
          <button className="icon-button" title="Notifications" onClick={onNotifications}><Bell size={18} /></button>
          <button className="icon-button" title="More options"><MoreHorizontal size={20} /></button>
        </div>
      </header>

      <div className="account-wrap">
        <div className="account-card-row">
          {user ? <ProfilePhoto size="small" className="account-photo" /> : <Avatar initials="?" color="blue" size="small" />}
          <button className="account-card" onClick={() => setAccountMenu(!accountMenu)} aria-expanded={accountMenu}>
            <span className="account-copy"><strong>{user ? presentName(user) : 'Connecting...'}</strong><small>{user?.username ? `@${user.username}` : 'Personal workspace'}</small></span>
            <ChevronDown size={16} className={accountMenu ? 'rotated' : ''} />
          </button>
        </div>
        {accountMenu && <div className="account-menu">
          <span className="menu-caption">SIGNED IN AS @{user?.username ?? userId}</span>
          <span className="account-id">ID · {userId}</span>
          <button className="account-option" onClick={() => { setAccountMenu(false); onAccountSettings?.(); }}><Settings2 size={16} />Account &amp; privacy</button>
          <button className="account-option" onClick={() => { setAccountMenu(false); onAccounts?.(); }}><Users size={16} />Switch account{accounts.length > 1 ? ` (${accounts.length})` : ''}</button>
          <button className="account-option add-account-option" onClick={() => { setAccountMenu(false); onOpenAuth?.(); }}><AtSign size={16} />Add another account</button>
          <button className="account-option logout-option" onClick={() => { setAccountMenu(false); onLogout?.(); }}><LogOut size={16} />Log out</button>
        </div>}
      </div>

      <div className="search-box"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search chats or @handle" aria-label="Search chats and Hidden Messenger handles" /><kbd>⌘ K</kbd></div>
      <div className="list-toolbar">
        <button type="button" className="icon-button" onClick={onGroups} disabled={!sessionToken} title="Groups" aria-label="Groups"><Users size={18} /></button>
        <div className="filter-tabs" role="tablist" aria-label="Conversation filter">
          {['All', 'Unread'].map((tab) => <button key={tab} role="tab" aria-selected={filter === tab} className={filter === tab ? 'selected' : ''} onClick={() => setFilter(tab)}>{tab}</button>)}
        </div>
        <button className="icon-button small-icon" title="New chat" onClick={() => setFilter('All')}><MessageSquarePlus size={17} /></button>
      </div>
      <div className="chat-list">
        {normalizedQuery && <>
          <div className="list-section-label"><span>PEOPLE</span><span className="section-line" /></div>
          {searchResults.map((contact) => {
            const isContact = chats.some((chat) => chat.id === contact.id);
            return <button key={contact.id} className="discovery-row" onClick={() => openContact(contact)} disabled={addingId === contact.id}>
              <Avatar {...contact} size="small" online={presence[contact.id] === 'online'} />
              <span className="discovery-copy"><strong>{contact.name}</strong><small>@{contact.username}</small></span>
              <span className="discovery-action">{addingId === contact.id ? 'Opening…' : isContact ? 'Open' : <><UserRoundPlus size={14} />Add</>}</span>
            </button>;
          })}
          {searching && <p className="search-hint">Searching Hidden Messenger…</p>}
          {!searching && searchResults.length === 0 && !searchError && <p className="search-hint">No handles found for “@{normalizedQuery}”.</p>}
          {searchError && <p className="search-error">{searchError}</p>}
        </>}
        <div className="list-section-label"><span>{normalizedQuery ? 'CHATS' : 'PINNED'}</span><span className="section-line" /></div>
        {rows.map((chat) => chat.kind === 'group' ? (
          <button key={`group-${chat.id}`} className="chat-row" onClick={() => onOpenGroup?.(chat.id)} aria-label={`Open group ${chat.name}${chat.unread > 0 ? `, ${chat.unread} unread` : ''}`}>
            <span className="wa-group-avatar" aria-hidden="true"><Users size={22} /></span>
            <span className="chat-row-main">
              <span className="chat-row-heading"><strong>{chat.name}</strong><time>{chat.time}</time></span>
              <span className="chat-preview">{chat.preview}</span>
              <span className="chat-row-meta">
                <span className="row-meta-left"><span className="group-meta"><Users size={12} />Group</span></span>
                {chat.unread > 0 && <span className={`unread-badge ${chat.muted ? 'is-muted' : ''}`}>{unreadBadge(chat.unread)}</span>}
              </span>
            </span>
          </button>
        ) : (
          <button key={chat.id} className={`chat-row ${activeChatId === chat.id ? 'active' : ''}`} onClick={() => { setActiveChat(chat.id); onSelectChat?.(); }}>
            <Avatar {...chat} online={presence[chat.id] === 'online'} />
            <span className="chat-row-main">
              <span className="chat-row-heading"><strong>{chat.name}</strong><time>{chat.time}</time></span>
              <span className="chat-preview">{chat.preview}</span>
              <span className="chat-row-meta">
                <span className="row-meta-left">
                  {chat.group && <span className="group-meta"><Users size={12} />{chat.members}</span>}
                  {mutedChatIds.includes(chat.id) && <VolumeX size={13} className="meta-icon" title="Muted" />}
                  {pinnedChatIds.includes(chat.id) && <Pin size={13} className="meta-icon" title="Pinned" />}
                </span>
                {chat.unread > 0 && <span className="unread-badge">{chat.unread}</span>}
              </span>
            </span>
          </button>
        ))}
        {rows.length === 0 && <p className="empty-search">No conversations found.</p>}
      </div>
      <footer className="sidebar-footer"><Archive size={15} /><span>Archived</span><span className="footer-spacer" /> <span className="footer-status"><i /> All caught up</span></footer>
    </aside>
  );
}
