import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArchiveRestore, ArrowLeft, BellOff, Camera, Check, Heart, Lock, MessageSquarePlus, Mic, MoreVertical, Phone, Pin, Plus, Search, Tag, Trash2, Users, Video, Volume2, VolumeX, X } from 'lucide-react';
import { setChatArchived, toggleChatLabel, useAccountData } from '../accountData.js';
import { chatLockMethod, unlockLockedChats } from '../chatLock.js';
import { useT } from '../i18n.js';
import { labelColor } from '../labels.js';
import { useChatStore } from '../store.js';
import { deleteChatOnServer } from '../chatApi.js';
import { linkContact, searchPeople } from '../contactsApi.js';
import { createLongPress } from '../longPress.js';
import { chatRowActions, deleteChatPrompt, deleteOutcome, rowChatKey } from '../chatListActions.js';
import { orderChats } from '../chatOrder.js';
import { uploadFile } from '../upload.js';
import { attachmentContent, sealForUpload } from '../mediaCrypto.js';
import Avatar from './Avatar.jsx';
import SelectContactModal from './SelectContactModal.jsx';
import ShieldMark from './ShieldMark.jsx';
import FormattedText from './FormattedText.jsx';
import MessageSearch, { SearchFilterChips } from './MessageSearch.jsx';
import { ListEditor, ListPicker, listEntries } from './ChatLists.jsx';
import { countUnreadConversations, mergeGroupRows, unreadBadge } from '../groupRows.js';
import VerifiedBadge from './VerifiedBadge.jsx';
import { activityLabel, groupActivityLabel, groupActivityPeople } from '../typing.js';
import { statusRingProps } from './StatusRing.jsx';

function GroupListRow({ row, onOpen, pressHandlers, labels = [], consumeLongPress = () => false }) {
  // "Ava is typing…" in green while someone in the group is (named as saved in this phone's chats when they are).
  const busy = useChatStore((state) => state.groupTyping[row.id]);
  const chats = useChatStore((state) => state.chats);
  const activity = busy ? groupActivityLabel(groupActivityPeople(busy, (id) => chats.find((chat) => chat.id === id && !chat.deleted)?.name)) : '';
  return (
    <div className="wa-row-wrapper" {...pressHandlers}>
      <button type="button" className="wa-row" onClick={() => { if (!consumeLongPress()) onOpen?.(row.id); }} aria-label={`Open group ${row.name}${row.unread > 0 ? `, ${row.unread} unread` : ''}`}>
        <div className="wa-row-avatar-wrap"><span className="wa-group-avatar" aria-hidden="true"><Users size={24} /></span></div>
        <span className="wa-row-body">
          <span className="wa-row-top">
            <strong>{row.name}</strong>
            <time className={row.unread > 0 ? 'unread' : ''}>{row.time}</time>
          </span>
          <span className="wa-row-bottom">
            {activity
              ? <span className="wa-preview is-activity">{activity}</span>
              : <span className="wa-preview"><FormattedText text={row.preview} inline /></span>}
            <span className="wa-row-indicators">
              {labels.map((label) => <Tag key={label.id} size={14} className="wa-row-badge-icon" style={{ color: labelColor(label.color) }} aria-label={`Label ${label.name}`} />)}
              {row.unread > 0 && <span className={`wa-badge ${row.muted ? 'is-muted' : ''}`}>{unreadBadge(row.unread)}</span>}
            </span>
          </span>
        </span>
      </button>
    </div>
  );
}

