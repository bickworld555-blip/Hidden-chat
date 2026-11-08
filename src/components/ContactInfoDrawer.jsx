import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Ban,
  Bell,
  ChevronRight,
  Download,
  FileText,
  Heart,
  Link as LinkIcon,
  LockOpen,
  MessageSquareLock,
  Palette,
  Phone,
  Search,
  Star,
  ThumbsDown,
  Timer,
  Trash2,
  Video,
  X,
} from 'lucide-react';
import { previewFor, useChatStore } from '../store.js';
import { isBlocked } from '../blocking.js';
import { clearChatOnServer, deleteChatOnServer } from '../chatApi.js';
import { CHAT_THEMES, chatThemeLabel, exportChatText, exportFilename, sharedContent } from '../contactInfo.js';
import { DISAPPEARING_OPTIONS, disappearingLabel } from '../disappearing.js';
import { parseMediaRef, saveBlob } from '../media.js';
import { formatViewerTimestamp } from '../time.js';
import { hasCustomDisplayName, presentName } from '../profile.js';
import Avatar from './Avatar.jsx';
import { GalleryTile } from './MediaViewer.jsx';

const CLOSE_ANIMATION_MS = 200;
const STRIP_LIMIT = 4;
const TOAST_MS = 1800;

function Row({ icon: Icon, title, subtitle, value, danger, disabled, onClick, iconProps, className = '', children }) {
  return (
    <button type="button" className={`wa-info-row${danger ? ' danger' : ''}${className ? ` ${className}` : ''}`} onClick={onClick} disabled={disabled}>
      {Icon && <Icon size={20} className="wa-info-row-icon" aria-hidden="true" {...iconProps} />}
      <span className="wa-info-row-text">
        <span>{title}</span>
        {subtitle && <small>{subtitle}</small>}
      </span>
      {value !== undefined && <span className="wa-info-row-value">{value}</span>}
      {children}
    </button>
  );
}

function Switch({ checked }) {
  return <span className={`wa-switch${checked ? ' on' : ''}`} aria-hidden="true"><span /></span>;
}

function SubView({ title, onBack, children }) {
  return (
    <div className="wa-info-subview">
      <header className="wa-info-header">
        <button type="button" className="icon-button" onClick={onBack} aria-label="Back to contact info"><ArrowLeft size={20} /></button>
        <h2>{title}</h2>
      </header>
      <div className="wa-info-scroll">{children}</div>
    </div>
  );
}

