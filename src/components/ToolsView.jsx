import { setMediaSaveEnabled, useMediaSave } from '../mediaSave.js';
import { nativeGetAppIcon, nativeOpenExternal, nativeSetAppIcon, nativeShell } from '../native.js';
import { APP_ICONS, appIconLabel } from '../appIcons.js';
import { THEME_CHOICES } from '../appearance.js';
import { appSettings, useSetting } from '../settings.js';
import { parseEventContent } from '../calendarEvents.js';
import { cachedGroups } from '../groupCache.js';
import { fetchGroupMessages } from '../groupHistory.js';
import { ABOUT_MAX, ABOUT_SUGGESTIONS, fetchMyAbout, saveMyAbout } from '../aboutApi.js';
import BrandMark from './BrandMark.jsx';
import packageInfo from '../../package.json';
import { Archive, CalendarDays, FileText, Info, MessageCircleQuestion, Palette, Scale, Share2 } from 'lucide-react';
import { Accessibility, ArrowLeft, ChevronDown, MonitorSmartphone, QrCode, Bell, Check, ChevronRight, Contrast, CornerDownLeft, ListChecks, Type, CircleHelp, Clock, DatabaseBackup, Download, HardDrive, KeyRound, Languages, Link2, Lock, LogOut, Megaphone, MessageSquare, Moon, Pencil, Radio, ScanFace, ShieldCheck, Sparkles, Star, Store, Sun, UserPlus, Users, Video, X } from 'lucide-react';
import { useChatStore } from '../store.js';
import { WALLPAPERS, setWallpaper, useWallpaper } from '../wallpaper.js';
import { setEnterSends, useEnterSends } from '../enterSends.js';
import { FONT_SIZES, fontSizeLabel, setFontSize, setHighContrast, useFontSize, useHighContrast } from '../displayPrefs.js';
import ProfilePhoto from './ProfilePhoto.jsx';
import Avatar from './Avatar.jsx';
import { useAccounts } from '../accounts.js';
import { MAX_DISPLAY_NAME, hasCustomDisplayName, presentName, updateDisplayName } from '../profile.js';
import { useAnimationsEnabled, useAvatarCallsEnabled, useCallAnimationsEnabled, setAnimationsEnabled, setAvatarCallsEnabled, setCallAnimationsEnabled } from '../appearance.js';
import { personaCharacter, usePersona } from '../avatar/persona.js';
import { drawAvatar, idleExpression } from '../avatar/characters.js';
import { useEffect, useRef, useState } from 'react';
import VerifiedBadge from './VerifiedBadge.jsx';

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
// About: a short line under your name (WhatsApp's "About"), with its ready-made choices. Who sees it: Privacy › About.
export function AboutEditor() {
  const sessionToken = useChatStore((state) => state.sessionToken);
  const [about, setAbout] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!sessionToken) return undefined;
    let cancelled = false;
    fetchMyAbout(sessionToken).then((text) => { if (!cancelled) setAbout(text); }).catch(() => { if (!cancelled) setAbout(''); });
    return () => { cancelled = true; };
  }, [sessionToken]);
  async function save(text) {
    setBusy(true);
    setError('');
    try {
      setAbout(await saveMyAbout(sessionToken, text));
      setEditing(false);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  }
  if (!editing) {
    return (
      <button type="button" className="about-row" onClick={() => { setDraft(about ?? ''); setEditing(true); }} disabled={about === null}>
        <small>About</small>
        <span>{about === null ? 'Loading…' : about || 'Add About'}</span>
      </button>
    );
  }
  return (
    <form className="about-editor" onSubmit={(event) => { event.preventDefault(); save(draft); }}>
      <label><small>About</small>
        <input value={draft} maxLength={ABOUT_MAX} onChange={(event) => setDraft(event.target.value)} autoFocus aria-label="About" />
      </label>
      <span className="about-count">{ABOUT_MAX - draft.length}</span>
      <div className="about-suggestions">
        {ABOUT_SUGGESTIONS.map((text) => <button key={text} type="button" onClick={() => save(text)} disabled={busy}>{text}</button>)}
      </div>
      {error && <p className="notif-error" role="alert">{error}</p>}
      <div className="about-actions">
        <button type="button" onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
        <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );
}

