import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, BellOff, Camera, Check, Heart, MessageSquarePlus, MoreVertical, Phone, Pin, Plus, Search, Trash2, Users, Video, Volume2, VolumeX, X } from 'lucide-react';
import { useChatStore } from '../store.js';
import { deleteChatOnServer } from '../chatApi.js';
import { linkContact, searchPeople } from '../contactsApi.js';
import { createLongPress } from '../longPress.js';
import { chatRowActions, deleteChatPrompt, deleteOutcome } from '../chatListActions.js';
import { orderChats } from '../chatOrder.js';
import { uploadFile } from '../upload.js';
import Avatar from './Avatar.jsx';
import SelectContactModal from './SelectContactModal.jsx';
import ShieldMark from './ShieldMark.jsx';
import { countUnreadConversations, mergeGroupRows, unreadBadge } from '../groupRows.js';

function GroupListRow({ row, onOpen }) {
  return (
    <div className="wa-row-wrapper">
      <button type="button" className="wa-row" onClick={() => onOpen?.(row.id)} aria-label={`Open group ${row.name}${row.unread > 0 ? `, ${row.unread} unread` : ''}`}>
        <div className="wa-row-avatar-wrap"><span className="wa-group-avatar" aria-hidden="true"><Users size={24} /></span></div>
        <span className="wa-row-body">
          <span className="wa-row-top">
            <strong>{row.name}</strong>
            <time className={row.unread > 0 ? 'unread' : ''}>{row.time}</time>
          </span>
          <span className="wa-row-bottom">
            <span className="wa-preview">{row.preview}</span>
            <span className="wa-row-indicators">{row.unread > 0 && <span className={`wa-badge ${row.muted ? 'is-muted' : ''}`}>{unreadBadge(row.unread)}</span>}</span>
          </span>
        </span>
      </button>
    </div>
  );
}