function ConfirmDialog({ title, children, confirmLabel, danger = true, busy, onConfirm, onCancel }) {
  return (
    <div className="wa-info-dialog-backdrop" onClick={onCancel}>
      <div className="wa-info-dialog" role="alertdialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <h3>{title}</h3>
        <div className="wa-info-dialog-body">{children}</div>
        <div className="wa-info-dialog-actions">
          <button type="button" className="wa-info-dialog-cancel" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" className={`wa-info-dialog-confirm${danger ? ' danger' : ''}`} onClick={onConfirm} disabled={busy}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

export default function ContactInfoDrawer({
  chat,
  messages,
  status,
  client,
  onClose,
  onStartCall,
  onSearch,
  onOpenMedia,
  onShowMessage,
  onChatDeleted,
  initialView = 'main',
}) {
  const chatId = chat.id;
  const name = presentName(chat) || 'Unknown contact';
  const userId = useChatStore((state) => state.userId);
  const user = useChatStore((state) => state.user);
  const sessionToken = useChatStore((state) => state.sessionToken);
  const muted = useChatStore((state) => state.mutedChatIds.includes(chatId));
  const favourite = useChatStore((state) => state.favouriteChatIds.includes(chatId));
  const blocked = useChatStore((state) => isBlocked(state.blockedChats[chatId]));
  const theme = useChatStore((state) => state.chatThemes[chatId] ?? 'default');
  const store = useChatStore.getState;

  const [view, setView] = useState(initialView);
  const [mediaTab, setMediaTab] = useState('media');
  const [dialog, setDialog] = useState(null);
  const [keepStarred, setKeepStarred] = useState(true);
  const [deleteAfterReport, setDeleteAfterReport] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [closing, setClosing] = useState(false);
  const closeButtonRef = useRef(null);

  const shared = useMemo(() => sharedContent(messages), [messages]);
  const starred = useMemo(() => messages.filter((message) => message.starred), [messages]);
  const disappearSeconds = chat.disappearSeconds ?? 0;

  function close() {
    if (closing) return;
    setClosing(true);
    setTimeout(onClose, CLOSE_ANIMATION_MS);
  }

  function leaveTo(action) {
    onClose();
    action();
  }

  useEffect(() => { closeButtonRef.current?.focus(); }, [view]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(''), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  // Escape steps back one layer: dialog, then sub-view, then the drawer itself.
  useEffect(() => {
    function handleKey(event) {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      if (dialog) { if (!busy) setDialog(null); } else if (view !== 'main') setView('main');
      else close();
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  });

  function openDialog(next) {
    setError('');
    setDialog(next);
  }

  async function runDialogAction(action) {
    setBusy(true);
    setError('');
    try {
      await action();
      setDialog(null);
    } catch (failure) {
      setError(failure.message || 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  function setDisappearing(seconds) {
    if (seconds === disappearSeconds) return;
    if (!client?.send?.({ type: 'chat:disappearing', peerId: chatId, seconds })) {
      setError('You are offline. Connect to change disappearing messages.');
      return;
    }
    setError('');
    store().setDisappearing(chatId, seconds);
  }

  function exportChat() {
    const text = exportChatText(messages, { userId, selfName: user?.name ?? 'You', peerName: name });
    saveBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), exportFilename(name));
    setToast('Chat exported');
  }

  const clearChat = () => runDialogAction(async () => {
    const keepIds = keepStarred ? starred.map((message) => message.id) : [];
    await clearChatOnServer(sessionToken, chatId, keepIds);
    store().clearChat(chatId, keepIds);
    setToast('Chat cleared');
  });

  const deleteChat = () => runDialogAction(async () => {
    const { kept } = await deleteChatOnServer(sessionToken, chatId);
    onClose();
    store().deleteChat(chatId, { kept });
    onChatDeleted?.();
  });

  const reportAndBlock = () => runDialogAction(async () => {
    if (!blocked) store().blockChat(chatId);
    if (deleteAfterReport) {
      const { kept } = await deleteChatOnServer(sessionToken, chatId);
      onClose();
      store().deleteChat(chatId, { kept });
      onChatDeleted?.();
      return;
    }
    setToast(blocked ? 'Contact is blocked' : `${name} blocked`);
  });

  function toggleBlock() {
    if (blocked) {
      store().unblockChat(chatId);
      setToast(`${name} unblocked`);
    } else {
      openDialog('block');
    }
  }

  const mediaStrip = shared.media.slice(0, STRIP_LIMIT);
  let body;
  if (view === 'media') {
    const list = mediaTab === 'media' ? shared.media : mediaTab === 'links' ? shared.links : shared.docs;
    body = (
      <SubView title={name} onBack={() => setView('main')}>
        <div className="wa-info-tabs" role="tablist">
          {[['media', 'Media'], ['links', 'Links'], ['docs', 'Docs']].map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={mediaTab === id} className={mediaTab === id ? 'active' : ''} onClick={() => setMediaTab(id)}>{label}</button>
          ))}
        </div>
        {list.length === 0 && <p className="wa-info-empty">No {mediaTab === 'media' ? 'media' : mediaTab} shared yet</p>}
        {mediaTab === 'media' && list.length > 0 && (
          <div className="wa-info-grid">
            {list.map((message) => (
              <GalleryTile key={message.id} message={message} sessionToken={sessionToken} onSelect={() => leaveTo(() => onOpenMedia(message.id))} />
            ))}
          </div>
        )}
        {mediaTab === 'docs' && list.map((message) => (
          <Row key={message.id} icon={FileText} title={parseMediaRef(message.content)?.filename ?? 'Document'} subtitle={formatViewerTimestamp(message.timestamp)} onClick={() => leaveTo(() => onOpenMedia(message.id))} />
        ))}
        {mediaTab === 'links' && list.map((message) => (
          <Row key={message.id} icon={LinkIcon} title={message.content} subtitle={formatViewerTimestamp(message.timestamp)} onClick={() => leaveTo(() => onShowMessage(message.id))} />
        ))}
      </SubView>
    );
  } else if (view === 'starred') {
    body = (
      <SubView title="Starred messages" onBack={() => setView('main')}>
        {starred.length === 0 && (
          <p className="wa-info-empty">Tap and hold on any message in this chat, then tap the star to find it here later.</p>
        )}
        {starred.map((message) => (
          <Row
            key={message.id}
            icon={Star}
            title={previewFor(message.content)}
            subtitle={`${message.senderId === userId ? 'You' : name} · ${formatViewerTimestamp(message.timestamp)}`}
            onClick={() => leaveTo(() => onShowMessage(message.id))}
          />
        ))}
      </SubView>
    );
  } else if (view === 'disappearing') {
    body = (
      <SubView title="Disappearing messages" onBack={() => setView('main')}>
        <div className="wa-info-hero-icon"><Timer size={48} /></div>
        <p className="wa-info-note">
          For more privacy, new messages in this chat disappear for both of you after the selected time. Messages sent
          before you turn this on are not affected. Anyone in the chat can change this setting.
        </p>
        <div className="wa-info-section" role="radiogroup" aria-label="Message timer">
          <h3>Message timer</h3>
          {DISAPPEARING_OPTIONS.map((option) => (
            <label key={option.seconds} className="wa-info-radio">
              <input type="radio" name="disappearing" checked={disappearSeconds === option.seconds} onChange={() => setDisappearing(option.seconds)} />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
        {error && <p className="wa-info-error" role="alert">{error}</p>}
      </SubView>
    );
  } else if (view === 'theme') {
    body = (
      <SubView title="Chat theme" onBack={() => setView('main')}>
        <p className="wa-info-note">The wallpaper is only changed for this chat, on this device.</p>
        <div className="wa-theme-grid" role="radiogroup" aria-label="Chat theme">
          {CHAT_THEMES.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={theme === option.id}
              className={`wa-theme-swatch${theme === option.id ? ' active' : ''}`}
              onClick={() => store().setChatTheme(chatId, option.id)}
            >
              <span className="wa-theme-preview" data-chat-theme={option.id} />
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      </SubView>
    );
  } else if (view === 'encryption') {
    body = (
      <SubView title="Encryption" onBack={() => setView('main')}>
        <div className="wa-info-hero-icon"><LockOpen size={48} /></div>
        <p className="wa-info-note">
          Hidden Messenger does not use end-to-end encryption. Messages, media and call setup are sent over your connection to
          your Hidden Messenger server and stored there, so anyone who runs or can read that server can read this chat.
        </p>
        <p className="wa-info-note">Use HTTPS to protect messages in transit, and only use Hidden Messenger servers you trust.</p>
      </SubView>
    );
  } else {
    body = (
      <>
        <header className="wa-info-header">
          <button type="button" ref={closeButtonRef} className="icon-button" onClick={close} aria-label="Close contact info"><X size={20} /></button>
          <h2>Contact info</h2>
        </header>
        <div className="wa-info-scroll">
          <section className="wa-info-profile">
            <Avatar name={name} initials={chat.initials ?? name.slice(0, 2).toUpperCase()} color={chat.color} image={chat.avatar} size="xl" />
            <h3>{name}</h3>
            {chat.username && <p className="wa-info-handle">@{chat.username}{hasCustomDisplayName(chat) ? '' : ' · No display name yet'}</p>}
            {!blocked && status && <p className="wa-info-status">{status}</p>}
            <div className="wa-info-quick">
              <button type="button" onClick={() => leaveTo(() => onStartCall?.('audio'))} disabled={blocked}><Phone size={20} /><span>Voice</span></button>
              <button type="button" onClick={() => leaveTo(() => onStartCall?.('video'))} disabled={blocked}><Video size={20} /><span>Video</span></button>
              <button type="button" onClick={() => leaveTo(onSearch)}><Search size={20} /><span>Search</span></button>
            </div>
          </section>

          <section className="wa-info-section">
            <Row title="Media, links and docs" value={shared.total} onClick={() => setView('media')}><ChevronRight size={18} className="wa-info-chevron" /></Row>
            {mediaStrip.length > 0 && (
              <div className="wa-info-strip">
                {mediaStrip.map((message) => (
                  <GalleryTile key={message.id} message={message} sessionToken={sessionToken} onSelect={() => leaveTo(() => onOpenMedia(message.id))} />
                ))}
              </div>
            )}
          </section>

          <section className="wa-info-section">
            <Row icon={Star} title="Starred messages" value={starred.length || 'None'} onClick={() => setView('starred')}><ChevronRight size={18} className="wa-info-chevron" /></Row>
            <Row icon={Bell} title="Mute notifications" subtitle={muted ? 'Muted' : 'Sound on for new messages'} onClick={() => store().toggleMuteChat(chatId)}>
              <Switch checked={muted} />
            </Row>
            <Row icon={Timer} title="Disappearing messages" subtitle={disappearingLabel(disappearSeconds)} onClick={() => { setError(''); setView('disappearing'); }}><ChevronRight size={18} className="wa-info-chevron" /></Row>
            <Row icon={Palette} title="Chat theme" subtitle={chatThemeLabel(theme)} onClick={() => setView('theme')}><ChevronRight size={18} className="wa-info-chevron" /></Row>
            <Row icon={MessageSquareLock} title="Restricted chat" subtitle="Not available yet" disabled />
            <button type="button" className="wa-info-encryption" onClick={() => setView('encryption')}>
              <LockOpen size={20} aria-hidden="true" />
              <span>
                <strong>Encryption</strong>
                <small>Messages are stored on your Hidden Messenger server and are not end-to-end encrypted.</small>
              </span>
            </button>
          </section>

          <section className="wa-info-section">
            <Row
              icon={Heart}
              iconProps={favourite ? { fill: 'currentColor' } : undefined}
              className={favourite ? 'is-favourite' : ''}
              title={favourite ? 'Remove from favourites' : 'Add to favourites'}
              subtitle={favourite ? 'Shown near the top of your chats' : undefined}
              onClick={() => { store().toggleFavouriteChat(chatId); setToast(favourite ? 'Removed from favourites' : 'Added to favourites'); }}
            >
              <span className="wa-info-row-value">
                <Heart size={18} fill={favourite ? 'currentColor' : 'none'} className={`wa-info-heart${favourite ? ' on' : ''}`} aria-hidden="true" />
              </span>
            </Row>
            <Row icon={Download} title="Export chat" subtitle="Text only, without media" onClick={exportChat} disabled={messages.length === 0} />
          </section>

          <section className="wa-info-section">
            <Row icon={Trash2} title="Clear chat" danger onClick={() => openDialog('clear')} disabled={messages.length === 0} />
            <button type="button" className={`wa-info-block${blocked ? ' unblock' : ''}`} onClick={toggleBlock}>
              <Ban size={20} aria-hidden="true" />
              <span>{blocked ? `Unblock ${name}` : `Block ${name}`}</span>
            </button>
            <Row icon={ThumbsDown} title={`Report ${name}`} danger onClick={() => { setDeleteAfterReport(false); openDialog('report'); }} />
            <Row icon={Trash2} title="Delete chat" danger onClick={() => openDialog('delete')} />
          </section>
        </div>
      </>
    );
  }

  return (
    <div className={`wa-info-layer${closing ? ' closing' : ''}`}>
      <div className="wa-info-backdrop" onClick={close} aria-hidden="true" />
      <aside className="wa-info-drawer" role="dialog" aria-modal="true" aria-label={`Contact info for ${name}`}>
        {body}
        {toast && <div className="wa-info-toast" role="status">{toast}</div>}
      </aside>

      {dialog === 'clear' && (
        <ConfirmDialog title="Clear this chat?" confirmLabel="Clear chat" busy={busy} onConfirm={clearChat} onCancel={() => setDialog(null)}>
          <p>Messages are removed for you on all your devices. {name} keeps their copy.</p>
          {starred.length > 0 && (
            <label className="wa-info-check">
              <input type="checkbox" checked={keepStarred} onChange={(event) => setKeepStarred(event.target.checked)} />
              <span>Keep starred messages ({starred.length})</span>
            </label>
          )}
          {error && <p className="wa-info-error" role="alert">{error}</p>}
        </ConfirmDialog>
      )}
      {dialog === 'block' && (
        <ConfirmDialog
          title={`Block ${name}?`}
          confirmLabel="Block"
          onConfirm={() => { store().blockChat(chatId); setDialog(null); setToast(`${name} blocked`); }}
          onCancel={() => setDialog(null)}
        >
          <p>
            Their new messages and calls won&apos;t reach this device. Blocking only applies here: {name} is not told and
            can still send to your Hidden Messenger account.
          </p>
        </ConfirmDialog>
      )}
      {dialog === 'report' && (
        <ConfirmDialog
          title={`Report ${name}?`}
          confirmLabel={blocked ? (deleteAfterReport ? 'Delete chat' : 'OK') : 'Block'}
          danger={!blocked || deleteAfterReport}
          busy={busy}
          onConfirm={reportAndBlock}
          onCancel={() => setDialog(null)}
        >
          <p>
            Hidden Messenger has no moderation team, so reports are not sent anywhere. {blocked ? `${name} is already blocked on this device.` : `You can block ${name} so their messages and calls stop reaching this device.`}
          </p>
          <label className="wa-info-check">
            <input type="checkbox" checked={deleteAfterReport} onChange={(event) => setDeleteAfterReport(event.target.checked)} />
            <span>Also delete this chat</span>
          </label>
          {error && <p className="wa-info-error" role="alert">{error}</p>}
        </ConfirmDialog>
      )}
      {dialog === 'delete' && (
        <ConfirmDialog title="Delete this chat?" confirmLabel="Delete chat" busy={busy} onConfirm={deleteChat} onCancel={() => setDialog(null)}>
          <p>The chat and its messages are removed from your chat list on all your devices. {name} keeps their copy.</p>
          {error && <p className="wa-info-error" role="alert">{error}</p>}
        </ConfirmDialog>
      )}
    </div>
  );
}
