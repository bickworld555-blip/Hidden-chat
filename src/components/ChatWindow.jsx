import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Camera, Check, CheckCheck, ChevronDown, ChevronUp, CornerUpLeft, Forward, Info, Link2, Mic, MoreVertical, Paperclip, Phone, Search, Send, Smile, Star, Timer, Trash2, Video, X } from 'lucide-react';
import { parseVoiceContent, voiceExtension } from '../voice.js';
import { COMPOSER_EMOJIS, COMPOSER_MAX_LENGTH, composerAction, insertAtCaret } from '../composer.js';
import { playNotificationTone } from '../sounds.js';
import { EMPTY_MESSAGES, useChatStore } from '../store.js';
import { isBlocked } from '../blocking.js';
import { searchMessages } from '../contactInfo.js';
import { disappearingLabel } from '../disappearing.js';
import { uploadFile, uploadSizeError } from '../upload.js';
import { FORWARD_LIMIT, forwardSections } from '../forwarding.js';
import { quoteView, replyQuoteFor } from '../replies.js';
import { resolveSelection, selectionActions, toggleSelection } from '../selection.js';
import { EXTENDED_REACTIONS as EXTENDED_EMOJIS, QUICK_REACTIONS as QUICK_EMOJIS } from '../reactions.js';
import { formatMessageDate, formatMessageTime, localDateKey } from '../time.js';
import Avatar from './Avatar.jsx';
import AttachmentMenu from './AttachmentMenu.jsx';
import SelectContactModal from './SelectContactModal.jsx';
import { ContactBubble, LiveLocationBubble, LocationBubble } from './LocationMessages.jsx';
import { contactContent, liveContent, locationContent, messageKind, parseContact, parseLive, parseLocation } from '../geo.js';
import { hasCustomDisplayName, presentName } from '../profile.js';
import CallStatusBubble from './CallStatusBubble.jsx';
import MediaRenderer from './MediaRenderer.jsx';
import { lazyComponent } from '../lazy.js';
import { useBackHandler } from '../backStack.js';
import { nativeClearMessageNotifications, nativeShell } from '../native.js';
const LocationPicker = lazyComponent(() => import('./LocationPicker.jsx'));
const MapView = lazyComponent(() => import('./LocationMap.jsx'), (module) => module.MapView);
const ContactInfoDrawer = lazyComponent(() => import('./ContactInfoDrawer.jsx'));
const MediaViewer = lazyComponent(() => import('./MediaViewer.jsx'));
import VoiceMessage from './VoiceMessage.jsx';
import VoiceRecorderBar from './VoiceRecorderBar.jsx';
import { presenceLine } from '../presence.js';
import PendingUpload from './PendingUpload.jsx';
import { EventBubble, EventComposer, PollBubble, PollComposer, ViewOnceVoice } from './RichMessages.jsx';
import { parsePollContent } from '../polls.js';
import { parseEventContent } from '../calendarEvents.js';

function usePageVisible() {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return visible;
}

// Re-renders once a minute so "last seen today" rolls over to "yesterday" without new presence events.
function useMinuteClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

// Distance (px) from the bottom of the feed within which the view is still treated as "at the latest message".
const STICK_TO_BOTTOM_THRESHOLD = 80;
// Upper bound for a smooth scroll animation; after this the scroll position is re-evaluated.
const SMOOTH_SCROLL_SETTLE_MS = 800;
// Right after a chat opens, late layout (fonts, avatars, media) is corrected instantly instead of animated.
const OPEN_SETTLE_MS = 400;
// How long a message found through the media viewer's "Show in chat" stays highlighted.
const HIGHLIGHT_MS = 1600;
// Swipe-to-reply: horizontal travel before the gesture is recognised, and the distance that arms the reply.
const SWIPE_SLOP_PX = 10;
const SWIPE_REPLY_PX = 64;
const SWIPE_MAX_PX = 96;
const SWIPE_EXCLUDED = 'input, textarea, select, video, audio';
// Presses inside the reaction tray are taps on its buttons, never message gestures.
const TRAY_SELECTOR = '.wa-reaction-picker-bar';