export function DisplayNameEditor({ user, userId }) {
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
        <strong>{user ? presentName(user) : 'Connecting...'}{user?.verified && <VerifiedBadge size={16} />}</strong>
        <button type="button" className="display-name-pencil" onClick={startEditing} disabled={!user || !sessionToken} aria-label="Edit display name" title="Edit display name">
          <Pencil size={13} />
        </button>
      </span>
      {user && !hasCustomDisplayName(user) && <small className="display-name-hint">Add a display name</small>}
      {(!user || hasCustomDisplayName(user)) && <small className="user-handle">@{user?.username ?? userId}</small>}
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


const SITE = 'https://hiddenmessenger.com';
// Privacy Policy and Terms of Service open on the website (the phone's browser in the app).
function openSitePage(path) {
  const url = `${SITE}${path}`;
  if (nativeShell()) nativeOpenExternal(url);
  else window.open(url, '_blank', 'noopener');
}

const eventTime = (startsAt) => new Date(startsAt).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

// Settings › Events (WhatsApp): every event card from your chats and groups, upcoming first, then past events.
function EventsPage() {
  const chats = useChatStore((state) => state.chats);
  const messages = useChatStore((state) => state.messages);
  const userId = useChatStore((state) => state.userId);
  const token = useChatStore((state) => state.sessionToken);
  const [groupEvents, setGroupEvents] = useState([]);
  const [loadingGroups, setLoadingGroups] = useState(true);
  useEffect(() => {
    if (!userId || !token) { setLoadingGroups(false); return undefined; }
    let cancelled = false;
    (async () => {
      const groups = ((await cachedGroups(userId).catch(() => null)) ?? []).slice(0, 30);
      const found = [];
      for (const group of groups) {
        if (cancelled) return;
        try {
          for (const message of await fetchGroupMessages(token, group.id)) {
            const event = parseEventContent(message.content);
            if (event) found.push({ id: message.id, event, where: group.name });
          }
        } catch { /* offline or left the group */ }
      }
      if (!cancelled) { setGroupEvents(found); setLoadingGroups(false); }
    })();
    return () => { cancelled = true; };
  }, [userId, token]);
  const direct = chats.flatMap((chat) => (messages[chat.id] ?? []).map((message) => ({ id: message.id, event: parseEventContent(message.content), where: presentName(chat) || chat.name })))
    .filter((item) => item.event);
  const now = Date.now();
  const all = [...direct, ...groupEvents];
  const upcoming = all.filter((item) => new Date(item.event.startsAt).getTime() >= now).sort((a, b) => new Date(a.event.startsAt) - new Date(b.event.startsAt));
  const past = all.filter((item) => new Date(item.event.startsAt).getTime() < now).sort((a, b) => new Date(b.event.startsAt) - new Date(a.event.startsAt));
  const row = (item) => (
    <div className="tool-item events-row" key={item.id}>
      <CalendarDays size={20} />
      <div className="tool-item-info"><strong>{item.event.title}</strong><small>{eventTime(item.event.startsAt)}{item.event.location ? ` · ${item.event.location}` : ''} · {item.where}</small></div>
    </div>
  );
  return (
    <div className="tools-section">
      {upcoming.length ? upcoming.map(row) : (
        <div className="events-empty"><CalendarDays size={36} /><strong>No upcoming events</strong><small>Events you create or are invited to in chats and groups appear here.</small></div>
      )}
      {past.length > 0 && <h3>Past events</h3>}
      {past.map(row)}
      {loadingGroups && <p className="tools-page-note">Looking through your groups…</p>}
    </div>
  );
}

// Settings, in the order a business messenger uses: Business tools first, then Account, Privacy, Avatar, Chats,
// Notifications, Storage and data, App language, Help, Invite a friend. Privacy, Avatar and Chats open their own
// page here; the rest open their panels.
export default function ToolsView({ darkMode, themePref = 'light', onChooseTheme, onToggleTheme, onLogout, onNotifications, onAccountSettings, onAccounts, onAvatarStudio, onGroups, onCommunities, onBusinessTools, onStarred, onBackup, onStorage, onSheet, onBack }) {
  const user = useChatStore((state) => state.user);
  const userId = useChatStore((state) => state.userId);
  const { accounts } = useAccounts();
  const [page, setPageState] = useState(null);
  const [previousPage, setPreviousPage] = useState(null);
  const setPage = (next) => { setPreviousPage(page); setPageState(next); };
  const fontSize = useFontSize();
  const highContrast = useHighContrast();
  const animations = useAnimationsEnabled();
  const callAnimations = useCallAnimationsEnabled();
  const avatarCalls = useAvatarCallsEnabled();
  const persona = usePersona();
  const mediaSave = useMediaSave();
  const inApp = nativeShell();
  const wallpaper = useWallpaper();
  const enterIsSend = useEnterSends();
  const keepArchived = useSetting('chats.keepArchived');
  // App icon (Android app only): which launcher icon is on.
  const [appIcon, setAppIcon] = useState('default');
  const [iconNote, setIconNote] = useState('');
  useEffect(() => { if (inApp) nativeGetAppIcon().then((id) => { if (id) setAppIcon(id); }).catch(() => {}); }, [inApp]);
  async function chooseAppIcon(id) {
    const done = await nativeSetAppIcon(id);
    if (done) { setAppIcon(done); setIconNote('Your home screen shows the new icon in a moment. If an old shortcut disappears, add Hidden Messenger to the home screen again from the app drawer.'); }
    else setIconNote('The icon could not be changed on this phone.');
  }
  const themeLabel = THEME_CHOICES.find((choice) => choice.id === themePref)?.label ?? 'Light';
  // The Help Center opens in the app (articles, search, Contact us → Hidden Messenger Support).
  const openHelp = () => onSheet?.('help');

  const pages = {
    accessibility: ['Accessibility', (
      <div className="tools-section">
        <Item icon={Contrast} title="Increase contrast" checked={highContrast} detail={highContrast ? 'Stronger text and borders, plain backgrounds' : 'Standard colours'} onClick={() => setHighContrast(!highContrast)} />
        <Item icon={Sparkles} title="Reduce motion" checked={!animations} detail={!animations ? 'Screens switch without animation' : 'Transitions and motion effects are on'} onClick={() => setAnimationsEnabled(!animations)} />
        <Item icon={Type} title="Font size" detail={fontSizeLabel(fontSize)} onClick={() => setPage('fontsize')} />
      </div>
    )],
    fontsize: ['Font size', (
      <div className="tools-section" role="radiogroup" aria-label="Font size">
        <p className="tools-page-note">Changes the size of messages and chat names on this device.</p>
        {FONT_SIZES.map(([id, label]) => (
          <button key={id} type="button" role="radio" aria-checked={fontSize === id} className={`tool-item font-size-option size-${id}`} onClick={() => setFontSize(id)}>
            <Type size={20} />
            <div className="tool-item-info"><strong>{label}</strong><small>The quick brown fox</small></div>
            {fontSize === id && <Check size={18} />}
          </button>
        ))}
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
        <Item icon={darkMode ? Moon : Sun} title="Theme" detail={themeLabel} onClick={() => setPage('theme')} />
        <Item icon={Palette} title="Default chat theme" detail={WALLPAPERS.find((item) => item.id === wallpaper)?.label ?? 'Default'} onClick={() => setPage('wallpaper')} />
        <Item icon={Sparkles} title="Animation" checked={animations} detail={animations ? 'Transitions and motion effects are on' : 'Reduced motion · transitions are off'} onClick={() => setAnimationsEnabled(!animations)} />
        <Item icon={Video} title="Call screen animations" checked={callAnimations}
          detail={!animations ? 'Off while Animation is off' : callAnimations ? 'Ringing pulse, connect and picture-in-picture transitions during calls' : 'Call screens switch instantly, without motion'}
          onClick={() => setCallAnimationsEnabled(!callAnimations)} />
        <h3>Chat settings</h3>
        <Item icon={CornerDownLeft} title="Enter is send" checked={enterIsSend} detail={enterIsSend ? 'Enter sends your message; Shift+Enter starts a new line' : 'Enter starts a new line; tap the send button to send'} onClick={() => setEnterSends(!enterIsSend)} />
        <Item icon={Type} title="Font size" detail={fontSizeLabel(fontSize)} onClick={() => setPage('fontsize')} />
        <Item icon={Download} title="Media visibility" checked={mediaSave && Boolean(inApp)} disabled={!inApp}
          detail={!inApp ? 'In the Android app: show newly downloaded media in your phone’s gallery' : mediaSave ? 'On · new photos, videos and files also go to the phone’s gallery (Download/Hidden Messenger)' : 'Off · media stays inside Hidden Messenger'}
          onClick={() => setMediaSaveEnabled(!mediaSave)} />
        <h3>Archived chats</h3>
        <Item icon={Archive} title="Keep chats archived" checked={keepArchived}
          detail={keepArchived ? 'Archived chats stay archived when you get a new message' : 'A new message brings an archived chat back to the list'}
          onClick={() => appSettings().set('chats.keepArchived', !keepArchived)} />
        <h3>Chat history</h3>
        <Item icon={DatabaseBackup} title="Chat backup" detail="Encrypted backup, restore and chat export" onClick={onBackup} />
        <Item icon={Star} title="Starred messages" detail="Saved on your account, on every device" onClick={onStarred} />
      </div>
    )],
  };

  pages.appearance = ['Appearance', (
    <div className="tools-section">
      <Item icon={Palette} title="Default chat theme" detail={WALLPAPERS.find((item) => item.id === wallpaper)?.label ?? 'Default'} onClick={() => setPage('wallpaper')} />
      <Item iconNode={<BrandMark className="tool-item-appicon" colors={APP_ICONS.find((icon) => icon.id === appIcon)} />} title="App icon"
        detail={inApp ? appIconLabel(appIcon) : 'In the Android app'} onClick={() => setPage('appicon')} />
      <Item icon={darkMode ? Moon : Sun} title="App theme" detail={themeLabel} onClick={() => setPage('theme')} />
      <h3>Motion</h3>
      <Item icon={Sparkles} title="Animation" checked={animations} detail={animations ? 'Transitions and motion effects are on' : 'Reduced motion · transitions are off'} onClick={() => setAnimationsEnabled(!animations)} />
      <Item icon={Video} title="Call screen animations" checked={callAnimations}
        detail={!animations ? 'Off while Animation is off' : callAnimations ? 'Ringing pulse, connect and picture-in-picture transitions during calls' : 'Call screens switch instantly, without motion'}
        onClick={() => setCallAnimationsEnabled(!callAnimations)} />
      <h3>Avatar</h3>
      <Item iconNode={<AvatarThumb persona={persona} />} title="Avatar" detail="Create, edit, use in video calls" onClick={() => setPage('avatar')} />
    </div>
  )];
  pages.theme = ['App theme', (
    <div className="tools-section" role="radiogroup" aria-label="App theme">
      {THEME_CHOICES.map((choice) => (
        <button key={choice.id} type="button" role="radio" aria-checked={themePref === choice.id} className="tool-item" onClick={() => onChooseTheme?.(choice.id)}>
          {choice.id === 'dark' ? <Moon size={20} /> : choice.id === 'light' ? <Sun size={20} /> : <Contrast size={20} />}
          <div className="tool-item-info"><strong>{choice.label}</strong>{choice.id === 'system' && <small>Follows your phone’s light or dark setting</small>}</div>
          {themePref === choice.id && <Check size={18} />}
        </button>
      ))}
    </div>
  )];
  pages.appicon = ['App icon', (
    <div className="tools-section">
      <p className="tools-page-note">{inApp ? 'Choose the icon on your phone’s home screen and app drawer.' : 'The app icon can be changed in the Android app.'}</p>
      <div className="app-icon-grid" role="radiogroup" aria-label="App icon">
        {APP_ICONS.map((icon) => (
          <button key={icon.id} type="button" role="radio" aria-checked={appIcon === icon.id} className={`app-icon-option${appIcon === icon.id ? ' is-on' : ''}`} disabled={!inApp} onClick={() => chooseAppIcon(icon.id)}>
            <BrandMark colors={icon} />
            <span>{icon.label}</span>
          </button>
        ))}
      </div>
      {iconNote && <p className="tools-page-note" role="status">{iconNote}</p>}
    </div>
  )];
  pages.events = ['Events', <EventsPage key="events" />];
  pages.help = ['Help and feedback', (
    <div className="tools-section">
      <Item icon={CircleHelp} title="Help Centre" detail="Get help, contact us" onClick={openHelp} />
      <Item icon={MessageCircleQuestion} title="Send feedback" detail="Report technical issues or suggest an idea" onClick={() => onSheet?.('support')} />
      <Item icon={ShieldCheck} title="Privacy Policy" detail="How your messages and data are handled" onClick={() => openSitePage('/privacy')} />
      <Item icon={Scale} title="Terms of Service" detail="The rules for using Hidden Messenger" onClick={() => openSitePage('/terms')} />
      <Item icon={Info} title="App info" detail={`Version ${packageInfo.version}`} onClick={() => setPage('appinfo')} />
    </div>
  )];
  pages.appinfo = ['App info', (
    <div className="tools-section app-info">
      <BrandMark className="app-info-mark" />
      <strong>Hidden Messenger</strong>
      <small>Version {packageInfo.version}{inApp ? ' · Android' : ' · Web'}</small>
      <p>Private messaging without a phone number. Messages, calls and files are end-to-end encrypted.</p>
      <Item icon={FileText} title="Privacy Policy" onClick={() => openSitePage('/privacy')} />
      <Item icon={Scale} title="Terms of Service" onClick={() => openSitePage('/terms')} />
      <Item icon={Share2} title="hiddenmessenger.com" onClick={() => openSitePage('/')} />
      <small>© {new Date().getFullYear()} Hidden Messenger</small>
    </div>
  )];

  pages.wallpaper = ['Default chat theme', (
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

  // Sub-pages step back to the page they were opened from (wallpaper, theme and app icon from Chats or Appearance).
  const back = ['wallpaper', 'fontsize', 'theme', 'appicon', 'avatar'].includes(page) ? (previousPage !== page ? previousPage : null) : page === 'appinfo' ? 'help' : null;
  if (page && pages[page]) {
    const [title, body] = pages[page];
    return (
      <div className="tools-view-container">
        <div className="tools-header">
          <button type="button" className="icon-button" onClick={() => setPage(back)} aria-label={back ? `Back to ${back === 'chats' ? 'chats settings' : back}` : 'Back to settings'}><ArrowLeft size={18} /></button>
          <h2>{title}</h2>
        </div>
        <div className="tools-content">{body}</div>
      </div>
    );
  }

  return (
    <div className="tools-view-container">
      <div className="tools-header">
        {onBack && <button type="button" className="icon-button" onClick={onBack} aria-label="Close settings"><ArrowLeft size={20} /></button>}
        <h2>Settings</h2>
      </div>

      <div className="tools-content">
        <div className="user-profile-section">
          <div className="user-profile-card">
            <ProfilePhoto size="large" />
            <DisplayNameEditor user={user} userId={userId} />
            <button type="button" className="profile-qr-btn" onClick={() => onSheet?.('shortlink')} aria-label="QR code" title="Your QR code and short link"><QrCode size={20} /></button>
            <button type="button" className="account-switch-btn" onClick={() => onAccounts?.()} aria-label="Switch account" title="Switch account">
              <ChevronDown size={20} />
              {accounts.length > 1 && <span className="account-switch-count">{accounts.length}</span>}
            </button>
          </div>
          <AboutEditor />
          {/* WhatsApp Business: tapping your profile in Settings opens Edit profile. */}
          <button type="button" className="about-row profile-edit-row" onClick={() => onSheet?.('businessprofile')}>
            <small>Edit profile</small>
            <span>Photo, cover, business information, links and contact details</span>
          </button>
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

        {/* On the phone, business tools are their own tab (Tools); on a computer they stay here. */}
        {!onBack && (
          <div className="tools-section">
            <Item icon={Store} title="Business tools" detail="Profile, catalog, labels, away messages" onClick={onBusinessTools} />
          </div>
        )}

        <div className="tools-section">
          <Item iconNode={<span className="tool-item-badge"><VerifiedBadge size={22} /></span>} title="Verified" detail={user?.verified ? 'Your business is verified' : 'Get the verified badge for your business'} onClick={() => onSheet?.('verified')} />
          <Item icon={MonitorSmartphone} title="Linked devices" detail="Use your account on a computer" onClick={() => onAccountSettings?.('devices')} />
          <Item icon={KeyRound} title="Account" detail="Security notifications, password, two-step" onClick={() => onAccountSettings?.('account')} />
          <Item icon={Lock} title="Privacy" detail="Blocked accounts, disappearing messages" onClick={() => onAccountSettings?.('privacy')} />
          <Item icon={ListChecks} title="Lists" detail="Manage people and groups" onClick={() => onSheet?.('lists')} />
          <Item icon={MessageSquare} title="Chats" detail="Theme, wallpapers, chat history" onClick={() => setPage('chats')} />
          <Item icon={Palette} title="Appearance" detail="Chat theme, app icon, app theme" onClick={() => setPage('appearance')} />
          <Item icon={CalendarDays} title="Events" detail="View and manage events" onClick={() => setPage('events')} />
          <Item icon={Bell} title="Notifications" detail="Message, group and call tones" onClick={onNotifications} />
          <Item icon={HardDrive} title="Storage and data" detail="Network usage, auto-download" onClick={onStorage} />
          <Item icon={Store} title="Facebook & Instagram" detail="Your links on your business profile" onClick={() => onSheet?.('businessprofile')} />
          <Item icon={Accessibility} title="Accessibility" detail="Increase contrast, animation" onClick={() => setPage('accessibility')} />
          <Item icon={Languages} title="App language" detail="English, বাংলা, हिन्दी, Español" onClick={() => onSheet?.('language')} />
          <Item icon={CircleHelp} title="Help and feedback" detail="Help Centre, contact us, privacy policy" onClick={() => setPage('help')} />
          <Item icon={UserPlus} title="Invite a contact" detail="Invite someone from your contacts" onClick={() => onSheet?.('invite')} />
        </div>

        <div className="tools-section">
          <h3>More tools</h3>
          <Item icon={Users} title="Create a group" detail="Start a new group chat" onClick={onGroups} />
          <Item icon={Users} title="Create a community" detail="Organize groups under one space" onClick={onCommunities} />
          <Item icon={Radio} title="Channels" detail="Follow channels or start your own" onClick={() => onSheet?.('channels')} />
          <Item icon={Megaphone} title="Broadcast lists" detail="One message, sent privately to many" onClick={() => onSheet?.('broadcasts')} />
          <Item icon={Link2} title="Call links" detail="Let people call you with a link, revoke any time" onClick={() => onSheet?.('calllinks')} />
          <Item icon={Clock} title="Scheduled messages" detail="Write now, send later (end-to-end encrypted)" onClick={() => onSheet?.('scheduled')} />
        </div>

        <div className="tools-section">
          <Item icon={Users} title="Accounts" detail={accounts.length > 1 ? `${accounts.length} accounts on this device · switch or add` : 'Add another account and switch anytime'} onClick={onAccounts} />
          <Item icon={LogOut} title="Log out" detail="Sign out from this device" onClick={onLogout} className="logout-item" />
        </div>
      </div>
    </div>
  );
}
