import { setMediaSaveEnabled, useMediaSave } from '../mediaSave.js';
import { nativeShell } from '../native.js';
import { ArrowLeft, Bell, Check, ChevronRight, CornerDownLeft, ListChecks, CircleDashed, CircleHelp, Clock, DatabaseBackup, Download, EyeOff, HardDrive, Image, KeyRound, Languages, Link2, Lock, LogOut, Megaphone, MessageSquare, Moon, Pencil, Radio, ScanFace, ShieldCheck, Smile, Sparkles, Star, Store, Sun, UserPlus, Users, Video, X } from 'lucide-react';
import { useChatStore } from '../store.js';
import { WALLPAPERS, setWallpaper, useWallpaper } from '../wallpaper.js';
import { setEnterSends, useEnterSends } from '../enterSends.js';
import ProfilePhoto from './ProfilePhoto.jsx';
import Avatar from './Avatar.jsx';
import { useAccounts } from '../accounts.js';
import { MAX_DISPLAY_NAME, hasCustomDisplayName, presentName, updateDisplayName } from '../profile.js';
import { useAnimationsEnabled, useAvatarCallsEnabled, useCallAnimationsEnabled, setAnimationsEnabled, setAvatarCallsEnabled, setCallAnimationsEnabled } from '../appearance.js';
import { personaCharacter, usePersona } from '../avatar/persona.js';
import { drawAvatar, idleExpression } from '../avatar/characters.js';
import { useEffect, useRef, useState } from 'react';

// Small idle-animated thumbnail of the chosen character for the settings row.
function AvatarThumb({ persona }) {
  const ref = useRef(null);
  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx) return undefined;
    let frame = 0;
    const character = personaCharacter(persona);
    const draw = (now) => { drawAvatar(ctx, character, idleExpression(now), 40); frame = requestAnimationFrame(draw); };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [persona]);
  return <canvas ref={ref} width={40} height={40} className={`avatar-thumb${persona ? '' : ' is-empty'}`} aria-hidden="true" />;
}

// Display name (editable, shown bold) above the permanent @handle and ID.
function DisplayNameEditor({ user, userId }) {
  const sessionToken = useChatStore((state) => state.sessionToken);
  const updateUserProfile = useChatStore((state) => state.updateUserProfile);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  function startEditing() {
    setDraft(hasCustomDisplayName(user) ? user.name : '');
    setError('');
    setEditing(true);
  }

  async function save(event) {
    event?.preventDefault();
    setBusy(true);
    setError('');
    try {
      updateUserProfile(await updateDisplayName(draft, sessionToken));
      setEditing(false);
    } catch (caught) {
      setError(caught?.message || 'Could not update your name.');
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <form className="user-info user-info-edit" onSubmit={save}>
        <label className="sr-only" htmlFor="display-name-input">Display name</label>
        <div className="display-name-row">
          <input
            id="display-name-input"
            ref={inputRef}
            value={draft}
            maxLength={MAX_DISPLAY_NAME}
            placeholder="Your display name"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Escape') setEditing(false); }}
            disabled={busy}
          />
          <button type="submit" className="icon-button" aria-label="Save display name" disabled={busy}><Check size={18} /></button>
          <button type="button" className="icon-button" aria-label="Cancel" onClick={() => setEditing(false)} disabled={busy}><X size={18} /></button>
        </div>
        <small className="display-name-hint">{draft.length}/{MAX_DISPLAY_NAME} · This is the name people see. Your @handle stays the same.</small>
        {error && <small className="display-name-error" role="alert">{error}</small>}
      </form>
    );
  }

  return (
    <div className="user-info">
      <span className="display-name-row-view">
        <strong>{user ? presentName(user) : 'Connecting...'}</strong>
        <button type="button" className="display-name-pencil" onClick={startEditing} disabled={!user || !sessionToken} aria-label="Edit display name" title="Edit display name">
          <Pencil size={13} />
        </button>
      </span>
      {user && !hasCustomDisplayName(user) && <small className="display-name-hint">Add a display name</small>}
      <small className="user-handle">@{user?.username ?? userId}</small>
      <span className="user-id">ID · {userId}</span>
    </div>
  );
}


// One settings row: icon, title and a one-line detail; a chevron, or a switch when `checked` is given.
function Item({ icon: Icon, iconNode, title, detail, onClick, checked, disabled, className = '' }) {
  const isSwitch = typeof checked === 'boolean';
  return (
    <button type="button" className={`tool-item ${className}`} onClick={onClick} disabled={disabled}
      {...(isSwitch ? { role: 'switch', 'aria-checked': checked } : {})}>
      {iconNode ?? <Icon size={20} />}
      <div className="tool-item-info">
        <strong>{title}</strong>
        {detail && <small>{detail}</small>}
      </div>
      {isSwitch ? <span className={`wa-switch${checked ? ' on' : ''}`} aria-hidden="true"><span /></span> : <ChevronRight size={16} />}
    </button>
  );
}

export const HELP_CENTER_URL = 'https://hiddenmessenger.com/help';