export default function ChatsList({ onOpenChat, onStartCall, onGroups, groups = [], onOpenGroup }) {
  const rawChats = useChatStore((state) => state.chats);
  const presence = useChatStore((state) => state.presence);
  const sessionToken = useChatStore((state) => state.sessionToken);
  const userId = useChatStore((state) => state.userId);
  const addContact = useChatStore((state) => state.addContact);
  const pinnedChatIds = useChatStore((state) => state.pinnedChatIds ?? []);
  const mutedChatIds = useChatStore((state) => state.mutedChatIds ?? []);
  const favouriteChatIds = useChatStore((state) => state.favouriteChatIds ?? []);
  const togglePinChat = useChatStore((state) => state.togglePinChat);
  const toggleMuteChat = useChatStore((state) => state.toggleMuteChat);
  const toggleFavouriteChat = useChatStore((state) => state.toggleFavouriteChat);
  const deleteChat = useChatStore((state) => state.deleteChat);

  const [selectedChatIds, setSelectedChatIds] = useState([]);
  const [contactModalOpen, setContactModalOpen] = useState(false);
  // Long-press/right-click target and the delete confirmation (one chat or the current selection).
  const [actionChat, setActionChat] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  // Home camera shortcut: a captured photo waits here until a chat is chosen for it.
  const [capturedPhoto, setCapturedPhoto] = useState(null);
  const [cameraError, setCameraError] = useState('');
  const cameraInputRef = useRef(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchError, setSearchError] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [addingId, setAddingId] = useState('');
  const [filterTab, setFilterTab] = useState('all');
  const [menuOpen, setMenuOpen] = useState(false);
  const searchRef = useRef(null);

  const isSelectionMode = selectedChatIds.length > 0;

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const chats = useMemo(
    () => (Array.isArray(rawChats) ? rawChats : []).filter((chat) => chat?.id && chat.id !== userId),
    [rawChats, userId],
  );

  useEffect(() => {
    if (!normalizedQuery) {
      setSearchResults([]);
      setSearchError('');
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setIsSearching(true);
      setSearchError('');
      try {
        setSearchResults(await searchPeople(sessionToken, normalizedQuery, { signal: controller.signal }));
      } catch (error) {
        if (error.name !== 'AbortError') setSearchError(error.message || 'Search failed');
      } finally {
        if (!controller.signal.aborted) setIsSearching(false);
      }
    }, 220);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [normalizedQuery, sessionToken]);

  // "Chat" from the people search opens a direct thread without adding the person to the contact book.
  async function handleAddContact(contact) {
    setAddingId(contact.id);
    setSearchError('');
    try {
      const result = await linkContact(sessionToken, contact.id, { save: false });
      await addContact(result);
      setSearchQuery('');
      onOpenChat?.(result);
    } catch (error) {
      setSearchError(error.message);
    } finally {
      setAddingId('');
    }
  }

  function handleRowClick(chat) {
    if (longPress.consumeFired()) return;
    if (isSelectionMode) {
      setSelectedChatIds((prev) =>
        prev.includes(chat.id) ? prev.filter((id) => id !== chat.id) : [...prev, chat.id]
      );
    } else {
      onOpenChat?.(chat);
    }
  }

  // Long-press (touch/pen/mouse) or right-click on a row opens its action sheet; in selection mode it selects.
  const pressTargetRef = useRef(null);
  const selectedChatIdsRef = useRef(selectedChatIds);
  selectedChatIdsRef.current = selectedChatIds;
  const [longPress] = useState(() => createLongPress(() => {
    const chat = pressTargetRef.current;
    if (!chat) return;
    navigator.vibrate?.(10);
    if (selectedChatIdsRef.current.length) setSelectedChatIds((prev) => prev.includes(chat.id) ? prev : [...prev, chat.id]);
    else setActionChat(chat);
  }));
  useEffect(() => () => longPress.cancel(), [longPress]);

  function rowPressHandlers(chat) {
    return {
      onPointerDown: (event) => { pressTargetRef.current = chat; longPress.onPointerDown(event); },
      onPointerMove: longPress.onPointerMove,
      onPointerUp: longPress.onPointerUp,
      onPointerCancel: longPress.onPointerCancel,
      onPointerLeave: longPress.onPointerLeave,
      onContextMenu: (event) => { pressTargetRef.current = chat; longPress.onContextMenu(event); },
    };
  }

  function runChatAction(actionId, chat) {
    setActionChat(null);
    if (actionId === 'open') onOpenChat?.(chat);
    else if (actionId === 'pin') togglePinChat(chat.id);
    else if (actionId === 'mute') toggleMuteChat(chat.id);
    else if (actionId === 'favourite') toggleFavouriteChat(chat.id);
    else if (actionId === 'select') setSelectedChatIds([chat.id]);
    else if (actionId === 'delete') setPendingDelete([chat]);
  }

  async function confirmDelete() {
    const targets = pendingDelete ?? [];
    setPendingDelete(null);
    setDeleting(true);
    clearSelection();
    const results = await Promise.allSettled(targets.map((chat) => deleteChatOnServer(sessionToken, chat.id)));
    results.forEach((result, index) => { if (result.status === 'fulfilled') deleteChat(targets[index].id, { kept: result.value?.kept }); });
    setDeleting(false);
    setDeleteError(deleteOutcome(results));
  }

  function clearSelection() {
    setSelectedChatIds([]);
    setMenuOpen(false);
  }

  function handleBatchPin() {
    const allPinned = selectedChatIds.every((id) => pinnedChatIds.includes(id));
    for (const id of selectedChatIds) {
      if (allPinned) {
        if (pinnedChatIds.includes(id)) togglePinChat(id);
      } else {
        if (!pinnedChatIds.includes(id)) togglePinChat(id);
      }
    }
    clearSelection();
  }

  function handleBatchMute() {
    const allMuted = selectedChatIds.every((id) => mutedChatIds.includes(id));
    for (const id of selectedChatIds) {
      if (allMuted) {
        if (mutedChatIds.includes(id)) toggleMuteChat(id);
      } else {
        if (!mutedChatIds.includes(id)) toggleMuteChat(id);
      }
    }
    clearSelection();
  }

  async function sendCapturedPhoto(contact, file) {
    try {
      const data = await uploadFile(file, { receiverId: contact.id, sessionToken });
      useChatStore.getState().sendMessage(contact.id, `media:${data.id}:${data.filename || file.name || 'photo.jpg'}`);
    } catch (caught) {
      setCameraError(caught?.message || 'Could not send the photo.');
    }
  }

  function handleBatchDelete() {
    setPendingDelete(selectedChatIds.map((id) => chats.find((chat) => chat.id === id)).filter(Boolean));
  }

  const allSelectedPinned = selectedChatIds.length > 0 && selectedChatIds.every((id) => pinnedChatIds.includes(id));
  const allSelectedMuted = selectedChatIds.length > 0 && selectedChatIds.every((id) => mutedChatIds.includes(id));

  // Pinned first, then favourites, then the rest; recency order is kept within each band.
  const sortedChats = useMemo(() => orderChats(chats, { pinnedChatIds, favouriteChatIds }), [chats, pinnedChatIds, favouriteChatIds]);

  const visibleChats = normalizedQuery
    ? sortedChats.filter((chat) => `${chat.name ?? ''} ${chat.username ?? ''}`.toLowerCase().includes(normalizedQuery))
    : filterTab === 'unread' ? sortedChats.filter((chat) => chat.unread > 0)
      : filterTab === 'favourites' ? sortedChats.filter((chat) => favouriteChatIds.includes(chat.id)) : sortedChats;
  // Groups sit in the same list as direct chats (after pinned/favourite chats, by recency); they are not favouritable.
  const visibleGroups = isSelectionMode || filterTab === 'favourites' ? []
    : normalizedQuery ? groups.filter((group) => group.name.toLowerCase().includes(normalizedQuery))
      : filterTab === 'unread' ? groups.filter((group) => group.unread > 0) : groups;
  const visibleRows = mergeGroupRows(visibleChats, visibleGroups, { leadingIds: [...pinnedChatIds, ...favouriteChatIds] });
  const newResults = searchResults.filter((contact) => contact?.id && !chats.some((chat) => chat.id === contact.id));
  const totalUnread = countUnreadConversations(chats, groups);

  return (
    <section className="wa-list">
      {isSelectionMode ? (
        <header className="wa-selection-header">
          <div className="wa-sel-left">
            <button type="button" className="wa-sel-btn" onClick={clearSelection} aria-label="Cancel selection">
              <ArrowLeft size={20} />
            </button>
            <span className="wa-sel-count">{selectedChatIds.length}</span>
          </div>
          <div className="wa-sel-actions">
            <button
              type="button"
              className="wa-sel-btn"
              onClick={handleBatchPin}
              title={allSelectedPinned ? 'Unpin' : 'Pin'}
              aria-label={allSelectedPinned ? 'Unpin' : 'Pin'}
            >
              <Pin size={20} className={allSelectedPinned ? 'active-icon' : ''} />
            </button>
            <button
              type="button"
              className="wa-sel-btn"
              onClick={handleBatchMute}
              title={allSelectedMuted ? 'Unmute' : 'Mute'}
              aria-label={allSelectedMuted ? 'Unmute' : 'Mute'}
            >
              {allSelectedMuted ? <Volume2 size={20} /> : <VolumeX size={20} />}
            </button>
            <button
              type="button"
              className="wa-sel-btn"
              onClick={handleBatchDelete}
              title="Delete chat"
              aria-label="Delete chat"
            >
              <Trash2 size={20} />
            </button>
            <div className="wa-sel-menu-wrap">
              <button
                type="button"
                className="wa-sel-btn"
                onClick={() => setMenuOpen((o) => !o)}
                aria-label="More options"
              >
                <MoreVertical size={20} />
              </button>
              {menuOpen && (
                <div className="wa-sel-dropdown">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedChatIds(visibleChats.map((c) => c.id));
                      setMenuOpen(false);
                    }}
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      clearSelection();
                    }}
                  >
                    Deselect all
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>
      ) : (
        <header className="wa-list-header">
          <div className="wa-list-brand"><ShieldMark className="wa-list-brand-mark" /><h1>Hidden Messenger</h1></div>
          <span className="wa-list-header-actions">
            <button type="button" className="wa-icon-btn" onClick={() => onGroups?.()} disabled={!sessionToken} aria-label="Groups"><Users size={20} /></button>
            <button type="button" className="wa-icon-btn" onClick={() => { setCameraError(''); cameraInputRef.current?.click(); }} aria-label="Camera" title="Take a photo and send it"><Camera size={20} /></button>
            <button type="button" className="wa-icon-btn" onClick={() => searchRef.current?.focus()} aria-label="Search"><Search size={20} /></button>
          </span>
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={(event) => {
              const [file] = event.target.files ?? [];
              event.target.value = '';
              if (file) { setCapturedPhoto(file); setContactModalOpen(true); }
            }}
          />
        </header>
      )}

      {!isSelectionMode && (
        <div className="wa-search">
          <Search size={16} />
          <input
            ref={searchRef}
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search or start new chat"
            aria-label="Search chats or find people"
          />
          {searchQuery && <button type="button" className="wa-icon-btn" onClick={() => setSearchQuery('')} aria-label="Clear search"><X size={16} /></button>}
        </div>
      )}

      {!isSelectionMode && !normalizedQuery && (
        <div className="wa-chips" role="tablist">
          <button type="button" role="tab" aria-selected={filterTab === 'all'} className={filterTab === 'all' ? 'active' : ''} onClick={() => setFilterTab('all')}>All</button>
          <button type="button" role="tab" aria-selected={filterTab === 'unread'} className={filterTab === 'unread' ? 'active' : ''} onClick={() => setFilterTab('unread')}>
            Unread{totalUnread > 0 ? ` ${totalUnread}` : ''}
          </button>
          <button type="button" role="tab" aria-selected={filterTab === 'favourites'} className={filterTab === 'favourites' ? 'active' : ''} onClick={() => setFilterTab('favourites')}>Favourites</button>
        </div>
      )}

      <div className="wa-rows">
        {visibleRows.map((chat) => {
          if (chat.kind === 'group') return <GroupListRow key={`group-${chat.id}`} row={chat} onOpen={onOpenGroup} />;
          const online = presence?.[chat.id] === 'online';
          const isSelected = selectedChatIds.includes(chat.id);
          const isPinned = pinnedChatIds.includes(chat.id);
          const isMuted = mutedChatIds.includes(chat.id);

          return (
            <div
              key={chat.id}
              className={`wa-row-wrapper ${isSelected ? 'selected' : ''}`}
              {...rowPressHandlers(chat)}
            >
              <button
                type="button"
                className="wa-row"
                onClick={() => handleRowClick(chat)}
              >
                <div className="wa-row-avatar-wrap">
                  <Avatar name={chat.name} initials={chat.initials ?? chat.name?.slice(0, 2)?.toUpperCase() ?? '?'} color={chat.color} image={chat.avatar} online={online} />
                  {isSelected && (
                    <div className="wa-row-check-badge">
                      <Check size={14} strokeWidth={3} />
                    </div>
                  )}
                </div>
                <span className="wa-row-body">
                  <span className="wa-row-top">
                    <strong>{chat.name ?? 'Unknown contact'}</strong>
                    <time className={chat.unread > 0 ? 'unread' : ''}>{chat.time ?? ''}</time>
                  </span>
                  <span className="wa-row-bottom">
                    <span className="wa-preview">{chat.preview || 'No messages yet'}</span>
                    <span className="wa-row-indicators">
                      {isMuted && <VolumeX size={15} className="wa-row-badge-icon" title="Muted" />}
                      {isPinned && <Pin size={15} className="wa-row-badge-icon" title="Pinned" />}
                      {favouriteChatIds.includes(chat.id) && <Heart size={15} className="wa-row-badge-icon is-favourite" fill="currentColor" title="Favourite" />}
                      {chat.unread > 0 && <span className="wa-badge">{chat.unread}</span>}
                    </span>
                  </span>
                </span>
              </button>
              {!isSelectionMode && onStartCall && (
                <div className="wa-row-actions">
                  <button
                    type="button"
                    className="wa-row-call-icon"
                    title={`Voice call ${chat.name}`}
                    aria-label={`Voice call ${chat.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onStartCall(chat.id, 'audio');
                    }}
                  >
                    <Phone size={16} />
                  </button>
                  <button
                    type="button"
                    className="wa-row-call-icon"
                    title={`Video call ${chat.name}`}
                    aria-label={`Video call ${chat.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onStartCall(chat.id, 'video');
                    }}
                  >
                    <Video size={16} />
                  </button>
                </div>
              )}
            </div>
          );
        })}

        {normalizedQuery && (
          <>
            <div className="wa-section-label">Find people on Hidden Messenger</div>
            {isSearching && <div className="wa-note">Searching…</div>}
            {searchError && <div className="wa-note error">{searchError}</div>}
            {!isSearching && !searchError && newResults.length === 0 && visibleRows.length === 0 && <div className="wa-note">No people found</div>}
            {newResults.map((contact) => (
              <div key={contact.id} className="wa-row static">
                <Avatar name={contact.name} initials={contact.initials ?? contact.name?.slice(0, 2)?.toUpperCase() ?? '?'} color={contact.color} image={contact.avatar} />
                <span className="wa-row-body">
                  <span className="wa-row-top"><strong>{contact.name ?? contact.username}</strong></span>
                  <span className="wa-row-bottom"><span className="wa-preview">@{contact.username ?? contact.handle}</span></span>
                </span>
                <button type="button" className="wa-add" disabled={addingId === contact.id} onClick={() => handleAddContact(contact)}>
                  {addingId === contact.id ? 'Adding…' : 'Chat'}
                </button>
              </div>
            ))}
          </>
        )}

        {!normalizedQuery && visibleRows.length === 0 && (
          <div className="wa-empty">
            <MessageSquarePlus size={40} />
            <h3>{filterTab === 'unread' ? 'No unread chats' : 'No chats yet'}</h3>
            <p>Tap the green plus button to find people and start chatting.</p>
          </div>
        )}
      </div>

      <button
        type="button"
        className="wa-fab"
        onClick={() => setContactModalOpen(true)}
        aria-label="New chat"
        title="New chat"
      >
        <Plus size={28} strokeWidth={2.4} />
      </button>

      <SelectContactModal
        isOpen={contactModalOpen}
        onNewGroup={() => onGroups?.(true)}
        onClose={() => { setContactModalOpen(false); setCapturedPhoto(null); }}
        onSelectContact={(contact) => {
          if (capturedPhoto) sendCapturedPhoto(contact, capturedPhoto);
          setCapturedPhoto(null);
          onOpenChat?.(contact);
        }}
      />
      {cameraError && <p className="attachment-error wa-camera-error" role="alert">{cameraError}</p>}
      {deleteError && (
        <div className="wa-list-toast" role="alert">
          <span>{deleteError}</span>
          <button type="button" onClick={() => setDeleteError('')} aria-label="Dismiss"><X size={14} /></button>
        </div>
      )}
      {deleting && <div className="wa-list-toast" role="status">Deleting…</div>}

      {actionChat && (
        <div className="wa-sheet-backdrop" onClick={() => setActionChat(null)} role="presentation">
          <div className="wa-action-sheet" role="menu" aria-label={`Actions for ${actionChat.name ?? actionChat.username}`} onClick={(event) => event.stopPropagation()}>
            <header className="wa-action-sheet-head">
              <Avatar name={actionChat.name} initials={actionChat.initials ?? actionChat.name?.slice(0, 2)?.toUpperCase() ?? '?'} color={actionChat.color} image={actionChat.avatar} size="small" />
              <span>
                <strong>{actionChat.name ?? actionChat.username}</strong>
                {actionChat.username && <small>@{actionChat.username}{actionChat.saved ? '' : ' · Not in contacts'}</small>}
              </span>
            </header>
            {chatRowActions(actionChat, {
              pinned: pinnedChatIds.includes(actionChat.id),
              muted: mutedChatIds.includes(actionChat.id),
              favourite: favouriteChatIds.includes(actionChat.id),
            }).map((action) => (
              <button type="button" key={action.id} role="menuitem" className={action.danger ? 'danger' : ''} onClick={() => runChatAction(action.id, actionChat)}>
                {action.id === 'pin' && <Pin size={18} />}
                {action.id === 'mute' && (mutedChatIds.includes(actionChat.id) ? <Volume2 size={18} /> : <BellOff size={18} />)}
                {action.id === 'favourite' && <Heart size={18} fill={favouriteChatIds.includes(actionChat.id) ? 'currentColor' : 'none'} />}
                {action.id === 'select' && <Check size={18} />}
                {action.id === 'delete' && <Trash2 size={18} />}
                {action.id === 'open' && <MessageSquarePlus size={18} />}
                <span>{action.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {pendingDelete && (() => {
        const prompt = deleteChatPrompt(pendingDelete);
        return (
          <div className="wa-sheet-backdrop" onClick={() => setPendingDelete(null)} role="presentation">
            <div className="wa-info-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-chat-title" onClick={(event) => event.stopPropagation()}>
              <h3 id="delete-chat-title">{prompt.title}</h3>
              <div className="wa-info-dialog-body"><p>{prompt.body}</p></div>
              <div className="wa-info-dialog-actions">
                <button type="button" onClick={() => setPendingDelete(null)}>Cancel</button>
                <button type="button" className="wa-info-dialog-confirm danger" onClick={confirmDelete}>{prompt.confirm}</button>
              </div>
            </div>
          </div>
        );
      })()}
    </section>
  );
}