export default function ChatsList({ onOpenChat, onStartCall, onGroups, groups = [], onOpenGroup, onSettings, onSheet }) {
  const [headerMenu, setHeaderMenu] = useState(false);
  const rawChats = useChatStore((state) => state.chats);
  const presence = useChatStore((state) => state.presence);
  const typing = useChatStore((state) => state.typing);
  const statusRings = useChatStore((state) => state.statusRings);
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
  // Archived chats and labels follow the account (server/parity.mjs).
  const archivedKeys = useAccountData((state) => state.archived);
  const labels = useAccountData((state) => state.labels);
  const [showArchived, setShowArchived] = useState(false);
  // Locked chats (src/chatLock.js): hidden from the list and search until the folder is unlocked.
  const lockedKeys = useChatStore((state) => state.lockedChatIds ?? []);
  const toggleLockedChat = useChatStore((state) => state.toggleLockedChat);
  const lockedSet = useMemo(() => new Set(lockedKeys), [lockedKeys]);
  const [showLocked, setShowLocked] = useState(false);
  const t = useT();
  const [lockPrompt, setLockPrompt] = useState(null);
  const [labelTarget, setLabelTarget] = useState(null);
  const [listNotice, setListNotice] = useState('');
  const archivedSet = useMemo(() => new Set(archivedKeys), [archivedKeys]);
  const labelsFor = (row) => labels.filter((label) => label.chatKeys.includes(rowChatKey(row)));

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
  const chatLists = useChatStore((state) => state.chatLists);
  const [listTarget, setListTarget] = useState(null);
  const [listEditor, setListEditor] = useState(null);
  // Search across chats: kind filters show while the search box is in use (MessageSearch.jsx).
  const [searchFilter, setSearchFilter] = useState('');
  const [searchFocus, setSearchFocus] = useState(false);
  const searching = Boolean(searchFocus || searchQuery.trim() || searchFilter);
  const [searchResults, setSearchResults] = useState([]);
  const [searchError, setSearchError] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [addingId, setAddingId] = useState('');
  const [filterTab, setFilterTab] = useState('all');
  const [menuOpen, setMenuOpen] = useState(false);
  const searchRef = useRef(null);

  const isSelectionMode = selectedChatIds.length > 0;
  useEffect(() => {
    if (filterTab.startsWith('label:') && !labels.some((label) => `label:${label.id}` === filterTab)) setFilterTab('all');
    if (filterTab.startsWith('list:') && !chatLists?.[filterTab.slice(5)]) setFilterTab('all');
  }, [filterTab, labels, chatLists]);

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
    if (actionId === 'open') { if (chat.kind === 'group') onOpenGroup?.(chat.id); else onOpenChat?.(chat); }
    else if (actionId === 'pin') togglePinChat(chat.id);
    else if (actionId === 'mute') toggleMuteChat(chat.id);
    else if (actionId === 'favourite') toggleFavouriteChat(chat.id);
    else if (actionId === 'select') setSelectedChatIds([chat.id]);
    else if (actionId === 'archive') archiveRows([chat], !archivedSet.has(rowChatKey(chat)));
    else if (actionId === 'lock') lockRow(chat);
    else if (actionId === 'label') setLabelTarget(chat);
    else if (actionId === 'list') setListTarget({ key: chat.kind === 'group' ? `group:${chat.id}` : chat.id, name: chat.name });
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

  // Locking needs a way to unlock first (the phone's screen lock in the app, or an app passcode in a browser).
  async function lockRow(chat) {
    const key = rowChatKey(chat);
    if (!lockedSet.has(key) && !(await chatLockMethod())) {
      setListNotice('Set an app passcode in Settings › Security first, so locked chats can be opened.');
      return;
    }
    toggleLockedChat(key);
    setListNotice(lockedSet.has(key) ? 'Chat unlocked' : 'Chat locked');
  }

  async function openLockedFolder() {
    const method = await chatLockMethod();
    if (method === 'biometric') {
      if (await unlockLockedChats({ method })) { setShowLocked(true); setShowArchived(false); }
      return;
    }
    if (method === 'passcode') setLockPrompt({ passcode: '', error: '' });
    else setListNotice('Set an app passcode in Settings › Security to open locked chats.');
  }

  // Archiving hides a chat from the list into "Archived"; new messages keep it there (WhatsApp's default).
  function archiveRows(rows, archived) {
    Promise.all(rows.map((row) => setChatArchived(rowChatKey(row), archived)))
      .then(() => setListNotice(archived ? (rows.length === 1 ? 'Chat archived' : `${rows.length} chats archived`) : (rows.length === 1 ? 'Chat unarchived' : `${rows.length} chats unarchived`)))
      .catch((error) => setDeleteError(error.message));
  }
  useEffect(() => {
    if (!listNotice) return undefined;
    const timer = setTimeout(() => setListNotice(''), 2500);
    return () => clearTimeout(timer);
  }, [listNotice]);

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
      const { upload, descriptor } = await sealForUpload(file);
      const data = await uploadFile(upload, { receiverId: contact.id, sessionToken });
      const name = descriptor ? file.name || 'photo.jpg' : data.filename || file.name || 'photo.jpg';
      useChatStore.getState().sendMessage(contact.id, attachmentContent(data.id, name, descriptor));
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

  const inFolder = (key) => (showLocked ? lockedSet.has(key) : !lockedSet.has(key) && (showArchived ? archivedSet.has(key) : !archivedSet.has(key)));
  const activeLabel = filterTab.startsWith('label:') ? labels.find((label) => label.id === filterTab.slice(6)) : null;
  const activeList = filterTab.startsWith('list:') ? chatLists?.[filterTab.slice(5)] : null;
  const labelled = (key) => (!activeLabel || activeLabel.chatKeys.includes(key)) && (!activeList || activeList.keys.includes(key));
  // Search never reveals a locked chat unless the locked folder is open.
  const searchable = (key) => (showLocked ? lockedSet.has(key) : !lockedSet.has(key));
  const folderChats = normalizedQuery ? sortedChats.filter((chat) => searchable(chat.id)) : sortedChats.filter((chat) => inFolder(chat.id) && labelled(chat.id));
  const folderGroups = normalizedQuery ? groups.filter((group) => searchable(`group:${group.id}`)) : groups.filter((group) => inFolder(`group:${group.id}`) && labelled(`group:${group.id}`));
  const lockedCount = lockedKeys.length;
  const archivedCount = sortedChats.filter((chat) => archivedSet.has(chat.id)).length + groups.filter((group) => archivedSet.has(`group:${group.id}`)).length;
  const archivedUnread = sortedChats.filter((chat) => archivedSet.has(chat.id) && chat.unread > 0).length + groups.filter((group) => archivedSet.has(`group:${group.id}`) && group.unread > 0).length;
  const visibleChats = normalizedQuery
    ? folderChats.filter((chat) => `${chat.name ?? ''} ${chat.username ?? ''}`.toLowerCase().includes(normalizedQuery))
    : filterTab === 'unread' ? folderChats.filter((chat) => chat.unread > 0)
      : filterTab === 'favourites' ? folderChats.filter((chat) => favouriteChatIds.includes(chat.id))
        : filterTab === 'groups' ? [] : folderChats;
  // Groups sit in the same list as direct chats (after pinned/favourite chats, by recency); they are not favouritable.
  const visibleGroups = isSelectionMode || filterTab === 'favourites' ? []
    : normalizedQuery ? folderGroups.filter((group) => group.name.toLowerCase().includes(normalizedQuery))
      : filterTab === 'unread' ? folderGroups.filter((group) => group.unread > 0) : folderGroups;
  const visibleRows = mergeGroupRows(visibleChats, visibleGroups, { leadingIds: [...pinnedChatIds, ...favouriteChatIds] });
  const newResults = searchResults.filter((contact) => contact?.id && !chats.some((chat) => chat.id === contact.id));
  const totalUnread = countUnreadConversations(chats.filter((chat) => !archivedSet.has(chat.id)), groups.filter((group) => !archivedSet.has(`group:${group.id}`)));

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
              onClick={() => { const rows = chats.filter((chat) => selectedChatIds.includes(chat.id)); archiveRows(rows, !showArchived); clearSelection(); }}
              title={showArchived ? 'Unarchive' : 'Archive'}
              aria-label={showArchived ? 'Unarchive' : 'Archive'}
            >
              {showArchived ? <ArchiveRestore size={20} /> : <Archive size={20} />}
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
          {showLocked ? (
            <div className="wa-list-brand">
              <button type="button" className="wa-icon-btn" onClick={() => setShowLocked(false)} aria-label="Back to chats"><ArrowLeft size={20} /></button>
              <h1>{t('Locked chats')}</h1>
            </div>
          ) : showArchived ? (
            <div className="wa-list-brand">
              <button type="button" className="wa-icon-btn" onClick={() => setShowArchived(false)} aria-label="Back to chats"><ArrowLeft size={20} /></button>
              <h1>{t('Archived')}</h1>
            </div>
          ) : <div className="wa-list-brand"><ShieldMark className="wa-list-brand-mark" /><h1>Hidden Messenger</h1></div>}
          <span className="wa-list-header-actions">
            <button type="button" className="wa-icon-btn" onClick={() => onGroups?.()} disabled={!sessionToken} aria-label="Groups"><Users size={20} /></button>
            <button type="button" className="wa-icon-btn" onClick={() => { setCameraError(''); cameraInputRef.current?.click(); }} aria-label="Camera" title="Take a photo and send it"><Camera size={20} /></button>
            <span className="wa-header-menu-wrap">
              <button type="button" className="wa-icon-btn" onClick={() => setHeaderMenu((open) => !open)} aria-label="Menu" aria-expanded={headerMenu}><MoreVertical size={20} /></button>
              {headerMenu && (
                <div className="wa-sel-dropdown wa-header-dropdown" role="menu" onClick={() => setHeaderMenu(false)}>
                  <button type="button" role="menuitem" onClick={() => onGroups?.(true)}>New group</button>
                  <button type="button" role="menuitem" onClick={() => onSheet?.('broadcasts')}>{t('Broadcast lists')}</button>
                  <button type="button" role="menuitem" onClick={() => onSheet?.('communities')}>{t('Communities')}</button>
                  <button type="button" role="menuitem" onClick={() => onSheet?.('lists')}>{t('Lists')}</button>
                  <button type="button" role="menuitem" onClick={() => onSheet?.('linked')}>{t('Linked devices')}</button>
                  <button type="button" role="menuitem" onClick={() => onSheet?.('starred')}>Starred messages</button>
                  <button type="button" role="menuitem" onClick={() => onSettings?.()}>Settings</button>
                </div>
              )}
            </span>
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
            onFocus={() => setSearchFocus(true)}
            onBlur={() => setTimeout(() => setSearchFocus(false), 150)}
            placeholder={t('Search or start new chat')}
            aria-label="Search chats or find people"
          />
          {(searchQuery || searchFilter) && <button type="button" className="wa-icon-btn" onClick={() => { setSearchQuery(''); setSearchFilter(''); }} aria-label="Clear search"><X size={16} /></button>}
        </div>
      )}
      {!isSelectionMode && searching && <SearchFilterChips filter={searchFilter} onChange={setSearchFilter} />}

      {!isSelectionMode && !normalizedQuery && !searching && (
        <div className="wa-chips" role="tablist">
          <button type="button" role="tab" aria-selected={filterTab === 'all'} className={filterTab === 'all' ? 'active' : ''} onClick={() => setFilterTab('all')}>All</button>
          <button type="button" role="tab" aria-selected={filterTab === 'unread'} className={filterTab === 'unread' ? 'active' : ''} onClick={() => setFilterTab('unread')}>
            Unread{totalUnread > 0 ? ` ${totalUnread}` : ''}
          </button>
          <button type="button" role="tab" aria-selected={filterTab === 'favourites'} className={filterTab === 'favourites' ? 'active' : ''} onClick={() => setFilterTab('favourites')}>Favourites</button>
          <button type="button" role="tab" aria-selected={filterTab === 'groups'} className={filterTab === 'groups' ? 'active' : ''} onClick={() => setFilterTab('groups')}>Groups</button>
          {listEntries(chatLists).map(([id, list]) => (
            <button type="button" role="tab" key={id} aria-selected={filterTab === `list:${id}`} className={filterTab === `list:${id}` ? 'active' : ''}
              onClick={() => setFilterTab(filterTab === `list:${id}` ? 'all' : `list:${id}`)} onContextMenu={(event) => { event.preventDefault(); setListEditor(id); }}>{list.name}</button>
          ))}
          <button type="button" className="wa-chip-add" onClick={() => setListEditor('')} aria-label="New list" title="New list"><Plus size={16} /></button>
          {labels.map((label) => (
            <button type="button" role="tab" key={label.id} aria-selected={filterTab === `label:${label.id}`} className={`wa-label-chip ${filterTab === `label:${label.id}` ? 'active' : ''}`}
              onClick={() => setFilterTab(filterTab === `label:${label.id}` ? 'all' : `label:${label.id}`)}>
              <Tag size={13} style={{ color: labelColor(label.color) }} aria-hidden="true" /> {label.name}
            </button>
          ))}
        </div>
      )}

      <div className="wa-rows">
        {!showArchived && !showLocked && !normalizedQuery && !isSelectionMode && lockedCount > 0 && (
          <button type="button" className="wa-row wa-archived-row" onClick={openLockedFolder} aria-label={`Locked chats, ${lockedCount}`}>
            <span className="wa-archived-icon" aria-hidden="true"><Lock size={20} /></span>
            <span className="wa-row-body"><span className="wa-row-top"><strong>Locked chats</strong></span></span>
          </button>
        )}
        {lockPrompt && (
          <form className="wa-lock-prompt" onSubmit={async (event) => {
            event.preventDefault();
            if (await unlockLockedChats({ method: 'passcode', passcode: lockPrompt.passcode })) { setLockPrompt(null); setShowLocked(true); setShowArchived(false); }
            else setLockPrompt({ passcode: '', error: 'Wrong passcode.' });
          }}>
            <label>App passcode<input type="password" inputMode="numeric" autoComplete="off" value={lockPrompt.passcode} onChange={(event) => setLockPrompt({ passcode: event.target.value, error: '' })} autoFocus /></label>
            {lockPrompt.error && <small role="alert">{lockPrompt.error}</small>}
            <span><button type="button" onClick={() => setLockPrompt(null)}>Cancel</button><button type="submit">Open</button></span>
          </form>
        )}
        {showLocked && !normalizedQuery && <p className="wa-note">Locked chats open only after your fingerprint, screen lock or app passcode. Their notifications don’t show the name or message.</p>}
        {!showArchived && !showLocked && !normalizedQuery && !isSelectionMode && archivedCount > 0 && (
          <button type="button" className="wa-row wa-archived-row" onClick={() => { setShowArchived(true); setFilterTab('all'); }} aria-label={`Archived, ${archivedCount} chats`}>
            <span className="wa-archived-icon" aria-hidden="true"><Archive size={20} /></span>
            <span className="wa-row-body"><span className="wa-row-top"><strong>Archived</strong>{archivedUnread > 0 && <span className="wa-badge is-muted">{archivedUnread}</span>}</span></span>
          </button>
        )}
        {showArchived && !normalizedQuery && <p className="wa-note">These chats stay archived when new messages arrive.</p>}
        {!searchFilter && visibleRows.map((chat) => {
          if (chat.kind === 'group') return <GroupListRow key={`group-${chat.id}`} row={chat} onOpen={onOpenGroup} labels={labelsFor(chat)} pressHandlers={rowPressHandlers(chat)} consumeLongPress={() => longPress.consumeFired()} />;
          const online = presence?.[chat.id] === 'online';
          const activity = chat.deleted ? null : typing?.[chat.id];
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
                <div className={`wa-row-avatar-wrap ${statusRings?.[chat.id] ? `has-status status-${statusRings[chat.id]}` : ''}`}
                  {...statusRingProps(chat.id, chat.deleted ? null : statusRings?.[chat.id], chat.name, () => !isSelectionMode && !longPress.wasFired())}>
                  <Avatar name={chat.name} initials={chat.initials ?? chat.name?.slice(0, 2)?.toUpperCase() ?? '?'} color={chat.color} image={chat.avatar} online={online} />
                  {isSelected && (
                    <div className="wa-row-check-badge">
                      <Check size={14} strokeWidth={3} />
                    </div>
                  )}
                </div>
                <span className="wa-row-body">
                  <span className="wa-row-top">
                    <strong>{chat.name ?? 'Unknown contact'}{chat.verified && <VerifiedBadge size={15} />}</strong>
                    <time className={chat.unread > 0 ? 'unread' : ''}>{chat.time ?? ''}</time>
                  </span>
                  <span className="wa-row-bottom">
                    {activity
                      ? <span className="wa-preview is-activity">{activity === 'recording' && <Mic size={14} aria-hidden="true" />}{activityLabel(activity)}</span>
                      : <span className="wa-preview"><FormattedText text={chat.preview || 'No messages yet'} inline /></span>}
                    <span className="wa-row-indicators">
                      {isMuted && <VolumeX size={15} className="wa-row-badge-icon" title="Muted" />}
                      {isPinned && <Pin size={15} className="wa-row-badge-icon" title="Pinned" />}
                      {favouriteChatIds.includes(chat.id) && <Heart size={15} className="wa-row-badge-icon is-favourite" fill="currentColor" title="Favourite" />}
                      {labelsFor(chat).map((label) => <Tag key={label.id} size={14} className="wa-row-badge-icon" style={{ color: labelColor(label.color) }} aria-label={`Label ${label.name}`} />)}
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

        <MessageSearch query={searchQuery} filter={searchFilter} groups={groups}
          onOpenChat={(chatId, messageId) => { const target = chats.find((chat) => chat.id === chatId); if (!target) return; useChatStore.getState().requestMessageJump(chatId, messageId); onOpenChat?.(target); }}
          onOpenGroup={(groupId) => onOpenGroup?.(groupId)} />

        {normalizedQuery && !searchFilter && (
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
            <h3>{filterTab === 'unread' ? 'No unread chats' : filterTab === 'groups' ? 'No groups yet' : filterTab === 'favourites' ? 'No favourites yet' : filterTab.startsWith('label:') ? 'No chats with this label' : 'No chats yet'}</h3>
            <p>{filterTab === 'groups' ? 'Create a group from the menu, or join one with an invite link.' : filterTab === 'favourites' ? 'Long-press a chat and choose Add to favourites.' : 'Tap the + button to find people and start chatting.'}</p>
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
      {listNotice && <div className="wa-list-toast" role="status">{listNotice}</div>}
      {listTarget && <ListPicker chatKey={listTarget.key} chatName={listTarget.name} groups={groups} onClose={() => setListTarget(null)} />}
      {listEditor !== null && <ListEditor listId={listEditor} groups={groups} onClose={() => setListEditor(null)} onSaved={(id) => setFilterTab(`list:${id}`)} />}
      {labelTarget && (
        <div className="wa-sheet-backdrop" onClick={() => setLabelTarget(null)} role="presentation">
          <div className="wa-action-sheet" role="dialog" aria-label={`Labels for ${labelTarget.name}`} onClick={(event) => event.stopPropagation()}>
            <header className="wa-action-sheet-head"><Tag size={20} aria-hidden="true" /><span><strong>Label chat</strong><small>{labelTarget.name}</small></span></header>
            {labels.length === 0 && <p className="wa-note">No labels yet. Create them in Tools → Business tools → Labels.</p>}
            {labels.map((label) => {
              const key = rowChatKey(labelTarget);
              const assigned = label.chatKeys.includes(key);
              return (
                <label key={label.id} className="wa-label-option">
                  <Tag size={18} style={{ color: labelColor(label.color) }} aria-hidden="true" />
                  <span>{label.name}</span>
                  <input type="checkbox" checked={assigned} onChange={() => toggleChatLabel(label.id, key, !assigned).catch((error) => setDeleteError(error.message))} />
                </label>
              );
            })}
            <button type="button" onClick={() => setLabelTarget(null)}>Done</button>
          </div>
        </div>
      )}

      {actionChat && (
        <div className="wa-sheet-backdrop" onClick={() => setActionChat(null)} role="presentation">
          <div className="wa-action-sheet" role="menu" aria-label={`Actions for ${actionChat.name ?? actionChat.username}`} onClick={(event) => event.stopPropagation()}>
            <header className="wa-action-sheet-head">
              {actionChat.kind === 'group' ? <span className="wa-group-avatar" aria-hidden="true"><Users size={20} /></span> : <Avatar name={actionChat.name} initials={actionChat.initials ?? actionChat.name?.slice(0, 2)?.toUpperCase() ?? '?'} color={actionChat.color} image={actionChat.avatar} size="small" />}
              <span>
                <strong>{actionChat.name ?? actionChat.username}</strong>
                {actionChat.username && <small>@{actionChat.username}{actionChat.saved ? '' : ' · Not in contacts'}</small>}
              </span>
            </header>
            {chatRowActions(actionChat, {
              pinned: pinnedChatIds.includes(actionChat.id),
              muted: mutedChatIds.includes(actionChat.id),
              favourite: favouriteChatIds.includes(actionChat.id),
              archived: archivedSet.has(rowChatKey(actionChat)),
              locked: lockedSet.has(rowChatKey(actionChat)),
            }).map((action) => (
              <button type="button" key={action.id} role="menuitem" className={action.danger ? 'danger' : ''} onClick={() => runChatAction(action.id, actionChat)}>
                {action.id === 'pin' && <Pin size={18} />}
                {action.id === 'mute' && (mutedChatIds.includes(actionChat.id) ? <Volume2 size={18} /> : <BellOff size={18} />)}
                {action.id === 'favourite' && <Heart size={18} fill={favouriteChatIds.includes(actionChat.id) ? 'currentColor' : 'none'} />}
                {action.id === 'select' && <Check size={18} />}
                {action.id === 'delete' && <Trash2 size={18} />}
                {action.id === 'open' && <MessageSquarePlus size={18} />}
                {action.id === 'archive' && (archivedSet.has(rowChatKey(actionChat)) ? <ArchiveRestore size={18} /> : <Archive size={18} />)}
                {action.id === 'label' && <Tag size={18} />}
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
