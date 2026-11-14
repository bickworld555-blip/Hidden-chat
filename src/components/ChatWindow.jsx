import { storeMedia } from '../mediaVault.js';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { isEnvelope, STRUCTURED } from '../e2e/envelope.js';
import { sendControlFor, transmitDirect, transmitReaction } from '../e2e/messaging.js';
import { buildLinkPreview } from '../linkPreviewSender.js';
import { translate, useLanguage } from '../i18n.js';
import { contactEncrypted } from '../e2e/client.js';
import { isNotice, noticeText } from '../e2e/notices.js';
import { isMediaContent, primeMediaBlob } from '../media.js';
import { LOAD_OLDER_STEP, RENDER_WINDOW, renderCountFor, windowedMessages } from '../messageWindow.js';
import { attachmentContent, sealForUpload } from '../mediaCrypto.js';
import { ArrowLeft, Ban, Camera, Check, CheckCheck, ChevronDown, ChevronUp, Clock, CornerUpLeft, FileText, Forward, Image as ImageIcon, Info, Link2, Mic, MoreVertical, Paperclip, Pencil, Phone, Pin, PinOff, Search, Send, Share2, ShoppingCart, Smile, Star, Timer, Trash2, Video, X } from 'lucide-react';
import { parseVoiceContent, voiceContent, voiceExtension } from '../voice.js';
import { resolveVoiceLanguage } from '../voiceLanguage.js';
import { COMPOSER_EMOJIS, COMPOSER_MAX_LENGTH, composerAction, insertAtCaret } from '../composer.js';
import { playNotificationTone } from '../sounds.js';
import { EMPTY_MESSAGES, deletedLabel, previewFor, useChatStore } from '../store.js';
import { isBlocked } from '../blocking.js';
import { searchMessages } from '../contactInfo.js';
import { disappearingLabel } from '../disappearing.js';
import { uploadFile, uploadSizeError } from '../upload.js';
import { FORWARD_LIMIT, forwardSections } from '../forwarding.js';
import { quoteView, replyQuoteFor, resolveQuote, statusQuoteView } from '../replies.js';
import { resolveSelection, selectionActions, toggleSelection } from '../selection.js';
import { EXTENDED_REACTIONS as EXTENDED_EMOJIS, QUICK_REACTIONS as QUICK_EMOJIS } from '../reactions.js';
import { formatMessageDate, formatMessageTime, localDateKey } from '../time.js';
import Avatar from './Avatar.jsx';
import AttachmentMenu from './AttachmentMenu.jsx';
import SelectContactModal from './SelectContactModal.jsx';
import { ContactBubble, LiveLocationBubble, LocationBubble } from './LocationMessages.jsx';
import { contactContent, liveContent, locationContent, messageKind, parseContact, parseLive, parseLocation } from '../geo.js';
import { presentName } from '../profile.js';
import CallStatusBubble from './CallStatusBubble.jsx';
import LinkPreview from './LinkPreview.jsx';
import { OrderBubble, OrderComposer } from './OrderMessages.jsx';
import { orderStatusLabel, parseOrder, parseOrderStatus } from '../orders.js';
import { CustomStickerBubble, MediaOpenedBubble, StickerMaker, VideoNoteBubble, VideoNoteRecorder, ViewOnceMediaBubble, ViewOnceViewerHost } from './MediaExtras.jsx';
import { CUSTOM_STICKER_PREFIX, VIDEO_NOTE_PREFIX, VIEW_ONCE_PREFIX, isCustomSticker, isMediaOpened, isVideoNote, isViewOnceMedia } from '../mediaExtras.js';
import { firstLink } from '../links.js';
import MediaRenderer, { MediaAlbum } from './MediaRenderer.jsx';
import { lazyComponent } from '../lazy.js';
import { useBackHandler } from '../backStack.js';
import { nativeClearMessageNotifications, nativeShell } from '../native.js';
const LocationPicker = lazyComponent(() => import('./LocationPicker.jsx'));
const MapView = lazyComponent(() => import('./LocationMap.jsx'), (module) => module.MapView);
const ContactInfoDrawer = lazyComponent(() => import('./ContactInfoDrawer.jsx'));
const MediaViewer = lazyComponent(() => import('./MediaViewer.jsx'));
import VoiceMessage from './VoiceMessage.jsx';
import LinkText from './LinkText.jsx';
import FormattedText from './FormattedText.jsx';
import ComposerMirror from './ComposerMirror.jsx';
import { hasFormatting } from '../textFormat.js';
import { useWallpaper } from '../wallpaper.js';
import { enterSends } from '../enterSends.js';
import { cartCount, useCart } from '../cart.js';
import VoiceRecorderBar from './VoiceRecorderBar.jsx';
import { presenceLine } from '../presence.js';
import PendingUpload from './PendingUpload.jsx';
import MediaComposer from './MediaComposer.jsx';
import { makeThumb, videoPreview } from '../mediaThumb.js';
import { EventBubble, EventComposer, PollBubble, PollComposer, ViewOnceVoice } from './RichMessages.jsx';
import { parseScheduledCall } from '../groupChat.js';
import CameraCapture from './CameraCapture.jsx';