// Settings, in the order a business messenger uses: Business tools first, then Account, Privacy, Avatar, Chats,
// Notifications, Storage and data, App language, Help, Invite a friend. Privacy, Avatar and Chats open their own
// page here; the rest open their panels.
export default function ToolsView({ darkMode, onToggleTheme, onLogout, onNotifications, onAccountSettings, onAccounts, onAvatarStudio, onGroups, onCommunities, onBusinessTools, onStarred, onBackup, onStorage, onSheet, isAdmin = false }) {
  const user = useChatStore((state) => state.user);
  const userId = useChatStore((state) => state.userId);
  const { accounts } = useAccounts();
  const [page, setPage] = useState(null);
  const animations = useAnimationsEnabled();
  const callAnimations = useCallAnimationsEnabled();
  const avatarCalls = useAvatarCallsEnabled();
  const persona = usePersona();
  const mediaSave = useMediaSave();
  const inApp = nativeShell();
  const wallpaper = useWallpaper();
  const enterIsSend = useEnterSends();
  const openHelp = () => { window.open(HELP_CENTER_URL, '_blank', 'noopener'); };

  const pages = {
    privacy: ['Privacy', (
      <div className="tools-section">
        <Item icon={EyeOff} title="Last seen, profile photo and read receipts" detail="Who sees what, app lock and two-step verification" onClick={onAccountSettings} />
        <Item icon={CircleDashed} title="Status" detail="Who sees your status, muted updates" onClick={() => onSheet?.('statusprivacy')} />
        <Item icon={Link2} title="Call links" detail="Let people call you with a link, revoke any time" onClick={() => onSheet?.('calllinks')} />
      </div>
    )],
    avatar: ['Avatar', (
      <div className="tools-section">
        <Item iconNode={<AvatarThumb persona={persona} />} title="Your avatar"
          detail={persona ? `${personaCharacter(persona).name} · ${persona.profile ? 'face scan saved' : 'not scanned yet'} · tap to change` : 'Set up your animated avatar'} onClick={onAvatarStudio} />
        <Item icon={ScanFace} title="Animation Video Call" checked={avatarCalls}
          detail={avatarCalls ? `Your cartoon avatar (${personaCharacter(persona).name}) replaces your camera in video calls` : persona ? 'Video calls send your real camera' : 'Scan your face once and pick a cartoon character'}
          onClick={() => { if (!avatarCalls && !persona) onAvatarStudio?.(); setAvatarCallsEnabled(!avatarCalls); }} />
      </div>
    )],
    chats: ['Chats', (
      <div className="tools-section">
        <h3>Display</h3>
        <Item icon={darkMode ? Sun : Moon} title="Theme" detail={darkMode ? 'Dark · tap for light' : 'Light · tap for dark'} onClick={onToggleTheme} />
        <Item icon={Image} title="Wallpaper" detail={WALLPAPERS.find((item) => item.id === wallpaper)?.label ?? 'Default'} onClick={() => setPage('wallpaper')} />
        <Item icon={Sparkles} title="Animation" checked={animations} detail={animations ? 'Transitions and motion effects are on' : 'Reduced motion · transitions are off'} onClick={() => setAnimationsEnabled(!animations)} />
        <Item icon={Video} title="Call screen animations" checked={callAnimations}
          detail={!animations ? 'Off while Animation is off' : callAnimations ? 'Ringing pulse, connect and picture-in-picture transitions during calls' : 'Call screens switch instantly, without motion'}
          onClick={() => setCallAnimationsEnabled(!callAnimations)} />
        <h3>Chat settings</h3>
        <Item icon={CornerDownLeft} title="Enter is send" checked={enterIsSend} detail={enterIsSend ? 'Enter sends your message; Shift+Enter starts a new line' : 'Enter starts a new line; tap the send button to send'} onClick={() => setEnterSends(!enterIsSend)} />
        <Item icon={Download} title="Media Save" checked={mediaSave && Boolean(inApp)} disabled={!inApp}
          detail={!inApp ? 'In the Android app: save received photos, videos and files to the phone' : mediaSave ? 'On · received media is saved to Download/Hidden Messenger' : 'Off · received media stays in the chat until you tap download'}
          onClick={() => setMediaSaveEnabled(!mediaSave)} />
        <Item icon={DatabaseBackup} title="Chat backup" detail="Encrypted backup, restore and chat export" onClick={onBackup} />
        <Item icon={Star} title="Starred messages" detail="Saved on your account, on every device" onClick={onStarred} />
      </div>
    )],
  };

  pages.wallpaper = ['Wallpaper', (
    <div className="tools-section">
      <p className="tools-page-note">Shown behind every chat on this device. A chat with its own theme (Contact info › Chat theme) keeps it.</p>
      {['Pattern', 'Solid'].map((kind) => (
        <div key={kind}>
          <h3>{kind === 'Pattern' ? 'Patterns' : 'Solid colours'}</h3>
          <div className="wallpaper-grid" role="radiogroup" aria-label={kind === 'Pattern' ? 'Patterns' : 'Solid colours'}>
            {WALLPAPERS.filter((item) => item.kind === kind).map((item) => (
              <button key={item.id} type="button" role="radio" aria-checked={wallpaper === item.id} className="wallpaper-option" onClick={() => setWallpaper(item.id)}>
                <span className="message-scroll" data-chat-theme="default" data-wallpaper={item.id}>
                  <span className="wp-bubble" /><span className="wp-bubble out" /><span className="wp-bubble" />
                  {wallpaper === item.id && <span className="wallpaper-check" aria-hidden="true"><Check size={14} /></span>}
                </span>
                {item.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )];

  const back = page === 'wallpaper' ? 'chats' : null;
  if (page && pages[page]) {
    const [title, body] = pages[page];
    return (
      <div className="tools-view-container">
        <div className="tools-header">
          <button type="button" className="icon-button" onClick={() => setPage(back)} aria-label={back ? 'Back to chats settings' : 'Back to settings'}><ArrowLeft size={18} /></button>
          <h2>{title}</h2>
        </div>
        <div className="tools-content">{body}</div>
      </div>
    );
  }

  return (
    <div className="tools-view-container">
      <div className="tools-header">
        <h2>Settings</h2>
        <button type="button" className="icon-button" title="Switch account" onClick={() => onAccounts?.()} aria-label="Switch account">
          <Users size={18} />
        </button>
      </div>

      <div className="tools-content">
        <div className="user-profile-section">
          <div className="user-profile-card">
            <ProfilePhoto size="large" />
            <DisplayNameEditor user={user} userId={userId} />
            <button type="button" className="account-switch-btn" onClick={() => onAccounts?.()} aria-label="Switch account" title="Switch account">
              <Users size={18} />
              {accounts.length > 1 && <span className="account-switch-count">{accounts.length}</span>}
            </button>
          </div>
          {accounts.length > 1 && (
            <div className="account-strip" aria-label="Signed-in accounts">
              {accounts.map((account) => (
                <button type="button" key={account.id} className={`account-chip ${account.id === userId ? 'is-active' : ''}`} onClick={() => onAccounts?.()} title={account.id === userId ? 'Active account' : `Switch to @${account.user?.username}`}>
                  <Avatar {...account.user} size="tiny" />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="tools-section">
          <Item icon={Store} title="Business tools" detail="Business profile, catalog, hours, labels and messaging tools" onClick={onBusinessTools} />
        </div>

        <div className="tools-section">
          <Item icon={KeyRound} title="Account" detail="Security, password, two-step verification, linked devices" onClick={onAccountSettings} />
          <Item icon={Lock} title="Privacy" detail="Last seen, status, call links" onClick={() => setPage('privacy')} />
          <Item icon={Smile} title="Avatar" detail="Create, edit, use in video calls" onClick={() => setPage('avatar')} />
          <Item icon={ListChecks} title="Lists" detail="Manage people and groups in your own lists" onClick={() => onSheet?.('lists')} />
          <Item icon={MessageSquare} title="Chats" detail="Theme, animations, media save, backup" onClick={() => setPage('chats')} />
          <Item icon={Bell} title="Notifications" detail="Message, group and call tones" onClick={onNotifications} />
          <Item icon={HardDrive} title="Storage and data" detail="Manage storage, photo upload quality" onClick={onStorage} />
          <Item icon={Languages} title="App language" detail="English, বাংলা, हिन्दी, Español" onClick={() => onSheet?.('language')} />
          <Item icon={CircleHelp} title="Help" detail="Help Center, privacy" onClick={openHelp} />
          <Item icon={UserPlus} title="Invite a friend" detail="Text an invite to someone in your contacts" onClick={() => onSheet?.('invite')} />
        </div>

        <div className="tools-section">
          <h3>More tools</h3>
          <Item icon={Users} title="Create a group" detail="Start a new group chat" onClick={onGroups} />
          <Item icon={Users} title="Create a community" detail="Organize groups under one space" onClick={onCommunities} />
          <Item icon={Radio} title="Channels" detail="Follow channels or start your own" onClick={() => onSheet?.('channels')} />
          <Item icon={Megaphone} title="Broadcast lists" detail="One message, sent privately to many" onClick={() => onSheet?.('broadcasts')} />
          <Item icon={Clock} title="Scheduled messages" detail="Write now, send later (end-to-end encrypted)" onClick={() => onSheet?.('scheduled')} />
          {isAdmin && <Item icon={ShieldCheck} title="Admin console" detail="Statistics, users, reports, Help Center" onClick={() => onSheet?.('admin')} />}
        </div>

        <div className="tools-section">
          <Item icon={Users} title="Accounts" detail={accounts.length > 1 ? `${accounts.length} accounts on this device · switch or add` : 'Add another account and switch anytime'} onClick={onAccounts} />
          <Item icon={LogOut} title="Log out" detail="Sign out from this device" onClick={onLogout} className="logout-item" />
        </div>
      </div>
    </div>
  );
}