function parseCall(content) {
  try {
    const data = JSON.parse(content.slice(5));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function MessageStatus({ status }) {
  if (status === 'read') return <CheckCheck size={12} className="read-check" aria-label="Read" />;
  if (status === 'delivered') return <CheckCheck size={12} aria-label="Delivered" />;
  if (status === 'failed') return <X size={12} aria-label="Failed" />;
  return <Check size={12} aria-label="Sent" />;
}

function ReactionTray({ onPick }) {
  const [extended, setExtended] = useState(false);
  return (
    <div className="wa-reaction-picker-bar" role="toolbar" aria-label="React to message">
      {QUICK_EMOJIS.map((emoji) => (
        <button type="button" key={emoji} className="wa-reaction-emoji-btn" onClick={() => onPick(emoji)} aria-label={`React ${emoji}`}>
          {emoji}
        </button>
      ))}
      <button
        type="button"
        className="wa-reaction-more-btn"
        onClick={() => setExtended((open) => !open)}
        aria-label="More reactions"
        aria-expanded={extended}
      >
        +
      </button>
      {extended && (
        <div className="wa-reaction-extended-dropdown">
          {EXTENDED_EMOJIS.map((emoji) => (
            <button type="button" key={emoji} className="wa-reaction-emoji-btn" onClick={() => onPick(emoji)} aria-label={`React ${emoji}`}>
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function MessageBubble({
  message,
  mine,
  sessionToken,
  sender,
  quote,
  isSelected,
  selectionActive,
  highlighted,
  onLongPress,
  onToggleSelect,
  onReact,
  onOpenMedia,
  onSwipeReply,
  onQuoteClick,
  reactionTrayOpen,
  onTrayReact,
  shared,
}) {
  const content = typeof message?.content === 'string' ? message.content : '';
  const time = formatMessageTime(message?.timestamp);
  const lineRef = useRef(null);
  const longPressTimerRef = useRef(null);
  const isLongPressRef = useRef(false);
  const gestureRef = useRef(null);
  const suppressClickRef = useRef(false);
  const swipeReply = selectionActive ? null : onSwipeReply;

  useEffect(() => () => clearTimeout(longPressTimerRef.current), []);

  function setSwipeOffset(offset) {
    const line = lineRef.current;
    if (!line) return;
    line.style.setProperty('--swipe-x', `${offset}px`);
    line.style.setProperty('--swipe-progress', String(Math.min(1, offset / SWIPE_REPLY_PX)));
  }

  function cancelLongPress() {
    clearTimeout(longPressTimerRef.current);
  }

  // One pointer gesture either becomes a long press (select + reactions), a rightward swipe (reply), or a scroll.
  function handlePointerDown(event) {
    // Reset first so a right-click (which has no primary-button gesture) is still treated as a fresh press.
    isLongPressRef.current = false;
    suppressClickRef.current = false;
    if (event.button !== 0 || !event.isPrimary || event.target.closest(TRAY_SELECTOR)) return;
    const swipeable = Boolean(swipeReply) && !event.target.closest(SWIPE_EXCLUDED);
    gestureRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, mode: swipeable ? 'pending' : 'none', armed: false };
    cancelLongPress();
    longPressTimerRef.current = setTimeout(() => {
      isLongPressRef.current = true;
      gestureRef.current = null;
      onLongPress(message);
    }, 450);
  }

  function handlePointerMove(event) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (gesture.mode !== 'swipe') {
      if (Math.abs(dx) < SWIPE_SLOP_PX && Math.abs(dy) < SWIPE_SLOP_PX) return;
      cancelLongPress();
      if (gesture.mode !== 'pending' || dx <= 0 || Math.abs(dx) < Math.abs(dy) * 1.2) {
        gestureRef.current = null;
        return;
      }
      gesture.mode = 'swipe';
      lineRef.current?.classList.add('swiping');
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* pointer already released */ }
      window.getSelection?.()?.removeAllRanges();
    }
    const travel = Math.max(0, dx);
    const offset = Math.min(SWIPE_MAX_PX, travel <= SWIPE_REPLY_PX ? travel : SWIPE_REPLY_PX + (travel - SWIPE_REPLY_PX) * 0.35);
    const armed = travel >= SWIPE_REPLY_PX;
    if (armed && !gesture.armed) navigator.vibrate?.(12);
    gesture.armed = armed;
    lineRef.current?.classList.toggle('swipe-armed', armed);
    setSwipeOffset(offset);
  }

  function finishGesture(event, cancelled) {
    const gesture = gestureRef.current;
    if (event.pointerId !== undefined && gesture && gesture.pointerId !== event.pointerId) return;
    cancelLongPress();
    gestureRef.current = null;
    // A long press is followed by at most one synthesized click; never let the flag outlive this release.
    if (isLongPressRef.current) setTimeout(() => { isLongPressRef.current = false; }, 0);
    if (gesture?.mode !== 'swipe') return;
    // Swallow only the click synthesized by this release; touch swipes often produce none.
    suppressClickRef.current = true;
    setTimeout(() => { suppressClickRef.current = false; }, 0);
    lineRef.current?.classList.remove('swiping', 'swipe-armed');
    setSwipeOffset(0);
    if (!cancelled && gesture.armed) swipeReply?.(message);
  }

  // Runs before any handler inside the message, so taps are routed in one place:
  // swipe and long-press releases are swallowed, and while selecting a tap only toggles selection
  // (it never opens media, follows a quote, or toggles a reaction badge).
  function handleClickCapture(event) {
    if (event.target.closest(TRAY_SELECTOR)) return;
    const consumed = suppressClickRef.current || isLongPressRef.current;
    suppressClickRef.current = false;
    isLongPressRef.current = false;
    if (!consumed && !selectionActive) return;
    event.preventDefault();
    event.stopPropagation();
    if (!consumed) onToggleSelect(message);
  }

  function handleContextMenu(event) {
    event.preventDefault();
    // Touch browsers fire contextmenu after our own long-press timer; handle the press only once.
    if (isLongPressRef.current || event.target.closest(TRAY_SELECTOR)) return;
    cancelLongPress();
    gestureRef.current = null;
    isLongPressRef.current = true;
    onLongPress(message);
  }

  const voice = parseVoiceContent(content);
  const isVoice = Boolean(voice);
  const isMedia = content.startsWith('media:');
  const sharedKind = messageKind(content);
  const poll = parsePollContent(content);
  const event = parseEventContent(content);

  const meta = (
    <div className="message-meta">
      {message?.starred && <Star size={11} className="message-star" fill="currentColor" aria-label="Starred" />}
      <time>{time}</time>
      {mine && <MessageStatus status={message?.status} />}
    </div>
  );

  const reactions = Array.isArray(message?.reactions) ? message.reactions : [];
  // Group reactions by emoji and count
  const reactionCounts = reactions.reduce((acc, r) => {
    acc[r.emoji] = (acc[r.emoji] || 0) + 1;
    return acc;
  }, {});

  const isCall = content.startsWith('call:');

  return (
    <div
      ref={lineRef}
      className={`message-line ${mine ? 'mine' : ''} ${isSelected ? 'selected-msg' : ''} ${selectionActive ? 'selecting' : ''} ${highlighted ? 'flash-highlight' : ''}`}
      data-message-id={message.id}
      aria-selected={selectionActive ? isSelected : undefined}
      onContextMenu={handleContextMenu}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => finishGesture(event, false)}
      onPointerCancel={(event) => finishGesture(event, true)}
      onPointerLeave={(event) => finishGesture(event, true)}
      onClickCapture={handleClickCapture}
    >
      {swipeReply && (
        <span className="swipe-reply-icon" aria-hidden="true"><CornerUpLeft size={16} /></span>
      )}
      {reactionTrayOpen && <ReactionTray onPick={onTrayReact} />}

      {isCall ? (
        <div>
          <CallStatusBubble callData={parseCall(content)} isOutgoing={mine} timestamp={time} />
        </div>
      ) : (
        <div
          className={`message-bubble ${mine ? 'outgoing' : 'incoming'} ${isVoice ? 'voice-bubble' : ''} ${isMedia || sharedKind !== 'text' ? 'attachment-bubble' : ''} ${Object.keys(reactionCounts).length > 0 ? 'has-reactions' : ''}`}
        >
          {message?.forwarded && (
            <div className="wa-forwarded-label"><Forward size={13} aria-hidden="true" /><span>Forwarded</span></div>
          )}
          {quote && (
            <button
              type="button"
              className="wa-quoted-reply-preview"
              onClick={() => {
                if (message.replyTo?.id) onQuoteClick?.(message.replyTo.id);
              }}
            >
              <span className="wa-quoted-sender">{quote.sender}</span>
              <span className="wa-quoted-text">{quote.text}</span>
            </button>
          )}
          {voice?.viewOnce ? (
            <ViewOnceVoice messageId={message.id} seconds={voice.seconds} opened={voice.opened} mine={mine} sessionToken={sessionToken}>{meta}</ViewOnceVoice>
          ) : isVoice ? (
            <VoiceMessage id={voice.id} seconds={voice.seconds} sessionToken={sessionToken} sender={sender}>{meta}</VoiceMessage>
          ) : poll ? (
            <PollBubble messageId={message.id} poll={poll} sessionToken={sessionToken} userId={shared.userId} nameFor={shared.nameFor}>{meta}</PollBubble>
          ) : event ? (
            <EventBubble messageId={message.id} event={event}>{meta}</EventBubble>
          ) : (
            <>
              {isMedia ? <MediaRenderer mediaRef={content} sessionToken={sessionToken} onOpen={onOpenMedia} />
                : sharedKind === 'location' && parseLocation(content) ? <LocationBubble location={parseLocation(content)} onOpen={shared.openLocation} />
                : sharedKind === 'live' && parseLive(content) ? <LiveLocationBubble live={parseLive(content)} mine={mine} peerName={shared.peerName} send={shared.send} onOpen={shared.openLive} />
                : sharedKind === 'contact' && parseContact(content) ? <ContactBubble contact={parseContact(content)} onMessage={shared.messageContact} />
                : <p>{content}</p>}
              {meta}
            </>
          )}

          {Object.keys(reactionCounts).length > 0 && (
            <div className="wa-bubble-reactions">
              {Object.entries(reactionCounts).map(([emoji, count]) => (
                <button
                  type="button"
                  key={emoji}
                  className="wa-bubble-reaction-badge"
                  onClick={() => onReact(emoji)}
                  title="Remove or toggle reaction"
                >
                  <span>{emoji}</span>
                  {count > 1 && <small>{count}</small>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DeleteMessageModal({ messages, userId, onConfirm, onClose }) {
  const [deleteMedia, setDeleteMedia] = useState(true);
  const { count, deleteForEveryone, hasMedia } = selectionActions(messages, userId);
  const title = count === 1 ? 'Delete message?' : `Delete ${count} messages?`;

  return (
    <div className="modal-overlay wa-delete-overlay" onClick={onClose}>
      <div className="wa-delete-modal" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <h3>{title}</h3>
        {hasMedia && deleteForEveryone && (
          <label className="wa-delete-check">
            <input type="checkbox" checked={deleteMedia} onChange={(event) => setDeleteMedia(event.target.checked)} />
            <span>Also delete media received in this chat from the gallery</span>
          </label>
        )}
        <div className="wa-delete-actions">
          {deleteForEveryone && (
            <button type="button" onClick={() => onConfirm('everyone', deleteMedia)}>Delete for everyone</button>
          )}
          <button type="button" onClick={() => onConfirm('me', deleteMedia)}>Delete for me</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function ForwardPickerModal({ chats, userId, onSend, onClose }) {
  const messages = useChatStore((state) => state.messages);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState([]);
  const [notice, setNotice] = useState('');
  const sections = useMemo(() => forwardSections(chats, messages, userId, query), [chats, messages, userId, query]);
  const selectedIds = new Set(selected.map((chat) => chat.id));

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(''), 2500);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    function handleKey(event) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  function toggle(chat) {
    if (selectedIds.has(chat.id)) {
      setSelected((current) => current.filter((item) => item.id !== chat.id));
    } else if (selected.length >= FORWARD_LIMIT) {
      setNotice(`You can only share with up to ${FORWARD_LIMIT} chats`);
    } else {
      setSelected((current) => [...current, chat]);
    }
  }

  function closeSearch() {
    setSearching(false);
    setQuery('');
  }

  return (
    <div className="modal-overlay wa-forward-overlay" onClick={onClose}>
      <div className="wa-forward-sheet" role="dialog" aria-modal="true" aria-label="Forward to" onClick={(event) => event.stopPropagation()}>
        <header className="wa-forward-header">
          {searching ? (
            <>
              <button type="button" className="wa-forward-icon" onClick={closeSearch} aria-label="Close search"><ArrowLeft size={20} /></button>
              <input
                autoFocus
                className="wa-forward-search-input"
                type="search"
                placeholder="Search…"
                aria-label="Search chats"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </>
          ) : (
            <>
              <button type="button" className="wa-forward-icon" onClick={onClose} aria-label="Close"><ArrowLeft size={20} /></button>
              <div className="wa-forward-title">
                <strong>Forward to…</strong>
                {selected.length > 0 && <small>{selected.length} of {FORWARD_LIMIT} selected</small>}
              </div>
              <button type="button" className="wa-forward-icon" onClick={() => setSearching(true)} aria-label="Search"><Search size={20} /></button>
            </>
          )}
        </header>
        <div className="wa-forward-list">
          {sections.length === 0 && <p className="wa-forward-empty">{query ? `No results for “${query.trim()}”` : 'No chats yet'}</p>}
          {sections.map((section) => (
            <section key={section.id} className="wa-forward-section" aria-label={section.title}>
              <h4>{section.title}</h4>
              {section.chats.map((chat) => {
                const checked = selectedIds.has(chat.id);
                const handle = chat.username ? `@${chat.username}` : '';
                return (
                  <button
                    type="button"
                    key={chat.id}
                    role="checkbox"
                    aria-checked={checked}
                    className={`wa-forward-row ${checked ? 'checked' : ''}`}
                    onClick={() => toggle(chat)}
                  >
                    <span className="wa-forward-avatar">
                      <Avatar name={chat.name} initials={chat.initials ?? chat.name?.slice(0, 2)?.toUpperCase() ?? '?'} color={chat.color} image={chat.avatar} />
                      {checked && <span className="wa-forward-check"><Check size={12} strokeWidth={3} /></span>}
                    </span>
                    <span className="wa-forward-text">
                      <strong>{chat.name ?? handle}</strong>
                      {handle && handle !== chat.name && <small>{handle}</small>}
                    </span>
                  </button>
                );
              })}
            </section>
          ))}
        </div>
        {notice && <div className="wa-forward-notice" role="status">{notice}</div>}
        {selected.length > 0 && (
          <footer className="wa-forward-footer">
            <span className="wa-forward-names">{selected.map((chat) => chat.name ?? chat.username).join(', ')}</span>
            <button
              type="button"
              className="wa-forward-send"
              onClick={() => onSend(selected)}
              aria-label={`Send to ${selected.length} chat${selected.length === 1 ? '' : 's'}`}
            >
              <Send size={20} />
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}


function ContactSharePicker({ contacts, onSelect, onClose }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="attach-picker" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h3>Share a contact</h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="modal-body">
          {contacts.length === 0 && <p>You have no contacts to share yet.</p>}
          {contacts.map((contact) => (
            <button type="button" key={contact.id} className="attachment-menu-item" onClick={() => onSelect(contact)}>
              <Avatar name={contact.name} initials={contact.initials} color={contact.color} image={contact.avatar} />
              <span className="attachment-menu-label">{contact.name}{contact.username ? ` (@${contact.username})` : ''}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function ChatWindow({ chat, connection, client, onPair, onBack, onStartCall, onGroups }) {
  const chatId = chat?.id;
  const userId = useChatStore((state) => state.userId);
  const sessionToken = useChatStore((state) => state.sessionToken);
  const user = useChatStore((state) => state.user);
  const chats =  useChatStore((state) => state.chats);
  const messages = useChatStore((state) => (chatId ? state.messages?.[chatId] : null)) ?? EMPTY_MESSAGES;
  const presence = useChatStore((state) => (chatId ? state.presence?.[chatId] : undefined));
  const lastSeenAt = useChatStore((state) => (chatId ? state.lastSeen?.[chatId] : undefined));
  const now = useMinuteClock();
  const typing = useChatStore((state) => (chatId ? state.typing?.[chatId] : false));
  const addMessage = useChatStore((state) => state.addMessage);
  const updateMessage = useChatStore((state) => state.updateMessage);
  const markRead = useChatStore((state) => state.markRead);
  const queueMessage = useChatStore((state) => state.queueMessage);

  const deleteMessage = useChatStore((state) => state.deleteMessage);
  const toggleReaction = useChatStore((state) => state.toggleReaction);
  const toggleStar = useChatStore((state) => state.toggleStar);
  const setActiveChat = useChatStore((state) => state.setActiveChat);
  const blocked = useChatStore((state) => (chatId ? isBlocked(state.blockedChats[chatId]) : false));
  const chatTheme = useChatStore((state) => (chatId ? state.chatThemes[chatId] : undefined)) ?? 'default';
  const unblockChat = useChatStore((state) => state.unblockChat);

  const [text, setText] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [picker, setPicker] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null);
  const uploadAbortRef = useRef(null);
  const [recording, setRecording] = useState(false);

  // Multi-selection drives the contextual header; the reaction tray belongs to a single long-pressed selection.
  const [selectedIds, setSelectedIds] = useState([]);
  const [reactionTrayId, setReactionTrayId] = useState(null);
  const [forwardSource, setForwardSource] = useState(null);
  const [replyingTo, setReplyingTo] = useState(null);
  const [infoMessage, setInfoMessage] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [viewerMessageId, setViewerMessageId] = useState(null);
  const [highlightId, setHighlightId] = useState(null);
  const [contactInfoOpen, setContactInfoOpen] = useState(false);
  const [contactInfoView, setContactInfoView] = useState('main');
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [headerNotice, setHeaderNotice] = useState('');
  const [newContactOpen, setNewContactOpen] = useState(false);
  const muted = useChatStore((state) => state.mutedChatIds.includes(chatId));
  const openInfo = (view) => { setContactInfoView(view); setContactInfoOpen(true); };

  useEffect(() => {
    if (!headerMenuOpen) return undefined;
    const close = (event) => { if (!event.target.closest('.header-menu-wrap')) setHeaderMenuOpen(false); };
    const onKey = (event) => { if (event.key === 'Escape') setHeaderMenuOpen(false); };
    document.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', close); window.removeEventListener('keydown', onKey); };
  }, [headerMenuOpen]);

  useEffect(() => {
    if (!headerNotice) return undefined;
    const timer = setTimeout(() => setHeaderNotice(''), 3500);
    return () => clearTimeout(timer);
  }, [headerNotice]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchIndex, setSearchIndex] = useState(0);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const action = composerAction(text);

  const fileInputRef = useRef(null);
  const composerInputRef = useRef(null);
  const messageScrollRef = useRef(null);
  const messageStackRef = useRef(null);
  const messagesEndRef = useRef(null);
  const readSentRef = useRef(new Set());
  const typingTimerRef = useRef(null);

  // Auto-scroll state: the feed stays pinned to the newest message unless the user scrolls up to read history.
  const stickToBottomRef = useRef(true);
  const autoScrollingRef = useRef(false);
  const autoScrollTimerRef = useRef(null);
  const latestSeenMessageIdRef = useRef(null);
  const openedAtRef = useRef(0);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [unseenCount, setUnseenCount] = useState(0);

  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  const lastMessageId = lastMessage?.id ?? null;
  const lastMessageMine = Boolean(lastMessage) && lastMessage.senderId === userId;

  const distanceFromBottom = useCallback(() => {
    const container = messageScrollRef.current;
    if (!container) return 0;
    return container.scrollHeight - container.scrollTop - container.clientHeight;
  }, []);

  const syncScrollState = useCallback(() => {
    if (!messageScrollRef.current) return;
    const atBottom = distanceFromBottom() <= STICK_TO_BOTTOM_THRESHOLD;
    if (atBottom) {
      autoScrollingRef.current = false;
      clearTimeout(autoScrollTimerRef.current);
    } else if (autoScrollingRef.current) {
      // Intermediate frame of our own smooth scroll; the user has not scrolled away.
      return;
    }
    if (stickToBottomRef.current === atBottom) return;
    stickToBottomRef.current = atBottom;
    setShowJumpToLatest(!atBottom);
    if (atBottom) setUnseenCount(0);
  }, [distanceFromBottom]);

  // Scrolling the feed container directly (rather than only the anchor) keeps ancestors such as the app shell
  // from being scrolled as a side effect; the anchor's scrollIntoView is the fallback when the container is missing.
  const pinToBottom = useCallback(() => {
    const container = messageScrollRef.current;
    if (container) container.scrollTop = container.scrollHeight;
    else messagesEndRef.current?.scrollIntoView?.({ block: 'end', behavior: 'auto' });
  }, []);

  const scrollToBottom = useCallback((behavior = 'smooth') => {
    stickToBottomRef.current = true;
    setShowJumpToLatest(false);
    setUnseenCount(0);
    clearTimeout(autoScrollTimerRef.current);
    const smooth = behavior === 'smooth';
    autoScrollingRef.current = smooth;
    if (!smooth) {
      pinToBottom();
      return;
    }
    const container = messageScrollRef.current;
    if (container && typeof container.scrollTo === 'function') container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
    else if (container) container.scrollTop = container.scrollHeight;
    else messagesEndRef.current?.scrollIntoView?.({ block: 'end', behavior: 'smooth' });
    autoScrollTimerRef.current = setTimeout(() => {
      autoScrollingRef.current = false;
      // Finish exactly at the bottom unless the user scrolled away while the animation was running.
      if (stickToBottomRef.current && distanceFromBottom() <= STICK_TO_BOTTOM_THRESHOLD) pinToBottom();
      syncScrollState();
    }, SMOOTH_SCROLL_SETTLE_MS);
  }, [distanceFromBottom, pinToBottom, syncScrollState]);

  // A wheel or touch gesture is user intent: stop treating subsequent scroll events as our own animation.
  const cancelAutoScroll = useCallback(() => {
    if (!autoScrollingRef.current) return;
    autoScrollingRef.current = false;
    clearTimeout(autoScrollTimerRef.current);
  }, []);

  // Opening a chat: anchor instantly on the latest message before the first paint, then re-pin on the next
  // frame to absorb late layout. Intentionally keyed on the chat only.
  useLayoutEffect(() => {
    if (!chatId) return undefined;
    setEmojiOpen(false);
    openedAtRef.current = performance.now();
    latestSeenMessageIdRef.current = lastMessageId;
    scrollToBottom('auto');
    const frame = requestAnimationFrame(() => {
      if (stickToBottomRef.current) pinToBottom();
    });
    return () => cancelAnimationFrame(frame);
  }, [chatId]);

  // New latest message: follow it when pinned to the bottom or when it is our own; otherwise count it for the jump button.
  useEffect(() => {
    if (!chatId || lastMessageId === latestSeenMessageIdRef.current) return;
    const firstLoad = latestSeenMessageIdRef.current === null;
    latestSeenMessageIdRef.current = lastMessageId;
    if (!lastMessageId) return;
    if (firstLoad || lastMessageMine || stickToBottomRef.current) {
      scrollToBottom(firstLoad ? 'auto' : 'smooth');
    } else {
      setUnseenCount((count) => count + 1);
    }
  }, [chatId, lastMessageId, lastMessageMine, scrollToBottom]);

  useEffect(() => {
    if (typing && stickToBottomRef.current) scrollToBottom('smooth');
  }, [typing, scrollToBottom]);

  // Keep the newest message in view while pinned whenever the feed changes height: media finishing loading,
  // reactions, the typing indicator, or the container shrinking (e.g. the mobile keyboard opening).
  useEffect(() => {
    const container = messageScrollRef.current;
    const stack = messageStackRef.current;
    if (!chatId || !container || !stack || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      if (!stickToBottomRef.current) return;
      const justOpened = performance.now() - openedAtRef.current < OPEN_SETTLE_MS;
      if (justOpened) pinToBottom();
      else scrollToBottom('smooth');
    });
    observer.observe(stack);
    observer.observe(container);
    return () => observer.disconnect();
  }, [chatId, pinToBottom, scrollToBottom]);

  useEffect(() => () => clearTimeout(autoScrollTimerRef.current), []);

  // Blue ticks only for what the person can actually see: this chat open, on a visible screen.
  const pageVisible = usePageVisible();
  useEffect(() => {
    if (!chatId || !pageVisible) return;
    for (const message of messages) {
      if (message?.senderId === chatId && message.status !== 'read' && !readSentRef.current.has(message.id)) {
        readSentRef.current.add(message.id);
        client?.send?.({ type: 'message:read', messageId: message.id });
        updateMessage(message.id, { status: 'read' });
      }
    }
    markRead(chatId);
    // Read on screen: its Android notification (and its share of the icon badge) goes away.
    if (nativeShell()) nativeClearMessageNotifications(`chat:${chatId}`);
  }, [messages, chatId, client, markRead, updateMessage, pageVisible]);

  useEffect(() => () => clearTimeout(typingTimerRef.current), []);

  const mediaMessages = useMemo(() => messages.filter((message) => message?.id && typeof message.content === 'string' && message.content.startsWith('media:')), [messages]);
  // A deleted message (by either side) closes its viewer because it is no longer found.
  const viewerMessage = viewerMessageId ? mediaMessages.find((message) => message.id === viewerMessageId) ?? null : null;

  // Resolved against live messages so deleted or replaced messages drop out and selection mode ends on its own.
  const selectedMessages = useMemo(() => resolveSelection(messages, selectedIds), [messages, selectedIds]);
  const selectionActive = selectedMessages.length > 0;
  const trayMessageId = selectedMessages.length === 1 && selectedMessages[0].id === reactionTrayId ? reactionTrayId : null;
  const actions = selectionActions(selectedMessages, userId);

  const clearSelection = useCallback(() => {
    setSelectedIds([]);
    setReactionTrayId(null);
  }, []);

  useEffect(() => {
    setViewerMessageId(null);
    setHighlightId(null);
    setReplyingTo(null);
    setForwardSource(null);
    setDeleteTarget(null);
    setContactInfoOpen(false);
    setSearchOpen(false);
    setSearchQuery('');
    clearSelection();
  }, [chatId, clearSelection]);

  const modalOpen = Boolean(forwardSource || deleteTarget || infoMessage || viewerMessage || contactInfoOpen);
  // In-chat search steps from the newest match (index 0) towards older ones, like WhatsApp.
  const searchMatches = useMemo(() => (searchOpen ? searchMessages(messages, searchQuery) : []), [searchOpen, messages, searchQuery]);
  useEffect(() => {
    if (!selectionActive || modalOpen) return undefined;
    function handleKey(event) {
      if (event.key === 'Escape') clearSelection();
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [selectionActive, modalOpen, clearSelection]);

  // Long press starts selection with the reaction tray; once selecting, it toggles like a tap.
  // Toggles start from the resolved ids so ids of messages deleted meanwhile are pruned rather than kept.
  const handleToggleSelect = useCallback((message) => {
    setSelectedIds(toggleSelection(selectedMessages.map((item) => item.id), message.id));
    setReactionTrayId(null);
  }, [selectedMessages]);

  const handleLongPress = useCallback((message) => {
    if (selectionActive) {
      handleToggleSelect(message);
      return;
    }
    setSelectedIds([message.id]);
    setReactionTrayId(message.id);
  }, [selectionActive, handleToggleSelect]);

  useEffect(() => {
    if (!highlightId) return undefined;
    const timer = setTimeout(() => setHighlightId(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlightId]);

  const sendToChat = useCallback((receiverId, content, extras = {}) => {
    if (!receiverId || !userId || !content) return;
    const message = {
      id: crypto.randomUUID(),
      senderId: userId,
      receiverId,
      timestamp: new Date().toISOString(),
      content,
      status: 'sent',
      ...extras,
    };
    addMessage(message);
    queueMessage?.(message);
    const accepted = client?.send?.({ type: 'message:send', message: { id: message.id, receiverId, content, ...extras } });
    if (!accepted) updateMessage(message.id, { status: 'failed' });
  }, [userId, client, addMessage, queueMessage, updateMessage]);

  const sendContent = useCallback((content, customReplyTo = null) => {
    if (!chatId || !content) return;
    const replyTo = customReplyTo ?? replyingTo;
    sendToChat(chatId, content, replyTo ? { replyTo } : {});
    playNotificationTone('sent');
    if (!customReplyTo && replyingTo) setReplyingTo(null);
  }, [chatId, sendToChat, replyingTo]);

  const closeForwardPicker = useCallback(() => setForwardSource(null), []);

  async function uploadAndSend(blob, filename, kind, seconds) {
    const sizeError = uploadSizeError(filename, blob.size);
    if (sizeError) {
      setError(sizeError);
      return;
    }
    if (!sessionToken) {
      setError('Sign in again to share attachments.');
      return;
    }
    const controller = new AbortController();
    uploadAbortRef.current = controller;
    setBusy(true);
    setError('');
    // Shown as an outgoing bubble with a progress ring (photos and videos preview at once), like WhatsApp.
    const type = blob.type || '';
    const previewKind = kind === 'voice' || kind === 'voice-once' ? 'voice' : type.startsWith('image/') ? 'image' : type.startsWith('video/') ? 'video' : 'file';
    const previewUrl = previewKind === 'image' || previewKind === 'video' ? URL.createObjectURL(blob) : '';
    const pending = { filename, kind: previewKind, previewUrl };
    setUploadProgress({ ...pending, sent: 0, total: blob.size });
    scrollToBottom('smooth');
    try {
      const file = blob instanceof File ? blob : new File([blob], filename, { type: blob.type });
      const data = await uploadFile(file, {
        receiverId: chatId,
        sessionToken,
        signal: controller.signal,
        onProgress: (sent, total) => setUploadProgress({ ...pending, sent, total }),
      });
      sendContent(kind === 'voice' ? `voice:${data.id}:${seconds}` : kind === 'voice-once' ? `voice:${data.id}:${seconds}:once` : `media:${data.id}:${data.filename || filename}`);
    } catch (caught) {
      if (caught?.name !== 'AbortError') setError(caught?.message || 'Upload failed.');
    } finally {
      uploadAbortRef.current = null;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setUploadProgress(null);
      setBusy(false);
    }
  }

  function cancelUpload() {
    uploadAbortRef.current?.abort();
  }

  useEffect(() => () => uploadAbortRef.current?.abort(), []);

  async function handleFileChange(event) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    for (const file of files) await uploadAndSend(file, file.name, 'media');
  }

  function openFilePicker(accept, capture) {
    const input = fileInputRef.current;
    if (!input) return;
    // No accept filter lets every file format be chosen.
    if (accept) input.accept = accept;
    else input.removeAttribute('accept');
    if (capture) input.setAttribute('capture', capture);
    else input.removeAttribute('capture');
    input.multiple = !capture;
    input.click();
  }

  function handleAttachmentSelect(option) {
    setError('');
    if (option === 'document') openFilePicker('');
    else if (option === 'gallery') openFilePicker('image/*,video/*');
    else if (option === 'camera') openFilePicker('image/*,video/*', 'environment');
    else if (option === 'audio') openFilePicker('audio/*');
    else if (option === 'location') setPicker('location');
    else if (option === 'contact') setPicker('contact');
    else if (option === 'poll') setPicker('poll');
    else if (option === 'event') setPicker('event');
  }

  function handleLocation(selection) {
    if (!selection || !Number.isFinite(selection.lat) || !Number.isFinite(selection.lon)) return;
    sendContent(locationContent(selection));
    setPicker(null);
  }

  // Live sharing: the card goes out as a message and the server-side session starts in 'requested'.
  function handleShareLive(durationMs, comment = '') {
    const sessionId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const sent = client?.send?.({ type: 'location:live', action: 'request', sessionId, peerId: chatId, durationMs });
    if (sent === false) {
      setError('You are offline. Live location needs a connection.');
      return;
    }
    useChatStore.getState().startLiveSession({ sessionId, peerId: chatId, durationMs, startedAt });
    sendContent(liveContent({ sessionId, durationMs, startedAt, comment }));
    setPicker(null);
  }

  function handleContact(contact) {
    sendContent(contactContent(contact));
    setPicker(null);
  }

  const [mapView, setMapView] = useState(null);
  // Android Back inside a chat closes what is open on top of it, newest first.
  useBackHandler(selectedIds.length > 0, () => clearSelection());
  useBackHandler(searchOpen, () => setSearchOpen(false));
  useBackHandler(emojiOpen, () => setEmojiOpen(false));
  useBackHandler(menuOpen, () => setMenuOpen(false));
  useBackHandler(Boolean(picker), () => setPicker(null));
  useBackHandler(Boolean(forwardSource), () => setForwardSource(null));
  useBackHandler(contactInfoOpen, () => setContactInfoOpen(false));
  useBackHandler(Boolean(viewerMessageId), () => setViewerMessageId(null));
  useBackHandler(Boolean(mapView), () => setMapView(null));
  const liveSend = useCallback((payload) => client?.send?.(payload), [client]);
  const sharedHandlers = useMemo(() => ({
    peerName: chat?.name ?? 'Contact',
    userId,
    nameFor: (id) => (id === chat?.id ? presentName(chat) : null),
    send: client ? liveSend : null,
    openLocation: (location) => setMapView({ location }),
    openLive: (sessionId) => setMapView({ sessionId }),
    messageContact: (contact) => {
      const { chats: list, addContact, setActiveChat } = useChatStore.getState();
      if (list.some((item) => item.id === contact.id)) setActiveChat(contact.id);
      else addContact({ id: contact.id, name: contact.name, username: contact.username, initials: contact.initials, color: contact.color, avatar: contact.avatar });
    },
  }), [chat, userId, client, liveSend]);

  function handleVoiceSend(blob, seconds, type, { viewOnce = false } = {}) {
    setRecording(false);
    uploadAndSend(blob, `voice-note.${voiceExtension(type)}`, viewOnce ? 'voice-once' : 'voice', seconds);
  }

  const handleVoiceCancel = useCallback(() => setRecording(false), []);

  function handleTextChange(event) {
    setText(event.target.value);
    notifyTyping();
  }

  function notifyTyping() {
    if (!chatId) return;
    client?.send?.({ type: 'presence:typing', peerId: chatId, active: true });
    clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => client?.send?.({ type: 'presence:typing', peerId: chatId, active: false }), 1800);
  }

  function insertEmoji(emoji) {
    const input = composerInputRef.current;
    const result = insertAtCaret(text, emoji, input?.selectionStart ?? text.length, input?.selectionEnd ?? text.length);
    if (!result.inserted) return;
    setText(result.text);
    notifyTyping();
    requestAnimationFrame(() => {
      if (!input) return;
      input.focus({ preventScroll: true });
      input.setSelectionRange(result.caret, result.caret);
    });
  }

  function handleSubmit(event) {
    event.preventDefault();
    const content = text.trim();
    if (!content) return;
    if (content.length > COMPOSER_MAX_LENGTH) {
      setError('Messages can be up to 4,000 characters.');
      return;
    }
    clearTimeout(typingTimerRef.current);
    client?.send?.({ type: 'presence:typing', peerId: chatId, active: false });
    sendContent(content);
    setText('');
    setEmojiOpen(false);
    setError('');
  }

  if (!chat) {
    return (
      <section className="empty-conversation">
        <h1>Select a conversation</h1>
        <p>Choose a contact to start messaging.</p>
      </section>
    );
  }

  const status = typing ? 'typing…' : presenceLine({ status: presence, lastSeenAt }, now);
  const shareable = (Array.isArray(chats) ? chats : []).filter((item) => item?.id && item.id !== userId);
  let lastDay = '';

  function handleForwardMessage(targets) {
    const sources = Array.isArray(forwardSource) ? forwardSource : [];
    if (sources.length === 0 || !Array.isArray(targets) || targets.length === 0) return;
    for (const target of targets) {
      if (!target?.id) continue;
      for (const source of sources) sendToChat(target.id, source.content, { forwarded: true });
    }
    setForwardSource(null);
    clearSelection();
    // Like WhatsApp, forwarding to a single other chat opens that chat.
    if (targets.length === 1 && targets[0].id !== chatId) setActiveChat(targets[0].id);
  }

  function startReply(target) {
    setReplyingTo(replyQuoteFor(target));
    clearSelection();
    requestAnimationFrame(() => composerInputRef.current?.focus());
  }

  function reactTo(target, emoji) {
    const next = toggleReaction(chatId, target.id, emoji);
    if (target.content?.startsWith('call:')) return;
    client?.send?.({ type: 'message:reaction', messageId: target.id, emoji: next });
  }

  function replyFromViewer(target, text) {
    if (text.length > 4000) return false;
    sendContent(text, replyQuoteFor(target));
    return true;
  }

  function showInChat(messageId) {
    setViewerMessageId(null);
    setHighlightId(messageId);
    requestAnimationFrame(() => {
      const container = messageScrollRef.current;
      const line = container?.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
      if (!container || !line) return;
      // Leave the bottom pin so later layout changes do not pull the feed away from this message.
      autoScrollingRef.current = false;
      clearTimeout(autoScrollTimerRef.current);
      stickToBottomRef.current = false;
      setShowJumpToLatest(true);
      const box = container.getBoundingClientRect();
      const target = line.getBoundingClientRect();
      container.scrollTo({ top: container.scrollTop + target.top - box.top - (box.height - target.height) / 2, behavior: 'smooth' });
    });
  }

  function sendEditedMedia(blob, filename) {
    setViewerMessageId(null);
    uploadAndSend(blob, filename, 'media');
  }

  function openChatSearch() {
    clearSelection();
    setSearchQuery('');
    setSearchIndex(0);
    setSearchOpen(true);
  }

  function closeChatSearch() {
    setSearchOpen(false);
    setSearchQuery('');
  }

  function runChatSearch(value) {
    setSearchQuery(value);
    setSearchIndex(0);
    const ids = searchMessages(messages, value);
    if (ids.length) showInChat(ids[ids.length - 1]);
  }

  function stepChatSearch(delta) {
    const count = searchMatches.length;
    if (!count) return;
    const next = Math.min(count - 1, Math.max(0, searchIndex + delta));
    setSearchIndex(next);
    showInChat(searchMatches[count - 1 - next]);
  }

  function starSelection() {
    const starred = !actions.allStarred;
    for (const message of selectedMessages) {
      if (Boolean(message.starred) !== starred) toggleStar(chatId, message.id);
    }
    clearSelection();
  }

  function confirmDelete(scope, deleteMedia) {
    const targets = Array.isArray(deleteTarget) ? deleteTarget : [];
    setDeleteTarget(null);
    let offline = false;
    for (const target of targets) {
      const onServer = !target.content?.startsWith('call:') && target.status !== 'failed';
      if (!onServer) {
        deleteMessage(chatId, target.id);
      } else if (scope === 'everyone') {
        if (!client?.send?.({ type: 'message:delete', messageId: target.id, scope, deleteMedia })) offline = true;
      } else {
        deleteMessage(chatId, target.id);
        client?.send?.({ type: 'message:delete', messageId: target.id, scope });
      }
    }
    if (offline) setError('You are offline. Try deleting again once you are connected.');
    clearSelection();
  }

  function handleInfoMessage() {
    if (!actions.canInfo) return;
    setInfoMessage(selectedMessages[0]);
    clearSelection();
  }

  return (
    <section className="conversation">
      {selectionActive ? (
        <header className="conversation-header wa-msg-selection-header">
          <div className="wa-sel-left">
            <button
              type="button"
              className="icon-button wa-sel-close"
              onClick={clearSelection}
              title="Close selection"
              aria-label="Close selection"
            >
              <X size={18} />
            </button>
            <span className="wa-sel-count" aria-live="polite">{actions.count}</span>
          </div>
          <div className="wa-sel-actions">
            {actions.canReply && (
              <button
                type="button"
                className="icon-button"
                onClick={() => startReply(selectedMessages[0])}
                title="Reply"
                aria-label="Reply"
              >
                <CornerUpLeft size={18} />
              </button>
            )}
            <button
              type="button"
              className="icon-button"
              onClick={starSelection}
              title={actions.allStarred ? 'Unstar' : 'Star'}
              aria-label={actions.allStarred ? 'Unstar' : 'Star'}
            >
              <Star size={18} fill={actions.allStarred ? 'currentColor' : 'none'} />
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={() => { setReactionTrayId(null); setForwardSource(selectedMessages); }}
              disabled={!actions.canForward}
              title="Forward"
              aria-label="Forward"
            >
              <Forward size={18} />
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={() => { setReactionTrayId(null); setDeleteTarget(selectedMessages); }}
              title="Delete"
              aria-label="Delete"
            >
              <Trash2 size={18} />
            </button>
            {actions.canInfo && (
              <button
                type="button"
                className="icon-button"
                onClick={handleInfoMessage}
                title="Info"
                aria-label="Info"
              >
                <Info size={18} />
              </button>
            )}
          </div>
        </header>
      ) : searchOpen ? (
        <header className="conversation-header wa-chat-search-header">
          <button type="button" className="icon-button" onClick={closeChatSearch} aria-label="Close search"><ArrowLeft size={18} /></button>
          <input
            autoFocus
            type="search"
            value={searchQuery}
            onChange={(event) => runChatSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') { event.preventDefault(); closeChatSearch(); }
              if (event.key === 'Enter') { event.preventDefault(); stepChatSearch(event.shiftKey ? -1 : 1); }
            }}
            placeholder="Search…"
            aria-label={`Search messages with ${chat.name ?? 'this contact'}`}
          />
          <span className="wa-chat-search-count" aria-live="polite">
            {searchQuery.trim() ? (searchMatches.length ? `${searchIndex + 1} of ${searchMatches.length}` : 'No results') : ''}
          </span>
          <button type="button" className="icon-button" onClick={() => stepChatSearch(1)} disabled={searchIndex >= searchMatches.length - 1} aria-label="Older match"><ChevronUp size={18} /></button>
          <button type="button" className="icon-button" onClick={() => stepChatSearch(-1)} disabled={searchIndex <= 0} aria-label="Newer match"><ChevronDown size={18} /></button>
        </header>
      ) : (
        <header className="conversation-header">
          <div
            className="conversation-person"
            role="button"
            tabIndex={0}
            aria-label={`Contact info for ${chat.name ?? 'this contact'}`}
            onClick={() => setContactInfoOpen(true)}
            onKeyDown={(event) => {
              if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault();
                setContactInfoOpen(true);
              }
            }}
          >
            <button type="button" className="mobile-back icon-button" onClick={(event) => { event.stopPropagation(); onBack?.(); }} aria-label="Back to chats"><ArrowLeft size={18} /></button>
            <Avatar name={chat.name} initials={chat.initials ?? chat.name?.slice(0, 2)?.toUpperCase() ?? '?'} color={chat.color} image={chat.avatar} online={!blocked && presence === 'online'} />
            <span>
              <strong>
                {presentName(chat) || 'Unknown contact'}
                {chat.disappearSeconds > 0 && <Timer size={13} className="conversation-timer" aria-label={`Disappearing messages: ${disappearingLabel(chat.disappearSeconds)}`} />}
              </strong>
              <small>
                {hasCustomDisplayName(chat) && <span className="conversation-handle">@{chat.username} · </span>}
                {blocked ? 'Blocked' : connection && connection !== 'online' && connection !== 'connected' ? [status, connection].filter(Boolean).join(' · ') : status}
              </small>
            </span>
          </div>
          <div className="conversation-actions">
            <button type="button" className="icon-button" onClick={() => onStartCall?.('video')} disabled={blocked} aria-label="Video call"><Video size={18} /></button>
            <button type="button" className="icon-button" onClick={() => onStartCall?.('audio')} disabled={blocked} aria-label="Voice call"><Phone size={18} /></button>
            {/* Secondary actions collapse into the ⋮ menu on narrow screens (see .header-action-secondary). */}
            <button type="button" className="icon-button header-action-secondary" onClick={openChatSearch} aria-label="Search messages"><Search size={18} /></button>
            <button type="button" className="icon-button header-action-secondary" onClick={onPair} aria-label="Pair a device"><Link2 size={18} /></button>
            <span className="header-menu-wrap">
              <button type="button" className="icon-button" onClick={() => setHeaderMenuOpen((open) => !open)} aria-label="More options" aria-expanded={headerMenuOpen} aria-haspopup="menu"><MoreVertical size={18} /></button>
              {headerMenuOpen && (
                <ul className="header-menu" role="menu" aria-label="Chat options">
                  {[
                    { id: 'new-group', label: 'New group', action: () => onGroups?.(true) },
                    { id: 'new-contact', label: 'New contact', action: () => setNewContactOpen(true) },
                    { id: 'search', label: 'Search', action: openChatSearch },
                    { id: 'media', label: 'Media, links and docs', action: () => openInfo('media') },
                    { id: 'mute', label: muted ? 'Unmute notifications' : 'Mute notifications', action: () => useChatStore.getState().toggleMuteChat(chatId) },
                    { id: 'disappearing', label: 'Disappearing messages', action: () => openInfo('disappearing') },
                    { id: 'theme', label: 'Chat theme', action: () => openInfo('theme') },
                    { id: 'pair', label: 'Pair a device', action: () => onPair?.() },
                    { id: 'info', label: 'View contact', action: () => openInfo('main') },
                  ].map((item) => (
                    <li key={item.id} role="none">
                      <button type="button" role="menuitem" className={item.hint ? 'is-placeholder' : ''} onClick={() => { setHeaderMenuOpen(false); item.action(); }}>
                        <span>{item.label}</span>
                        {item.hint && <small>{item.hint}</small>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </span>
          </div>
        </header>
      )}
      {headerNotice && <div className="header-notice" role="status">{headerNotice}</div>}

      <div className="conversation-banner">
        {chat.disappearSeconds > 0 ? (
          <span><Timer size={12} aria-hidden="true" /> Disappearing messages are on. New messages disappear from this chat after {disappearingLabel(chat.disappearSeconds)}.</span>
        ) : (
          <span>Messages are delivered through your Hidden Messenger workspace.</span>
        )}
      </div>

      <div
        className="message-scroll"
        data-chat-theme={chatTheme}
        ref={messageScrollRef}
        onScroll={syncScrollState}
        onWheel={cancelAutoScroll}
        onTouchMove={cancelAutoScroll}
        onClick={(event) => {
          // A tap outside the bubbles dismisses a single long-press (tray) selection; multi-select stays until closed.
          if (trayMessageId && !event.target.closest('.message-line')) clearSelection();
        }}
      >
        <div className="message-stack" ref={messageStackRef}>
          {messages.map((message) => {
            if (!message?.id) return null;
            const day = localDateKey(message.timestamp);
            const showDay = day !== lastDay;
            lastDay = day;

            return (
              <div className="message-day-group" key={message.id}>
                {showDay && <div className="day-divider"><span>{formatMessageDate(message.timestamp)}</span></div>}
                <MessageBubble
                  message={message}
                  mine={message.senderId === userId}
                  sessionToken={sessionToken}
                  sender={message.senderId === userId ? user : chat}
                  quote={quoteView(message.replyTo, userId, chat.name)}
                  selectionActive={selectionActive}
                  isSelected={selectedIds.includes(message.id)}
                  highlighted={highlightId === message.id}
                  onLongPress={handleLongPress}
                  onToggleSelect={handleToggleSelect}
                  onReact={(emoji) => reactTo(message, emoji)}
                  onOpenMedia={() => setViewerMessageId(message.id)}
                  onSwipeReply={message.content?.startsWith('call:') ? null : startReply}
                  onQuoteClick={showInChat}
                  reactionTrayOpen={trayMessageId === message.id}
                  onTrayReact={(emoji) => {
                    reactTo(message, emoji);
                    clearSelection();
                  }}
                  shared={sharedHandlers}
                />
              </div>
            );
          })}
          {uploadProgress && <PendingUpload upload={uploadProgress} onCancel={cancelUpload} />}
          {typing && <div className="typing-indicator"><span /><span /><span /></div>}
          <div ref={messagesEndRef} className="messages-end" aria-hidden="true" />
        </div>
      </div>

      {showJumpToLatest && (
        <button
          type="button"
          className="scroll-bottom"
          onClick={() => scrollToBottom('smooth')}
          aria-label={unseenCount > 0 ? `Scroll to ${unseenCount} new message${unseenCount === 1 ? '' : 's'}` : 'Scroll to latest message'}
        >
          <ChevronDown size={18} />
          {unseenCount > 0 && <span className="scroll-bottom-badge">{unseenCount > 99 ? '99+' : unseenCount}</span>}
        </button>
      )}

      {blocked ? (
        <div className="wa-blocked-composer">
          <button type="button" onClick={() => unblockChat(chatId)}>You blocked this contact. Tap to unblock.</button>
        </div>
      ) : (
      <form className="composer-wrap" onSubmit={handleSubmit}>
        {replyingTo && (() => {
          const quote = quoteView(replyingTo, userId, chat.name);
          return (
            <div className="wa-composer-reply-banner">
              <div className="wa-composer-reply-content">
                <strong>{quote.sender}</strong>
                <span>{quote.text}</span>
              </div>
              <button
                type="button"
                className="wa-composer-reply-close"
                onClick={() => setReplyingTo(null)}
                aria-label="Cancel reply"
              >
                <X size={16} />
              </button>
            </div>
          );
        })()}
        {recording ? (
          <VoiceRecorderBar onSend={handleVoiceSend} onCancel={handleVoiceCancel} onError={setError} allowViewOnce />
        ) : (
          <div className="composer-row">
            <div className="composer">
              <button type="button" className={`composer-icon${emojiOpen ? ' toggled' : ''}`} onClick={() => setEmojiOpen((open) => !open)} aria-label="Emoji" aria-expanded={emojiOpen} disabled={busy}><Smile size={20} /></button>
              <input ref={composerInputRef} value={text} onChange={handleTextChange} placeholder="Message" maxLength={COMPOSER_MAX_LENGTH} />
              <button type="button" className="composer-icon" onClick={() => setMenuOpen(true)} aria-label="Attach" disabled={busy}><Paperclip size={20} /></button>
              {action === 'voice' && (
                <button type="button" className="composer-icon composer-camera" onClick={() => openFilePicker('image/*,video/*', 'environment')} aria-label="Camera" disabled={busy}><Camera size={20} /></button>
              )}
            </div>
            {action === 'send' ? (
              <button type="submit" className="composer-fab" aria-label="Send"><Send size={20} /></button>
            ) : (
              <button type="button" className="composer-fab" onClick={() => { setError(''); setEmojiOpen(false); setRecording(true); }} aria-label="Record voice note" disabled={busy}><Mic size={20} /></button>
            )}
          </div>
        )}
        {emojiOpen && !recording && (
          <div className="composer-emoji-tray" role="listbox" aria-label="Emoji">
            {COMPOSER_EMOJIS.map((emoji) => (
              <button type="button" key={emoji} role="option" aria-selected="false" onClick={() => insertEmoji(emoji)} aria-label={`Insert ${emoji}`}>{emoji}</button>
            ))}
          </div>
        )}
        {error && <span className="attachment-error">{error}</span>}
        <input ref={fileInputRef} type="file" hidden onChange={handleFileChange} />
      </form>
      )}

      {contactInfoOpen && (
        <ContactInfoDrawer
          chat={chat}
          messages={messages}
          status={status}
          client={client}
          initialView={contactInfoView}
          onClose={() => setContactInfoOpen(false)}
          onStartCall={onStartCall}
          onSearch={openChatSearch}
          onOpenMedia={setViewerMessageId}
          onShowMessage={showInChat}
          onChatDeleted={onBack}
        />
      )}

      <AttachmentMenu isOpen={menuOpen} onSelect={handleAttachmentSelect} onClose={() => setMenuOpen(false)} />
      <SelectContactModal
        isOpen={newContactOpen}
        onNewGroup={() => onGroups?.(true)}
        onClose={() => setNewContactOpen(false)}
        onSelectContact={(contact) => { useChatStore.getState().addContact(contact); setNewContactOpen(false); }}
      />
      {picker === 'location' && <LocationPicker onSendLocation={handleLocation} onShareLive={handleShareLive} onClose={() => setPicker(null)} />}
      {picker === 'contact' && <ContactSharePicker contacts={shareable} onSelect={handleContact} onClose={() => setPicker(null)} />}
      {picker === 'poll' && <PollComposer onSend={(content) => { sendContent(content); setPicker(null); }} onClose={() => setPicker(null)} />}
      {picker === 'event' && <EventComposer onSend={(content) => { sendContent(content); setPicker(null); }} onClose={() => setPicker(null)} />}
      {mapView && <MapView location={mapView.location} sessionId={mapView.sessionId} peer={chat} send={sharedHandlers.send} onClose={() => setMapView(null)} />}
      {viewerMessage && (
        <MediaViewer
          message={viewerMessage}
          items={mediaMessages}
          sessionToken={sessionToken}
          senderName={viewerMessage.senderId === userId ? 'You' : (chat.name ?? 'Contact')}
          starred={Boolean(viewerMessage.starred)}
          myReaction={(viewerMessage.reactions ?? []).find((reaction) => reaction.userId === userId)?.emoji ?? null}
          onNavigate={setViewerMessageId}
          onClose={() => setViewerMessageId(null)}
          onReact={(emoji) => reactTo(viewerMessage, emoji)}
          onReply={(text) => replyFromViewer(viewerMessage, text)}
          onStar={() => toggleStar(chatId, viewerMessage.id)}
          onForward={() => setForwardSource([viewerMessage])}
          onDelete={() => setDeleteTarget([viewerMessage])}
          onShowInChat={() => showInChat(viewerMessage.id)}
          onSendEdited={sendEditedMedia}
        />
      )}
      {forwardSource && (
        <ForwardPickerModal
          chats={chats}
          userId={userId}
          onSend={handleForwardMessage}
          onClose={closeForwardPicker}
        />
      )}
      {deleteTarget && (
        <DeleteMessageModal
          messages={deleteTarget}
          userId={userId}
          onConfirm={confirmDelete}
          onClose={() => setDeleteTarget(null)}
        />
      )}
      {infoMessage && (
        <div className="modal-overlay" onClick={() => setInfoMessage(null)}>
          <div className="attach-picker wa-msg-info-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Message info</h3>
              <button type="button" className="modal-close" onClick={() => setInfoMessage(null)} aria-label="Close">
                <X size={18} />
              </button>
            </div>
            <div className="wa-msg-info-body">
              <div className="wa-msg-info-row">
                <span className="wa-msg-info-label">Status</span>
                <span className="wa-msg-info-value">{infoMessage.status || 'Delivered'}</span>
              </div>
              <div className="wa-msg-info-row">
                <span className="wa-msg-info-label">Sent at</span>
                <span className="wa-msg-info-value">{new Date(infoMessage.timestamp).toLocaleString()}</span>
              </div>
              <div className="wa-msg-info-row">
                <span className="wa-msg-info-label">From</span>
                <span className="wa-msg-info-value">{infoMessage.senderId === userId ? 'You' : (chat.name || 'Contact')}</span>
              </div>
              {infoMessage.reactions && infoMessage.reactions.length > 0 && (
                <div className="wa-msg-info-reactions">
                  <span className="wa-msg-info-label">Reactions</span>
                  <div className="wa-msg-info-reaction-list">
                    {infoMessage.reactions.map((r, i) => (
                      <span key={i} className="wa-msg-info-reaction-chip">
                        {r.emoji} {r.userId === userId ? 'You' : ''}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