// A call scheduled from Calls › Schedule (the same card groups use): its name, when, and a button to start it.
function ScheduledCallBubble({ call, onStart, children }) {
  const when = new Date(call.at);
  return (
    <div className="groups-scheduled-card scheduled-call-bubble">
      <span className="groups-scheduled-icon" aria-hidden="true">{call.mode === 'video' ? <Video size={22} /> : <Phone size={22} />}</span>
      <span><strong>{call.title}</strong><small>{call.mode === 'video' ? 'Video call' : 'Voice call'} · {when.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</small></span>
      <button type="button" onClick={onStart}>{call.at > Date.now() ? 'Start early' : 'Start call'}</button>
      {children}
    </div>
  );
}
import { parsePollContent } from '../polls.js';
import { parseEventContent } from '../calendarEvents.js';
import { editDirectMessage } from '../parityApi.js';
import { loadPins, setMessagePinned, useAccountData } from '../accountData.js';
import { appSettings } from '../settings.js';
import { prepareForSend } from '../mediaQuality.js';
import { isStickerContent, stickerContent } from '../stickers.js';
import { activityLabel, createActivitySender } from '../typing.js';
import { StickerMessage, StickerPalette } from './parity/Stickers.jsx';
import { ComposerAssist } from './parity/ComposerAssist.jsx';
import PinnedBanner from './parity/PinnedBanner.jsx';
import { ProductCard, parseProductContent, productContent } from './parity/ProductCard.jsx';
import VerifiedBadge from './VerifiedBadge.jsx';
import { keepKeyboard } from '../keyboard.js';
const CatalogPicker = lazyComponent(() => import('./parity/CatalogPicker.jsx'));

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

// A text message with a link gets WhatsApp's preview card above it. A message that is only the link shows the card
// alone once it has loaded (the address is on the card); without a preview the link text stays.
const bareLink = (value) => value.trim().replace(/^https?:\/\//i, '').replace(/\/$/, '');
// The time and ticks sit at the end of the text's last line, like WhatsApp (its ConversationRowFooterContainer):
// an invisible copy of the footer (pin, star, Edited, time, ticks) ends the text, so the reserved room always
// matches what is shown, and the real footer is pinned to the bottom-right corner over it. When the last line is
// too full the spacer wraps to a line of its own, so the footer never covers the text.
// The card comes with the message (made by the sender); only old unencrypted messages still ask the server.
function TextWithPreview({ content, sessionToken, meta, message, mine = false, peerName = '', peerColor = 'blue' }) {
  const href = firstLink(content);
  const card = href ? <LinkPreview href={href} sessionToken={sessionToken} preview={message?.linkPreview ?? null} fetchAllowed={!message?.e2e} /> : null;
  // A reply to a status quotes it (the quote travels inside the encryption): a card with whose status it was, what it
  // said and a small tile of it, as on WhatsApp.
  const quote = message?.statusReply ? <StatusQuoteCard view={statusQuoteView(message.statusReply, { mine, peerName, content })} accent={mine ? peerColor : 'self'} /> : null;
  const onlyLink = Boolean(href) && bareLink(content) === bareLink(href);
  if (onlyLink) {
    return (
      <>
        {quote}
        {card}
        <p className="link-preview-url"><LinkText text={content} /></p>
        {meta}
      </>
    );
  }
  return (
    <>
      {quote}
      {card}
      <div className="text-with-meta">
        <p><FormattedText text={content} /><span className="meta-spacer" aria-hidden="true">{meta}</span></p>
        {meta}
      </div>
    </>
  );
}

function StatusQuoteCard({ view, accent }) {
  if (!view) return null;
  return (
    <div className="wa-quoted-reply-preview status-reply-quote" data-accent={accent}>
      <span className="wa-quoted-body">
        <span className="wa-quoted-sender">{view.title}</span>
        <span className="wa-quoted-text">{view.text}</span>
      </span>
      <span className={`status-quote-tile is-${view.kind}`} style={view.background ? { background: view.background } : undefined} aria-hidden="true">
        {view.kind === 'image' ? <ImageIcon size={18} /> : view.kind === 'video' ? <Video size={18} /> : view.kind === 'file' ? <FileText size={18} /> : <span>{view.text.slice(0, 18)}</span>}
      </span>
      {view.reaction && <span className="status-reply-reacted">{view.ownerIsMe ? 'Reacted to your status' : 'You reacted to their status'}</span>}
    </div>
  );
}

function MessageStatus({ status }) {
  if (status === 'read') return <CheckCheck size={12} className="read-check" aria-label="Read" />;
  if (status === 'delivered') return <CheckCheck size={12} aria-label="Delivered" />;
  if (status === 'failed') return <X size={12} aria-label="Failed" />;
  if (status === 'waiting') return <Clock size={12} className="waiting-check" aria-label="Waiting to be sent encrypted" />;
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
  // Photos and videos sent together (message.album): all of them, in order, drawn as one bubble here.
  album = null,
  onOpenAlbumItem,
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
  const isMedia = isMediaContent(content);
  const sharedKind = messageKind(content);
  const poll = parsePollContent(content);
  const event = parseEventContent(content);
  const productId = parseProductContent(content);
  const scheduledCall = parseScheduledCall(content);

  const meta = (
    <span className="message-meta">
      {shared?.pinnedIds?.has(message?.id) && <Pin size={11} className="message-pin" aria-label="Pinned" />}
      {message?.starred && <Star size={11} className="message-star" fill="currentColor" aria-label="Starred" />}
      {message?.editedAt && !message.deleted && <span className="message-edited">{translate('Edited')}</span>}
      {message?.unencrypted && !message.deleted && <span className="message-unencrypted" title="Not end-to-end encrypted">{translate('Not encrypted')}</span>}
      <time>{time}</time>
      {mine && <MessageStatus status={message?.status} />}
    </span>
  );

  // Plain text (and links) carry their own time at the end of the last line; other bubbles show it below.
  const textBody = !isMedia && !(sharedKind === 'location' && parseLocation(content)) && !(sharedKind === 'live' && parseLive(content))
    && !(sharedKind === 'contact' && parseContact(content));

  const reactions = Array.isArray(message?.reactions) ? message.reactions : [];
  // Group reactions by emoji and count
  const reactionCounts = reactions.reduce((acc, r) => {
    acc[r.emoji] = (acc[r.emoji] || 0) + 1;
    return acc;
  }, {});

  const isCall = content.startsWith('call:');
  // WhatsApp's round forward button beside photos, videos, documents and voice notes (not view once).
  const quickForward = Boolean(shared?.forward) && !selectionActive && !message.deleted && message.status !== 'failed'
    && (isMedia || (isVoice && !voice?.viewOnce));

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

      {isNotice(content) ? (
        <p className="chat-notice"><span aria-hidden="true">🔒</span> {noticeText(content, shared.peerName)}</p>
      ) : isCall ? (
        <CallStatusBubble callData={parseCall(content)} isOutgoing={mine} timestamp={time} onCallBack={selectionActive ? undefined : shared.callBack} />
      ) : message.e2eError || isEnvelope(content) ? (
        // End-to-end encrypted and not readable on this device (no cipher yet, or a missing key): never show
        // ciphertext, like WhatsApp's "Waiting for this message".
        <div className={`message-bubble ${mine ? 'outgoing' : 'incoming'} deleted-bubble encrypted-bubble`}>
          <p className="deleted-text"><span aria-hidden="true">🔒</span><span>Waiting for this message. It is end-to-end encrypted.</span></p>
          {meta}
        </div>
      ) : message.deleted ? (
        <div className={`message-bubble ${mine ? 'outgoing' : 'incoming'} deleted-bubble`}>
          <p className="deleted-text"><Ban size={15} aria-hidden="true" /><span>{deletedLabel(mine)}</span></p>
          {meta}
        </div>
      ) : isStickerContent(content) ? (
        <StickerMessage content={content}>{meta}</StickerMessage>
      ) : parseOrder(content) ? (
        <div className={`message-bubble ${mine ? 'outgoing' : 'incoming'} attachment-bubble`}><OrderBubble message={message} mine={mine} peerId={mine ? message.receiverId : message.senderId} onStatus={(update) => update && shared.sendText?.(update)}>{meta}</OrderBubble></div>
      ) : parseOrderStatus(content) ? (
        <p className="chat-notice">🛒 {mine ? 'You marked the order' : 'Order'} {orderStatusLabel(parseOrderStatus(content).status).toLowerCase()}{parseOrderStatus(content).note ? ` · ${parseOrderStatus(content).note}` : ''}</p>
      ) : isCustomSticker(content) ? (
        <CustomStickerBubble content={content} sessionToken={sessionToken}>{meta}</CustomStickerBubble>
      ) : isVideoNote(content) ? (
        <VideoNoteBubble content={content} sessionToken={sessionToken}>{meta}</VideoNoteBubble>
      ) : isViewOnceMedia(content) ? (
        <div className={`message-bubble ${mine ? 'outgoing' : 'incoming'}`}><ViewOnceMediaBubble message={message} mine={mine} sessionToken={sessionToken}>{meta}</ViewOnceMediaBubble></div>
      ) : isMediaOpened(content) ? (
        <div className={`message-bubble ${mine ? 'outgoing' : 'incoming'}`}><MediaOpenedBubble>{meta}</MediaOpenedBubble></div>
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
              data-accent={quote.self ? 'self' : (shared?.peerColor ?? 'blue')}
              aria-label={`Reply to ${quote.sender}: ${quote.text}. Show the original message`}
              onClick={() => {
                if (message.replyTo?.id) onQuoteClick?.(message.replyTo.id);
              }}
            >
              <span className="wa-quoted-body">
                <span className="wa-quoted-sender">{quote.sender}</span>
                <span className="wa-quoted-text">{quote.text}</span>
              </span>
              {quote.thumb && <img className="wa-quoted-thumb" src={quote.thumb} alt="" />}
            </button>
          )}
          {voice?.viewOnce ? (
            <ViewOnceVoice messageId={message.id} seconds={voice.seconds} opened={voice.opened} mine={mine} sessionToken={sessionToken} descriptor={voice.descriptor ?? null}>{meta}</ViewOnceVoice>
          ) : isVoice ? (
            <VoiceMessage
              id={voice.id}
              seconds={voice.seconds}
              lang={voice.lang}
              sessionToken={sessionToken}
              sender={sender}
              played={Boolean(message.played)}
              forwarded={Boolean(message?.forwarded)}
              onPlayed={mine ? undefined : () => {
                // Over XMPP the sender's devices hear it end to end; otherwise the server tells them.
                if (!sendControlFor(message, { op: 'played' })) shared.send?.({ type: 'message:played', messageId: message.id });
                useChatStore.getState().updateMessage(message.id, { played: true, status: 'read' });
              }}
            >{meta}</VoiceMessage>
          ) : scheduledCall ? (
            <ScheduledCallBubble call={scheduledCall} onStart={() => shared.callBack?.(scheduledCall.mode)}>{meta}</ScheduledCallBubble>
          ) : poll ? (
            <PollBubble messageId={message.id} poll={poll} sessionToken={sessionToken} userId={shared.userId} nameFor={shared.nameFor} context={shared.pollContext}>{meta}</PollBubble>
          ) : event ? (
            <EventBubble messageId={message.id} event={event}>{meta}</EventBubble>
          ) : productId ? (
            <ProductCard itemId={productId} sessionToken={sessionToken}>{meta}</ProductCard>
          ) : (
            <>
              {isMedia && album?.length > 1 ? <MediaAlbum items={album} sessionToken={sessionToken} onOpen={onOpenAlbumItem} meta={meta} caption={album.find((item) => item.caption)?.caption ?? ''} />
                : isMedia ? <MediaRenderer mediaRef={content} sessionToken={sessionToken} onOpen={onOpenMedia} meta={meta} caption={message.caption} thumb={message.thumb} poster={message.poster} duration={message.duration} />
                : sharedKind === 'location' && parseLocation(content) ? <LocationBubble location={parseLocation(content)} onOpen={shared.openLocation} />
                : sharedKind === 'live' && parseLive(content) ? <LiveLocationBubble live={parseLive(content)} mine={mine} peerName={shared.peerName} send={shared.send} onOpen={shared.openLive} />
                : sharedKind === 'contact' && parseContact(content) ? <ContactBubble contact={parseContact(content)} onMessage={shared.messageContact} />
                : <TextWithPreview content={content} sessionToken={sessionToken} meta={meta} message={message} mine={mine} peerName={shared?.peerName} peerColor={shared?.peerColor} />}
              {!textBody && !isMedia && meta}
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
      {quickForward && (
        <button
          type="button"
          className="wa-quick-forward"
          onClick={(clickEvent) => { clickEvent.stopPropagation(); shared.forward(message); }}
          aria-label="Forward"
          title="Forward"
        >
          <Forward size={17} />
        </button>
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

// Older messages are added when the user scrolls within this distance of the top (see src/messageWindow.js).
const LOAD_OLDER_THRESHOLD_PX = 600;

// Voice-note mic gesture (px / ms).
const VOICE_LOCK_PX = 90;
const VOICE_CANCEL_PX = 130;
const VOICE_TAP_MS = 300;
const VOICE_MIN_HOLD_MS = 1000;

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
  const readChat = useChatStore((state) => state.readChat);
  const queueMessage = useChatStore((state) => state.queueMessage);

  const deleteMessage = useChatStore((state) => state.deleteMessage);
  const toggleReaction = useChatStore((state) => state.toggleReaction);
  const toggleStar = useChatStore((state) => state.toggleStar);
  const setActiveChat = useChatStore((state) => state.setActiveChat);
  const blocked = useChatStore((state) => (chatId ? isBlocked(state.blockedChats[chatId]) : false));
  const chatTheme = useChatStore((state) => (chatId ? state.chatThemes[chatId] : undefined)) ?? 'default';
  const wallpaper = useWallpaper();
  // A cart with this business (cart.js): its icon and count show in the header until the order is sent.
  const cartItems = cartCount(useCart(chatId));
  const unblockChat = useChatStore((state) => state.unblockChat);

  const [text, setText] = useState('');
  // A short link's suggested message (store composerDraft) fills the box once.
  useEffect(() => { const draft = useChatStore.getState().takeComposerDraft(chatId); if (draft) setText(draft); }, [chatId]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [picker, setPicker] = useState(null);
  const [error, setError] = useState('');
  const [uploads, setUploads] = useState([]);
  // The send preview (src/components/MediaComposer.jsx): { files, viewOnce, documents } while open.
  const [composer, setComposer] = useState(null);
  const [composerAdded, setComposerAdded] = useState(null);
  const [recording, setRecording] = useState(false);
  // While the mic is held: the finger's offset ({ x, y }); null when not held (tapped, or slid up to lock).
  const [voiceHold, setVoiceHold] = useState(null);
  const recorderRef = useRef(null);
  const holdCleanupRef = useRef(null);
  useEffect(() => () => holdCleanupRef.current?.(), []);

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
  const [contactInfoDialog, setContactInfoDialog] = useState(null);
  const openInfo = (view, dialog = null) => { setContactInfoView(view); setContactInfoDialog(dialog); setContactInfoOpen(true); };

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
  // Composer tray tab (emoji / stickers), the message being edited, and the caret (for quick-reply suggestions).
  const [trayTab, setTrayTab] = useState('emoji');
  const [editing, setEditing] = useState(null);
  const [caret, setCaret] = useState(0);
  const pickKindRef = useRef('media');
  const action = composerAction(text);

  const fileInputRef = useRef(null);
  const composerInputRef = useRef(null);
  const messageScrollRef = useRef(null);
  const messageStackRef = useRef(null);
  const messagesEndRef = useRef(null);
  const activityRef = useRef(null);

  // Auto-scroll state: the feed stays pinned to the newest message unless the user scrolls up to read history.
  const stickToBottomRef = useRef(true);
  const autoScrollingRef = useRef(false);
  const autoScrollTimerRef = useRef(null);
  const latestSeenMessageIdRef = useRef(null);
  const openedAtRef = useRef(0);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [unseenCount, setUnseenCount] = useState(0);

  // Long chats render only their newest messages (WhatsApp's list only has the rows on screen); older ones are
  // added as the user scrolls up, and the view stays exactly where it was while they are added above it.
  const [renderCount, setRenderCount] = useState(RENDER_WINDOW);
  const olderAnchorRef = useRef(null);
  const visibleMessages = useMemo(() => windowedMessages(messages, renderCount), [messages, renderCount]);
  const hiddenOlder = messages.length - visibleMessages.length;

  // Whether this contact can receive end-to-end encrypted messages (a device with keys): false shows a warning.
  const [encryption, setEncryption] = useState(null);
  useEffect(() => {
    let cancelled = false;
    setEncryption(null);
    if (chatId) contactEncrypted(chatId).then((value) => { if (!cancelled) setEncryption(value); }).catch(() => {});
    return () => { cancelled = true; };
  }, [chatId]);
  const language = useLanguage((state) => state.language);
  const olderOnDevice = useChatStore((state) => Boolean(chatId && state.olderOnDevice?.[chatId]));
  const loadingFromDeviceRef = useRef(false);
  const loadOlderIfNearTop = useCallback(() => {
    const container = messageScrollRef.current;
    if (!container || olderAnchorRef.current !== null) return;
    if (container.scrollTop > LOAD_OLDER_THRESHOLD_PX) return;
    // Everything in memory is on screen: read the next older page from this device's message store.
    if (hiddenOlder <= 0) {
      if (!olderOnDevice || loadingFromDeviceRef.current) return;
      loadingFromDeviceRef.current = true;
      olderAnchorRef.current = container.scrollHeight - container.scrollTop;
      useChatStore.getState().loadOlderMessages(chatId)
        .then((added) => {
          if (added) setRenderCount((count) => count + Math.min(added, LOAD_OLDER_STEP));
          else olderAnchorRef.current = null;
        })
        .catch(() => { olderAnchorRef.current = null; })
        .finally(() => { loadingFromDeviceRef.current = false; });
      return;
    }
    // Remember the distance from the bottom: after the older rows are added above, the same distance means the
    // same messages are still on screen (the job of WhatsApp's pre-draw listener).
    olderAnchorRef.current = container.scrollHeight - container.scrollTop;
    setRenderCount((count) => count + LOAD_OLDER_STEP);
  }, [hiddenOlder, olderOnDevice, chatId]);

  useLayoutEffect(() => {
    const container = messageScrollRef.current;
    if (!container || olderAnchorRef.current === null) return;
    container.scrollTop = container.scrollHeight - olderAnchorRef.current;
    olderAnchorRef.current = null;
  }, [renderCount]);

  /** Makes sure a message is rendered (search, a tapped quote, "show in chat") before scrolling to it. */
  const ensureRendered = useCallback((messageId) => {
    const needed = renderCountFor(messages, messageId);
    if (needed > 0) setRenderCount((count) => (needed > count ? needed : count));
  }, [messages]);

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
    let containerHeight = container.clientHeight;
    const observer = new ResizeObserver(() => {
      // The feed area itself got shorter or taller (keyboard opening or closing): stay on the newest message at
      // once, like WhatsApp, rather than gliding after it while the keyboard slides.
      const resized = container.clientHeight !== containerHeight;
      containerHeight = container.clientHeight;
      if (!stickToBottomRef.current) return;
      const justOpened = performance.now() - openedAtRef.current < OPEN_SETTLE_MS;
      if (justOpened || resized) pinToBottom();
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
    readChat(chatId);
    // Read on screen: its Android notification (and its share of the icon badge) goes away.
    if (nativeShell()) nativeClearMessageNotifications(`chat:${chatId}`);
  }, [messages, chatId, readChat, pageVisible]);

  // "typing…" / "recording audio…" for the person in this chat: one sender per open chat, stopped when the chat
  // closes or the app goes to the background; a voice note in progress (`recording`) keeps "recording audio…" alive.
  const isDeletedChat = Boolean(chat?.deleted);
  useEffect(() => {
    if (!chatId || isDeletedChat) return undefined;
    const sender = createActivitySender((event) => client?.send?.(event), { peerId: chatId });
    activityRef.current = sender;
    return () => {
      sender.stop();
      if (activityRef.current === sender) activityRef.current = null;
    };
  }, [chatId, client, isDeletedChat]);
  useEffect(() => { activityRef.current?.recording(recording); }, [recording, chatId, client, isDeletedChat]);
  useEffect(() => { if (!pageVisible && activityRef.current?.kind === 'typing') activityRef.current.stop(); }, [pageVisible]);

  const mediaMessages = useMemo(() => messages.filter((message) => message?.id && isMediaContent(message.content)), [messages]);
  // A deleted message (by either side) closes its viewer because it is no longer found.
  const viewerMessage = viewerMessageId ? mediaMessages.find((message) => message.id === viewerMessageId) ?? null : null;

  // Resolved against live messages so deleted or replaced messages drop out and selection mode ends on its own.
  const selectedMessages = useMemo(() => resolveSelection(messages, selectedIds), [messages, selectedIds]);
  const selectionActive = selectedMessages.length > 0;
  const trayMessageId = selectedMessages.length === 1 && selectedMessages[0].id === reactionTrayId ? reactionTrayId : null;
  const actions = selectionActions(selectedMessages, userId);
  // Pinned messages are shared by both people (server/parity.mjs); loaded when the chat opens, refreshed by events.
  const pins = useAccountData((state) => (chatId ? state.pins[chatId] : null));
  const pinnedIds = useMemo(() => new Set((pins ?? []).map((pin) => pin.messageId)), [pins]);
  useEffect(() => {
    if (chatId && sessionToken) loadPins(chatId).catch(() => {});
  }, [chatId, sessionToken]);
  useEffect(() => { setEditing(null); }, [chatId]);

  const clearSelection = useCallback(() => {
    setSelectedIds([]);
    setReactionTrayId(null);
  }, []);

  useEffect(() => {
    setRenderCount(RENDER_WINDOW);
    olderAnchorRef.current = null;
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
    // Nothing to react to in a deleted message (WhatsApp offers only Delete for me).
    setReactionTrayId(message.deleted ? null : message.id);
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
    // A link gets its preview made here, on the sender's device, and sent inside the encryption (WhatsApp-style).
    const href = !extras.forwarded && typeof content === 'string' && !STRUCTURED.test(content) ? firstLink(content) : null;
    const preview = href ? buildLinkPreview(href, sessionToken).catch(() => null) : Promise.resolve(null);
    preview.then((linkPreview) => {
      if (linkPreview) {
        updateMessage(message.id, { linkPreview });
        queueMessage?.({ ...message, linkPreview });
      }
      // Sealed for every device of the contact and this account's other devices (src/e2e/messaging.js).
      return transmitDirect(client, { id: message.id, receiverId, content, ...extras, ...(linkPreview ? { linkPreview } : {}) });
    }).then((accepted) => { if (!accepted) updateMessage(message.id, { status: 'failed' }); });
  }, [userId, client, addMessage, queueMessage, updateMessage, sessionToken]);

  // extras: what travels with it inside the end-to-end encryption (caption, album, thumbnail).
  const sendContent = useCallback((content, customReplyTo = null, extras = {}) => {
    if (!chatId || !content) return;
    // Privacy › Default message timer: the first message of a chat you start turns on disappearing messages.
    const defaultTimer = Number(appSettings().get('privacy.defaultTimer')) || 0;
    if (defaultTimer > 0 && messages.length === 0 && !chat?.disappearSeconds && client?.send?.({ type: 'chat:disappearing', peerId: chatId, seconds: defaultTimer })) {
      useChatStore.getState().setDisappearing(chatId, defaultTimer);
    }
    const replyTo = customReplyTo ?? replyingTo;
    sendToChat(chatId, content, { ...(replyTo ? { replyTo } : {}), ...extras });
    playNotificationTone('sent');
    if (!customReplyTo && replyingTo) setReplyingTo(null);
  }, [chatId, sendToChat, replyingTo, messages.length, chat?.disappearSeconds, client]);

  const closeForwardPicker = useCallback(() => setForwardSource(null), []);

  // --- Sending attachments, as on WhatsApp ---------------------------------------------------------------------
  // Every picked item shows at once as an outgoing bubble with its own progress ring (photos and videos preview from
  // the local file). Up to UPLOAD_PARALLEL upload at the same time; the messages still go out in the order picked.
  // Typing, recording and sending other messages stay possible meanwhile.
  const UPLOAD_PARALLEL = 3;
  const uploadSlotsRef = useRef({ running: 0, waiting: [] });
  const uploadControllersRef = useRef(new Map());
  const sendOrderRef = useRef(Promise.resolve());

  function withUploadSlot(task) {
    const slots = uploadSlotsRef.current;
    return new Promise((resolve, reject) => {
      const start = () => {
        slots.running += 1;
        task().then(resolve, reject).finally(() => {
          slots.running -= 1;
          slots.waiting.shift()?.();
        });
      };
      if (slots.running < UPLOAD_PARALLEL) start();
      else slots.waiting.push(start);
    });
  }

  const patchUpload = (key, patch) => setUploads((list) => list.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)));

  /**
   * Queues one attachment. `prepare` (optional) turns the picked file into what is sent (compression, a thumbnail);
   * `extras` (caption, album, thumb…) travel inside the end-to-end encrypted message.
   */
  function uploadAndSend(blob, filename, kind = 'media', seconds, { prepare = null, extras = {} } = {}) {
    if (!sessionToken) {
      setError('Sign in again to share attachments.');
      return Promise.resolve();
    }
    const type = blob.type || '';
    const isVoiceNote = kind === 'voice' || kind === 'voice-once';
    const previewKind = isVoiceNote ? 'voice' : type.startsWith('image/') ? 'image' : type.startsWith('video/') ? 'video' : 'file';
    const previewUrl = previewKind === 'image' ? URL.createObjectURL(blob) : '';
    // A video shows its own frame in the bubble at once (as on WhatsApp), not a dark placeholder: one decode gives the
    // poster, the micro thumbnail and the length, which also travel to the receiver (view once and video notes excepted).
    const previewJob = previewKind === 'video' ? videoPreview(blob) : null;
    const key = crypto.randomUUID();
    const controller = new AbortController();
    uploadControllersRef.current.set(key, controller);
    setUploads((list) => [...list, { key, filename, kind: previewKind, previewUrl, sent: 0, total: blob.size, caption: extras.caption ?? '', preparing: Boolean(prepare) }]);
    scrollToBottom('smooth');
    setError('');
    previewJob?.then((preview) => patchUpload(key, {
      poster: preview.poster || preview.thumb, seconds: preview.seconds,
      aspect: preview.width && preview.height ? preview.width / preview.height : 0,
    }));

    // Prepared once (a compressed video is not compressed again on Retry).
    let preparing = null;
    const run = (signal) => withUploadSlot(async () => {
      preparing ??= prepare ? prepare() : Promise.resolve({ blob, filename, extras: {} });
      let ready;
      try { ready = await preparing; } catch (error) { preparing = null; throw error; }
      const sizeError = uploadSizeError(ready.filename, ready.blob.size);
      if (sizeError) throw new Error(sizeError);
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      patchUpload(key, { preparing: false, total: ready.blob.size });
      const plainFile = ready.blob instanceof File ? ready.blob : new File([ready.blob], ready.filename, { type: ready.blob.type });
      // Encrypted on this device before upload (src/mediaCrypto.js); the key travels inside the end-to-end encrypted
      // message, so the server stores only ciphertext under a neutral name.
      const { upload: file, descriptor } = await sealForUpload(plainFile);
      const data = await uploadFile(file, {
        receiverId: chatId,
        sessionToken,
        signal,
        kind: isVoiceNote ? 'voice' : undefined,
        onProgress: (sent, total) => patchUpload(key, { sent, total }),
      });
      // This device keeps its own copy (the server deletes the file once every device has it); a view once item is
      // not kept by its sender, as on WhatsApp. The copy is written while the message goes out (not before it), and
      // this bubble shows the file straight from memory.
      if (kind !== 'voice-once' && kind !== 'viewonce') {
        primeMediaBlob(data.id, sessionToken, plainFile);
        storeMedia(data.id, file, { contentType: file.type || 'application/octet-stream', size: file.size }).catch(() => {});
      }
      const attachment = attachmentContent(data.id, descriptor ? ready.filename : data.filename || ready.filename, descriptor);
      // View once photos/videos, video notes and made stickers wrap the attachment (src/mediaExtras.js).
      const wrapped = { viewonce: VIEW_ONCE_PREFIX, vnote: VIDEO_NOTE_PREFIX, csticker: CUSTOM_STICKER_PREFIX }[kind];
      const content = isVoiceNote ? voiceContent(data.id, seconds, { viewOnce: kind === 'voice-once', descriptor, lang: resolveVoiceLanguage(appSettings().get('chats.voiceLanguage')) })
        : wrapped ? wrapped + attachment : attachment;
      const preview = previewJob && kind === 'media' ? await previewJob : null;
      const previewExtras = preview ? { ...(preview.thumb ? { thumb: preview.thumb } : {}), ...(preview.poster ? { poster: preview.poster } : {}), ...(preview.seconds ? { duration: preview.seconds } : {}) } : {};
      return { content, extras: { ...extras, ...previewExtras, ...ready.extras } };
    });

    const remove = () => {
      uploadControllersRef.current.delete(key);
      uploadRetriesRef.current.delete(key);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setUploads((list) => list.filter((entry) => entry.key !== key));
    };
    // A failed upload stays in the chat with Retry (as on WhatsApp) instead of disappearing; cancelling removes it.
    const settle = (job) => job.then(({ content, extras: sealedExtras }) => {
      sendContent(content, null, sealedExtras);
      remove();
    }, (caught) => {
      if (caught?.name === 'AbortError') { remove(); return; }
      uploadControllersRef.current.delete(key);
      patchUpload(key, { failed: true, preparing: false, sent: 0, error: caught?.message || 'Upload failed.' });
      uploadRetriesRef.current.set(key, () => {
        const again = new AbortController();
        uploadControllersRef.current.set(key, again);
        uploadRetriesRef.current.delete(key);
        patchUpload(key, { failed: false, error: '', sent: 0 });
        return settle(run(again.signal));
      });
    });

    const job = run(controller.signal);
    // Sent strictly in the order queued, whatever order the uploads finish in. A retried item goes when it is done.
    const sent = sendOrderRef.current.then(() => settle(job));
    sendOrderRef.current = sent;
    return sent;
  }

  // key -> resend of a failed upload (uploadAndSend).
  const uploadRetriesRef = useRef(new Map());

  function cancelUpload(key) {
    const controller = uploadControllersRef.current.get(key);
    if (controller) { controller.abort(); return; }
    // A failed item: dismissed.
    if (uploadRetriesRef.current.delete(key)) setUploads((list) => list.filter((entry) => entry.key !== key));
  }

  function retryUpload(key) {
    uploadRetriesRef.current.get(key)?.();
  }

  useEffect(() => () => uploadControllersRef.current.forEach((controller) => controller.abort()), []);

  // Photos and videos follow the Standard / HD choice and get a tiny preview for the receiver; documents go exactly
  // as they are. Several photos or videos sent together form one album.
  function sendPicked(items, { hd = false, viewOnce = false } = {}) {
    const quality = hd ? 'hd' : 'standard';
    const visual = items.filter((item) => item.kind !== 'file').length;
    const albumId = visual >= 2 && !viewOnce ? crypto.randomUUID().replace(/-/g, '').slice(0, 16) : '';
    let albumIndex = 0;
    for (const item of items) {
      const inAlbum = albumId && item.kind !== 'file';
      const album = inAlbum ? { id: albumId, i: albumIndex++, n: visual } : undefined;
      uploadAndSend(item.file, item.file.name, viewOnce ? 'viewonce' : 'media', undefined, {
        extras: { ...(item.caption ? { caption: item.caption } : {}), ...(album ? { album } : {}) },
        prepare: item.kind === 'file' ? null : async () => {
          const { thumb: photoThumb, ...prepared } = await prepareForSend(item.file, item.file.name, quality);
          // A photo's preview comes from its own decode; a video's from the frame uploadAndSend already took.
          const isVideo = (prepared.blob?.type || item.file.type || '').startsWith('video/');
          const thumb = viewOnce || isVideo ? '' : photoThumb || await makeThumb(prepared.blob);
          return { ...prepared, extras: thumb ? { thumb } : {} };
        },
      });
    }
  }

  async function handleFileChange(event) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) return;
    // "+" in the send preview adds to it; otherwise the preview opens with what was picked.
    if (composer) {
      setComposerAdded((current) => ({ version: (current?.version ?? 0) + 1, files }));
      return;
    }
    const kind = pickKindRef.current;
    setComposer({ files: kind === 'viewonce' ? files.slice(0, 1) : files, viewOnce: kind === 'viewonce', documents: kind === 'document' });
  }

  function openFilePicker(accept, capture, kind = 'media') {
    pickKindRef.current = kind;
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
    if (option === 'document') openFilePicker('', undefined, 'document');
    else if (option === 'catalog') setPicker('catalog');
    else if (option === 'sticker') { setTrayTab('stickers'); setEmojiOpen(true); }
    else if (option === 'gallery') openFilePicker('image/*,video/*');
    else if (option === 'viewonce') openFilePicker('image/*,video/*', undefined, 'viewonce');
    else if (option === 'videonote') setPicker('videonote');
    else if (option === 'mysticker') setPicker('stickermaker');
    else if (option === 'order') setPicker('order');
    else if (option === 'camera') setPicker('camera');
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
    pinnedIds,
    peerName: chat?.name ?? 'Contact',
    // Quote cards colour the contact's name and bar with their colour (src/styles.css .wa-quoted-reply-preview).
    peerColor: chat?.color ?? 'blue',
    userId,
    nameFor: (id) => (id === chat?.id ? presentName(chat) : null),
    pollContext: { peerId: chat?.id },
    sendText: (text) => sendContent(text),
    send: client ? liveSend : null,
    callBack: onStartCall,
    forward: (message) => setForwardSource([message]),
    openLocation: (location) => setMapView({ location }),
    openLive: (sessionId) => setMapView({ sessionId }),
    messageContact: (contact) => {
      const { chats: list, addContact, setActiveChat } = useChatStore.getState();
      if (list.some((item) => item.id === contact.id)) setActiveChat(contact.id);
      else addContact({ id: contact.id, name: contact.name, username: contact.username, initials: contact.initials, color: contact.color, avatar: contact.avatar });
    },
  }), [chat, userId, client, liveSend, onStartCall, pinnedIds]);

  function handleVoiceSend(blob, seconds, type, { viewOnce = false } = {}) {
    setRecording(false);
    setVoiceHold(null);
    uploadAndSend(blob, `voice-note.${voiceExtension(type)}`, viewOnce ? 'voice-once' : 'voice', seconds);
  }

  const handleVoiceCancel = useCallback(() => { setRecording(false); setVoiceHold(null); }, []);

  // A tap on the mic opens the locked recorder, whose Send button then sits under the finger: the tap's own click
  // would land on it and end the recording before the microphone opens. That one click is dropped.
  function swallowTapClick() {
    const swallow = (click) => { click.preventDefault(); click.stopPropagation(); };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 400);
  }

  // The mic: a quick tap starts a locked recording (trash / pause / send); holding records while held — release to
  // send, slide up to lock, slide left to cancel. Too short a hold is discarded with a hint.
  function startVoiceGesture(event) {
    if (event.button > 0) return;
    event.preventDefault();
    const start = { x: event.clientX, y: event.clientY, at: Date.now() };
    setError('');
    setEmojiOpen(false);
    setRecording(true);
    setVoiceHold({ x: 0, y: 0 });
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', lock);
      holdCleanupRef.current = null;
    };
    const lock = () => { finish(); setVoiceHold(null); };
    function move(moved) {
      const x = Math.min(0, moved.clientX - start.x);
      const y = Math.min(0, moved.clientY - start.y);
      if (y < -VOICE_LOCK_PX) return lock();
      if (x < -VOICE_CANCEL_PX) { finish(); recorderRef.current?.discard(); return undefined; }
      setVoiceHold({ x, y });
      return undefined;
    }
    function release() {
      finish();
      const held = Date.now() - start.at;
      if (held < VOICE_TAP_MS) { setVoiceHold(null); swallowTapClick(); return; }
      if (held < VOICE_MIN_HOLD_MS) { recorderRef.current?.discard(); setError('Hold to record, release to send'); return; }
      recorderRef.current?.send();
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', lock);
    holdCleanupRef.current = finish;
  }

  function handleTextChange(event) {
    setText(event.target.value);
    // Emptying the box stops "typing…" at once, as on WhatsApp.
    if (event.target.value) notifyTyping();
    else activityRef.current?.stop();
  }

  function notifyTyping() {
    activityRef.current?.typed();
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

  // The message box grows with its text up to six lines, then scrolls.
  useLayoutEffect(() => {
    const box = composerInputRef.current;
    if (!box || box.tagName !== 'TEXTAREA') return;
    box.style.height = 'auto';
    const line = parseFloat(getComputedStyle(box).lineHeight) || 22;
    box.style.height = `${Math.min(box.scrollHeight, line * 6 + 8)}px`;
  }, [text]);

  function handleSubmit(event) {
    event.preventDefault();
    const content = text.trim();
    if (!content) return;
    if (content.length > COMPOSER_MAX_LENGTH) {
      setError('Messages can be up to 4,000 characters.');
      return;
    }
    if (editing) {
      saveEdit(editing, content);
      return;
    }
    activityRef.current?.stop();
    sendContent(content);
    setText('');
    setEmojiOpen(false);
    setError('');
  }

  // The message list does not depend on the text being typed: built once per change of the messages or the
  // selection, so a keystroke re-renders the composer only (long chats with media typed slowly before).
  const handlersRef = useRef(null);
  handlersRef.current = { reactTo, startReply, showInChat };
  const stableStartReply = useCallback((target) => handlersRef.current.startReply(target), []);
  const stableShowInChat = useCallback((messageId) => handlersRef.current.showInChat(messageId), []);
  // A search result opened this chat: scroll to that message (after the first paint of the chat).
  const messageJump = useChatStore((state) => state.messageJump);
  useEffect(() => {
    if (!messageJump || messageJump.chatId !== chatId) return undefined;
    const timer = setTimeout(() => {
      handlersRef.current.showInChat(messageJump.messageId);
      useChatStore.getState().clearMessageJump();
    }, 350);
    return () => clearTimeout(timer);
  }, [messageJump, chatId]);
  const messageList = useMemo(() => {
    if (!chat) return null;
    let lastDay = '';
    let lastSender = null;
    // Albums: a run of media messages with the same album id from the same sender draws as one bubble (its first).
    const albumOf = new Map();
    const inAlbum = new Set();
    for (let index = 0; index < visibleMessages.length; index += 1) {
      const first = visibleMessages[index];
      if (!first?.album?.id || !isMediaContent(first.content) || first.deleted) continue;
      const run = [first];
      while (index + 1 < visibleMessages.length) {
        const next = visibleMessages[index + 1];
        if (next?.album?.id !== first.album.id || next.senderId !== first.senderId || !isMediaContent(next.content) || next.deleted) break;
        run.push(next);
        index += 1;
      }
      if (run.length > 1) {
        albumOf.set(first.id, run);
        run.slice(1).forEach((item) => inAlbum.add(item.id));
      }
    }
    return visibleMessages.map((message) => {
            if (!message?.id || inAlbum.has(message.id)) return null;
            const day = localDateKey(message.timestamp);
            const showDay = day !== lastDay;
            lastDay = day;
            // The first message of a run from one sender (or of a day) gets the bubble tail; the rest stack closer.
            const runStart = showDay || message.senderId !== lastSender;
            lastSender = message.senderId;

            return (
              <div className={`message-day-group ${runStart ? 'run-start' : 'run-continued'}`} key={message.id}>
                {showDay && <div className="day-divider"><span>{formatMessageDate(message.timestamp)}</span></div>}
                <MessageBubble
                  message={message}
                  mine={message.senderId === userId}
                  sessionToken={sessionToken}
                  sender={message.senderId === userId ? user : chat}
                  quote={quoteView(resolveQuote(message.replyTo, messages), userId, chat.name)}
                  selectionActive={selectionActive}
                  isSelected={selectedIds.includes(message.id)}
                  highlighted={highlightId === message.id}
                  onLongPress={handleLongPress}
                  onToggleSelect={handleToggleSelect}
                  onReact={(emoji) => handlersRef.current.reactTo(message, emoji)}
                  onOpenMedia={() => setViewerMessageId(message.id)}
                  album={albumOf.get(message.id) ?? null}
                  onOpenAlbumItem={setViewerMessageId}
                  onSwipeReply={message.content?.startsWith('call:') || message.deleted ? null : stableStartReply}
                  onQuoteClick={stableShowInChat}
                  reactionTrayOpen={trayMessageId === message.id}
                  onTrayReact={(emoji) => {
                    handlersRef.current.reactTo(message, emoji);
                    clearSelection();
                  }}
                  shared={sharedHandlers}
                />
              </div>
            );
          });
  }, [visibleMessages, userId, sessionToken, user, chat, selectionActive, selectedIds, highlightId, trayMessageId, sharedHandlers, handleLongPress, handleToggleSelect, clearSelection, stableStartReply, stableShowInChat]);

  if (!chat) {
    return (
      <section className="empty-conversation">
        <h1>Select a conversation</h1>
        <p>Choose a contact to start messaging.</p>
      </section>
    );
  }

  const status = typing ? activityLabel(typing) : presenceLine({ status: presence, lastSeenAt }, now);
  const shareable = (Array.isArray(chats) ? chats : []).filter((item) => item?.id && item.id !== userId);


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

  // Edit (own text messages, for 15 minutes, as on WhatsApp): the text goes back into the composer; saving shows it at once
  // and reverts if the server refuses (e.g. the 15 minutes ran out meanwhile).
  function startEdit(target) {
    clearSelection();
    setReplyingTo(null);
    setEmojiOpen(false);
    setEditing(target);
    setText(target.content);
    requestAnimationFrame(() => {
      const input = composerInputRef.current;
      input?.focus();
      input?.setSelectionRange(target.content.length, target.content.length);
    });
  }

  function cancelEdit() {
    setEditing(null);
    setText('');
  }

  function saveEdit(target, content) {
    setEditing(null);
    setText('');
    setError('');
    if (content === target.content) return;
    updateMessage(target.id, { content, editedAt: new Date().toISOString() });
    // A message that travelled over XMPP is edited end to end on every device (the server never had it).
    if (sendControlFor(target, { op: 'edit', text: content })) return;
    editDirectMessage(sessionToken, target.id, content, chatId).catch((caught) => {
      updateMessage(target.id, { content: target.content, editedAt: target.editedAt });
      setError(caught.message);
    });
  }

  async function togglePin(target) {
    clearSelection();
    try {
      await setMessagePinned(chatId, target.id, !pinnedIds.has(target.id));
    } catch (caught) {
      setError(caught.message);
    }
  }

  function describePinned(messageId) {
    const target = messages.find((item) => item.id === messageId);
    if (!target) return 'Pinned message';
    return target.deleted ? 'This message was deleted' : previewFor(target.content);
  }

  function startReply(target) {
    setReplyingTo(replyQuoteFor(target));
    clearSelection();
    requestAnimationFrame(() => composerInputRef.current?.focus());
  }

  function reactTo(target, emoji) {
    const next = toggleReaction(chatId, target.id, emoji);
    if (target.content?.startsWith('call:')) return;
    // Sealed end-to-end like a message (src/e2e/messaging.js).
    transmitReaction(client, chatId, target.id, next).catch(() => {});
  }

  function replyFromViewer(target, text) {
    if (text.length > 4000) return false;
    sendContent(text, replyQuoteFor(target));
    return true;
  }

  function showInChat(messageId) {
    setViewerMessageId(null);
    setHighlightId(messageId);
    ensureRendered(messageId);
    // Two frames: the first commits the widened window, the second has the target laid out.
    requestAnimationFrame(() => requestAnimationFrame(() => {
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
    }));
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
      // A message that travelled over XMPP was never on the server: deleting it for me is this device's own business,
      // and deleting it for everyone goes end to end to every device of both people (src/e2e/lifecycle.js).
      const overXmpp = target.via === 'xmpp';
      if (target.deleted) {
        deleteMessage(chatId, target.id);
        if (!overXmpp) client?.send?.({ type: 'message:delete', messageId: target.id, scope: 'me' });
        continue;
      }
      if (overXmpp && scope === 'everyone') {
        if (sendControlFor(target, { op: 'delete' })) useChatStore.getState().markMessageDeleted(target.id);
        else offline = true;
      } else if (overXmpp) {
        deleteMessage(chatId, target.id);
      } else if (!onServer) {
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
            {actions.canEdit && (
              <button type="button" className="icon-button" onClick={() => startEdit(selectedMessages[0])} title="Edit" aria-label="Edit">
                <Pencil size={18} />
              </button>
            )}
            {actions.canPin && (
              <button type="button" className="icon-button" onClick={() => togglePin(selectedMessages[0])}
                title={pinnedIds.has(selectedMessages[0].id) ? 'Unpin' : 'Pin'} aria-label={pinnedIds.has(selectedMessages[0].id) ? 'Unpin' : 'Pin'}>
                {pinnedIds.has(selectedMessages[0].id) ? <PinOff size={18} /> : <Pin size={18} />}
              </button>
            )}
            {actions.canStar && (
              <button
                type="button"
                className="icon-button"
                onClick={starSelection}
                title={actions.allStarred ? 'Unstar' : 'Star'}
                aria-label={actions.allStarred ? 'Unstar' : 'Star'}
              >
                <Star size={18} fill={actions.allStarred ? 'currentColor' : 'none'} />
              </button>
            )}
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
            {actions.canShare && typeof navigator.share === 'function' && (
              <button type="button" className="icon-button" title="Share" aria-label="Share"
                onClick={() => {
                  const text = selectedMessages.map((item) => item.content).join('\n\n');
                  clearSelection();
                  navigator.share({ text }).catch(() => {});
                }}>
                <Share2 size={18} />
              </button>
            )}
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
                {chat.verified && <VerifiedBadge size={15} />}
                {chat.disappearSeconds > 0 && <Timer size={13} className="conversation-timer" aria-label={`Disappearing messages: ${disappearingLabel(chat.disappearSeconds)}`} />}
              </strong>
              <small>
                {chat.deleted ? 'Account deleted' : blocked ? 'Blocked' : connection && connection !== 'online' && connection !== 'connected' ? [status, connection].filter(Boolean).join(' · ') : status}
              </small>
            </span>
          </div>
          <div className="conversation-actions">
            {cartItems > 0 && <button type="button" className="icon-button conversation-cart" onClick={() => setPicker('order')} aria-label={`Cart, ${cartItems} item${cartItems === 1 ? '' : 's'}`}><ShoppingCart size={18} /><span className="conversation-cart-count">{cartItems}</span></button>}
            <button type="button" className="icon-button" onClick={() => onStartCall?.('video')} disabled={blocked || chat.deleted} aria-label="Video call"><Video size={18} /></button>
            <button type="button" className="icon-button" onClick={() => onStartCall?.('audio')} disabled={blocked || chat.deleted} aria-label="Voice call"><Phone size={18} /></button>
            {/* Secondary actions collapse into the ⋮ menu on narrow screens (see .header-action-secondary). */}
            <button type="button" className="icon-button header-action-secondary" onClick={openChatSearch} aria-label="Search messages"><Search size={18} /></button>
            <button type="button" className="icon-button header-action-secondary" onClick={onPair} aria-label="Linked devices"><Link2 size={18} /></button>
            <span className="header-menu-wrap">
              <button type="button" className="icon-button" onClick={() => setHeaderMenuOpen((open) => !open)} aria-label="More options" aria-expanded={headerMenuOpen}><MoreVertical size={18} /></button>
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
                    { id: 'pair', label: 'Linked devices', action: () => onPair?.() },
                    { id: 'info', label: 'View contact', action: () => openInfo('main') },
                    ...(chat.deleted ? [] : [{ id: 'block', label: blocked ? 'Unblock' : 'Block', action: () => (blocked ? unblockChat(chatId).catch((failure) => setError(failure.message)) : openInfo('main', 'block')) }]),
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

      {/* The pinned bar and the messages share the conversation's scrolling grid row. */}
      <div className="conversation-body">
      <PinnedBanner pins={pins} describe={describePinned} onJump={showInChat}
        onUnpin={(messageId) => setMessagePinned(chatId, messageId, false).catch((caught) => setError(caught.message))} />
      <div
        className="message-scroll"
        data-chat-theme={chatTheme}
        data-wallpaper={wallpaper}
        ref={messageScrollRef}
        onScroll={() => { syncScrollState(); loadOlderIfNearTop(); }}
        onWheel={cancelAutoScroll}
        onTouchMove={cancelAutoScroll}
        onClick={(event) => {
          // A tap outside the bubbles dismisses a single long-press (tray) selection; multi-select stays until closed.
          if (trayMessageId && !event.target.closest('.message-line')) clearSelection();
        }}
      >
        <div className="message-stack" ref={messageStackRef}>
          {messageList}
          {uploads.map((upload) => <PendingUpload key={upload.key} upload={upload} onCancel={() => cancelUpload(upload.key)} onRetry={() => retryUpload(upload.key)} />)}
          {typing === 'recording' && (
            <div className="recording-indicator" role="status" aria-label={`${chat?.name ?? 'Contact'} is recording audio`}>
              <span className="recording-indicator-mic" aria-hidden="true"><Mic size={18} /></span>
              <span className="recording-indicator-bars" aria-hidden="true"><span /><span /><span /><span /><span /></span>
            </div>
          )}
          {typing === 'typing' && <div className="typing-indicator" role="status" aria-label={`${chat?.name ?? 'Contact'} is typing`}><span /><span /><span /></div>}
          <div ref={messagesEndRef} className="messages-end" aria-hidden="true" />
        </div>
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

      {chat.deleted ? (
        <div className="wa-blocked-composer" role="status"><p>This account was deleted. You can&apos;t send messages to this chat anymore.</p></div>
      ) : blocked ? (
        <div className="wa-blocked-composer">
          <button type="button" onClick={() => unblockChat(chatId).catch((failure) => setError(failure.message))}>You blocked this contact. Tap to unblock.</button>
        </div>
      ) : (
      <form className="composer-wrap" onSubmit={handleSubmit}>
        {encryption === false && (
          <p className="e2e-warning is-waiting" role="status">🔒 {chat?.name ?? 'This contact'} hasn’t opened an updated Hidden Messenger yet. What you send <strong>waits on your phone</strong> and goes out end-to-end encrypted as soon as they do; nothing is ever sent unencrypted.</p>
        )}
        {editing && (
          <div className="wa-composer-reply-banner hm-edit-banner">
            <div className="wa-composer-reply-content">
              <strong><Pencil size={13} aria-hidden="true" /> Edit message</strong>
              <span>{editing.content}</span>
            </div>
            <button type="button" className="wa-composer-reply-close" onClick={cancelEdit} aria-label="Cancel edit"><X size={16} /></button>
          </div>
        )}
        {!recording && !editing && (
          <ComposerAssist text={text} caret={caret} onReplace={(next, nextCaret) => {
            setText(next);
            setCaret(nextCaret);
            requestAnimationFrame(() => {
              composerInputRef.current?.focus();
              composerInputRef.current?.setSelectionRange(nextCaret, nextCaret);
            });
          }} />
        )}
        {replyingTo && (() => {
          const quote = quoteView(replyingTo, userId, chat.name);
          return (
            <div className="wa-composer-reply-banner" data-accent={quote.self ? 'self' : (chat.color ?? 'blue')}>
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
          <VoiceRecorderBar ref={recorderRef} hold={voiceHold} onSend={handleVoiceSend} onCancel={handleVoiceCancel} onError={setError} allowViewOnce />
        ) : (
          <div className="composer-row">
            <div className="composer">
              <button type="button" className={`composer-icon${emojiOpen ? ' toggled' : ''}`} onClick={() => setEmojiOpen((open) => !open)} aria-label="Emoji" aria-expanded={emojiOpen}><Smile size={20} /></button>
              {hasFormatting(text) && <ComposerMirror inputRef={composerInputRef} text={text} />}
              <textarea ref={composerInputRef} rows={1} className={`composer-input${hasFormatting(text) ? ' has-mirror' : ''}`} value={text} onChange={(event) => { setCaret(event.target.selectionStart ?? event.target.value.length); handleTextChange(event); }}
                onSelect={(event) => setCaret(event.target.selectionStart ?? 0)} onKeyDown={(event) => {
                  if (event.key === 'Escape' && editing) { event.preventDefault(); cancelEdit(); return; }
                  // Computers: Enter sends, Shift+Enter starts a new line. Phones: Enter is a new line; the button sends.
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && enterSends()) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
                }}
                placeholder={translate(editing ? 'Edit message' : 'Message', language)} aria-label={translate(editing ? 'Edit message' : 'Message', language)} maxLength={COMPOSER_MAX_LENGTH} />
              <button type="button" className="composer-icon" onClick={() => setMenuOpen(true)} aria-label="Attach"><Paperclip size={20} /></button>
              {action === 'voice' && (
                <button type="button" className="composer-icon composer-camera" onClick={() => setPicker('camera')} aria-label="Camera"><Camera size={20} /></button>
              )}
            </div>
            {editing ? (
              <button type="submit" className="composer-fab" onMouseDown={keepKeyboard} aria-label="Save edit" disabled={!text.trim()}><Check size={20} /></button>
            ) : action === 'send' ? (
              <button type="submit" className="composer-fab" onMouseDown={keepKeyboard} aria-label="Send"><Send size={20} /></button>
            ) : (
              <button type="button" className="composer-fab composer-mic" onPointerDown={startVoiceGesture} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setError(''); setEmojiOpen(false); setRecording(true); } }} onContextMenu={(event) => event.preventDefault()} aria-label="Record voice note" title="Tap to record, or hold: release to send, slide up to lock"><Mic size={20} /></button>
            )}
          </div>
        )}
        {emojiOpen && !recording && (
          <div className="composer-tray">
            {!editing && (
              <div className="composer-tray-tabs" role="tablist" aria-label="Emoji and stickers">
                <button type="button" role="tab" aria-selected={trayTab === 'emoji'} onClick={() => setTrayTab('emoji')}>Emoji</button>
                <button type="button" role="tab" aria-selected={trayTab === 'stickers'} onClick={() => setTrayTab('stickers')}>Stickers</button>
              </div>
            )}
            {trayTab === 'stickers' && !editing ? (
              <StickerPalette token={sessionToken} onPick={(key) => { sendContent(stickerContent(key)); setEmojiOpen(false); }}
                onGif={async (file) => { setEmojiOpen(false); await uploadAndSend(file, file.name); }} />
            ) : (
              <div className="composer-emoji-tray" role="listbox" aria-label="Emoji">
                {COMPOSER_EMOJIS.map((emoji) => (
                  <button type="button" key={emoji} role="option" aria-selected="false" onClick={() => insertEmoji(emoji)} aria-label={`Insert ${emoji}`}>{emoji}</button>
                ))}
              </div>
            )}
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
          initialDialog={contactInfoDialog}
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
      {picker === 'camera' && (
        <CameraCapture onClose={() => setPicker(null)}
          onGallery={() => { setPicker(null); openFilePicker('image/*,video/*'); }}
          onUnavailable={() => { setPicker(null); setError('The camera isn’t available. Allow camera access for Hidden Messenger, or pick from the gallery.'); }}
          onSend={(file, caption) => {
            setPicker(null);
            // The caption travels with the photo or video, in the same bubble (as on WhatsApp).
            sendPicked([{ file, kind: file.type.startsWith('video/') ? 'video' : 'image', caption }], { hd: appSettings().get('media.uploadQuality') === 'hd' });
          }} />
      )}
      {composer && (
        <MediaComposer files={composer.files} added={composerAdded} recipient={chat?.name ?? 'this chat'}
          quality={appSettings().get('media.uploadQuality')} initialViewOnce={composer.viewOnce} asDocuments={composer.documents}
          allowViewOnce={!composer.documents}
          onAddMore={() => openFilePicker(composer.documents ? '' : 'image/*,video/*', undefined, composer.documents ? 'document' : 'media')}
          onClose={() => { setComposer(null); setComposerAdded(null); }}
          onSend={(items, options) => { setComposer(null); setComposerAdded(null); sendPicked(items, options); }} />
      )}
      {picker === 'videonote' && (
        <VideoNoteRecorder onClose={() => setPicker(null)} onSend={(blob, seconds) => uploadAndSend(blob, `video-note.${blob.type.includes('mp4') ? 'mp4' : 'webm'}`, 'vnote', seconds)} />
      )}
      <ViewOnceViewerHost />
      {picker === 'order' && (
        <OrderComposer sessionToken={sessionToken} sellerId={chatId} sellerName={chat?.name ?? 'this business'} onClose={() => setPicker(null)} onSend={(content) => sendContent(content)} />
      )}
      {picker === 'stickermaker' && (
        <StickerMaker userId={userId} onClose={() => setPicker(null)} onSend={(blob) => uploadAndSend(blob, `sticker.${blob.type === 'image/webp' ? 'webp' : 'png'}`, 'csticker')} />
      )}
      {picker === 'catalog' && <CatalogPicker sessionToken={sessionToken} userId={userId} onSend={(itemId) => { sendContent(productContent(itemId)); setPicker(null); }} onClose={() => setPicker(null)} />}
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
