import { setMediaSaveEnabled, useMediaSave } from '../mediaSave.js';
import { nativeShell } from '../native.js';
import { Settings, Users, Plus, ChevronRight, LogOut, Bell, Moon, Sun, Pencil, Check, X, Sparkles, Video, ScanFace, Download } from 'lucide-react';
import { useChatStore } from '../store.js';
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

export default function ToolsView({ darkMode, onToggleTheme, onLogout, onNotifications, onAccountSettings, onAccounts, onAvatarStudio, onGroups }) {
  const user = useChatStore((state) => state.user);
  const userId = useChatStore((state) => state.userId);
  const { accounts } = useAccounts();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const animations = useAnimationsEnabled();
  const callAnimations = useCallAnimationsEnabled();
  const avatarCalls = useAvatarCallsEnabled();
  const persona = usePersona();
  const mediaSave = useMediaSave();
  const inApp = nativeShell();

  return (
    <div className="tools-view-container">
      <div className="tools-header">
        <h2>Tools</h2>
        <button 
          className="icon-button" 
          title="More options"
          onClick={() => setSettingsOpen(!settingsOpen)}
          aria-label="Open settings"
        >
          <Settings size={18} />
        </button>
      </div>

      <div className="tools-content">
        {/* User Profile Card */}
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

        {/* Workspace & Communities */}
        <div className="tools-section">
          <h3>Workspace & Communities</h3>
          <button className="tool-item" onClick={onGroups}>
            <Users size={20} />
            <div className="tool-item-info">
              <strong>Create a group</strong>
              <small>Start a new group chat</small>
            </div>
            <ChevronRight size={16} />
          </button>
          <button className="tool-item">
            <Users size={20} />
            <div className="tool-item-info">
              <strong>Create a community</strong>
              <small>Organize groups under one space</small>
            </div>
            <ChevronRight size={16} />
          </button>
        </div>

        {/* Settings & Preferences */}
        <div className="tools-section">
          <h3>Settings & Preferences</h3>
          <button className="tool-item" onClick={() => onNotifications?.()}>
            <Bell size={20} />
            <div className="tool-item-info">
              <strong>Notifications</strong>
              <small>Tones, vibration, reminders and badges</small>
            </div>
            <ChevronRight size={16} />
          </button>
          <button className="tool-item" onClick={() => onToggleTheme?.()}>
            {darkMode ? <Sun size={20} /> : <Moon size={20} />}
            <div className="tool-item-info">
              <strong>Theme</strong>
              <small>Switch to {darkMode ? 'light' : 'dark'} mode</small>
            </div>
            <ChevronRight size={16} />
          </button>
          <button type="button" className="tool-item" role="switch" aria-checked={animations} onClick={() => setAnimationsEnabled(!animations)}>
            <Sparkles size={20} />
            <div className="tool-item-info">
              <strong>Animation</strong>
              <small>{animations ? 'Transitions and motion effects are on' : 'Reduced motion · transitions are off'}</small>
            </div>
            <span className={`wa-switch${animations ? ' on' : ''}`} aria-hidden="true"><span /></span>
          </button>
          <button type="button" className="tool-item" role="switch" aria-checked={avatarCalls} onClick={() => { if (!avatarCalls && !persona) onAvatarStudio?.(); setAvatarCallsEnabled(!avatarCalls); }}>
            <ScanFace size={20} />
            <div className="tool-item-info">
              <strong>Animation Video Call</strong>
              <small>
                {avatarCalls
                  ? `Your cartoon avatar (${personaCharacter(persona).name}) replaces your camera in video calls`
                  : persona ? 'Video calls send your real camera' : 'Scan your face once and pick a cartoon character'}
              </small>
            </div>
            <span className={`wa-switch${avatarCalls ? ' on' : ''}`} aria-hidden="true"><span /></span>
          </button>
          <button className="tool-item" onClick={() => onAvatarStudio?.()}>
            <AvatarThumb persona={persona} />
            <div className="tool-item-info">
              <strong>Your avatar</strong>
              <small>{persona ? `${personaCharacter(persona).name} · ${persona.profile ? 'face scan saved' : 'not scanned yet'} · tap to change` : 'Set up your animated avatar'}</small>
            </div>
            <ChevronRight size={16} />
          </button>
          <button type="button" className="tool-item" role="switch" aria-checked={callAnimations} onClick={() => setCallAnimationsEnabled(!callAnimations)}>
            <Video size={20} />
            <div className="tool-item-info">
              <strong>Call screen animations</strong>
              <small>
                {!animations
                  ? 'Off while Animation is off'
                  : callAnimations
                    ? 'Ringing pulse, connect and picture-in-picture transitions during calls'
                    : 'Call screens switch instantly, without motion'}
              </small>
            </div>
            <span className={`wa-switch${callAnimations ? ' on' : ''}`} aria-hidden="true"><span /></span>
          </button>
          <button type="button" className="tool-item" role="switch" aria-checked={mediaSave} disabled={!inApp} onClick={() => setMediaSaveEnabled(!mediaSave)}>
            <Download size={20} />
            <div className="tool-item-info">
              <strong>Media Save</strong>
              <small>
                {!inApp
                  ? 'In the Android app: save received photos, videos and files to the phone'
                  : mediaSave
                    ? 'On · received media is saved to Download/Hidden Messenger'
                    : 'Off · received media stays in the chat until you tap download'}
              </small>
            </div>
            <span className={`wa-switch${mediaSave && inApp ? ' on' : ''}`} aria-hidden="true"><span /></span>
          </button>
          <button className="tool-item" onClick={() => onAccounts?.()}>
            <Users size={20} />
            <div className="tool-item-info">
              <strong>Accounts</strong>
              <small>{accounts.length > 1 ? `${accounts.length} accounts on this device · switch or add` : 'Add another account and switch anytime'}</small>
            </div>
            <ChevronRight size={16} />
          </button>
          <button className="tool-item" onClick={() => onAccountSettings?.()}>
            <Settings size={20} />
            <div className="tool-item-info">
              <strong>Account & privacy</strong>
              <small>Last seen, change password, linked devices</small>
            </div>
            <ChevronRight size={16} />
          </button>
        </div>

        {/* Account Actions */}
        <div className="tools-section">
          <button 
            className="tool-item logout-item"
            onClick={onLogout}
          >
            <LogOut size={20} />
            <div className="tool-item-info">
              <strong>Log out</strong>
              <small>Sign out from this device</small>
            </div>
            <ChevronRight size={16} />
          </button>
        </div>

        {/* Workspace Info Footer */}
        <div className="tools-footer">
          <div className="workspace-info">
            <span><i /> Hidden Messenger workspace</span>
            <small>Demo mode</small>
          </div>
        </div>
      </div>
    </div>
  );
}
