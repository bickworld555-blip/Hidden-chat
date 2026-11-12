import { DeviceSecuritySettings, TwoStepSettings } from './parity/SecurityViews.jsx';
import { useBackHandler } from '../backStack.js';
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, KeyRound, Laptop, Smartphone, Trash2 } from 'lucide-react';
import { apiFetch } from '../api.js';
import { saveBlob } from '../media.js';
import { useChatStore } from '../store.js';
import { changePassword, listDevices, signOutDevice } from '../accountApi.js';
import { SECTIONS, SETTINGS, appSettings, optionLabel, useAccountSettingsLoaded, useSetting } from '../settings.js';
import { formatLastSeen } from '../presence.js';
import { LinkScanner } from './LinkDevice.jsx';
import { RadioList, Row, SubView } from './NotificationSettings.jsx';

const isPhone = (name = '') => /Android|iOS/.test(name);

function deviceStatus(device) {
  if (device.current) return 'This device';
  if (device.online) return 'Active now';
  if (device.lastActiveAt) return formatLastSeen(device.lastActiveAt).replace(/^last seen/, 'Last active');
  return 'Signed in';
}

function PasswordForm({ sessionToken, onDone }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event) {
    event.preventDefault();
    if (next.length < 10) return setError('Use at least 10 characters.');
    if (next !== confirm) return setError('The new passwords do not match.');
    setBusy(true);
    setError('');
    try {
      const { signedOutDevices } = await changePassword(sessionToken, current, next);
      onDone(signedOutDevices ? `Password changed. ${signedOutDevices} other device${signedOutDevices === 1 ? ' was' : 's were'} signed out.` : 'Password changed.');
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="account-form" onSubmit={submit}>
      <label>Current password<input type="password" autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} required maxLength={128} /></label>
      <label>New password<input type="password" autoComplete="new-password" value={next} onChange={(event) => setNext(event.target.value)} required minLength={10} maxLength={128} /></label>
      <label>Confirm new password<input type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} required maxLength={128} /></label>
      <p className="account-hint">Changing your password signs you out on every other device.</p>
      {error && <p className="notif-error" role="alert">{error}</p>}
      <button type="submit" className="account-primary" disabled={busy || !current || !next || !confirm}>{busy ? 'Saving…' : 'Change password'}</button>
    </form>
  );
}

function Devices({ devices, onSignOut, error }) {
  const [busyId, setBusyId] = useState('');
  return (
    <>
      <section className="wa-info-section">
        <h3>Signed in on</h3>
        {devices === null && <p className="account-hint">Loading…</p>}
        {devices?.map((device) => (
          <div key={device.id} className="wa-info-row account-device">
            {isPhone(device.deviceName) ? <Smartphone size={22} className="wa-info-row-icon" aria-hidden="true" /> : <Laptop size={22} className="wa-info-row-icon" aria-hidden="true" />}
            <span className="wa-info-row-text">
              <span>{device.deviceName}</span>
              <small className={device.current || device.online ? 'is-active' : ''}>{deviceStatus(device)}</small>
            </span>
            {!device.current && (
              <button
                type="button"
                className="account-logout"
                disabled={busyId === device.id}
                onClick={async () => {
                  if (!window.confirm(`Log out ${device.deviceName}?`)) return;
                  setBusyId(device.id);
                  await onSignOut(device.id);
                  setBusyId('');
                }}
              >
                Log out
              </button>
            )}
          </div>
        ))}
        {error && <p className="notif-error" role="alert">{error}</p>}
      </section>
      <p className="account-hint account-hint-padded">
        To use Hidden Messenger on a computer, open hiddenmessenger.com or the desktop app there and scan its QR code with <strong>Link a device</strong>. Every device here can read and send your messages.
      </p>
    </>
  );
}

// A choice setting's own screen (Everyone / My contacts / Nobody …), read from the settings registry.
function PrivacyChoice({ settingKey, onChange, onBack }) {
  const value = useSetting(settingKey);
  const definition = SETTINGS[settingKey];
  return <RadioList title={definition.label} options={definition.options} value={value} onChange={onChange} onBack={onBack} />;
}

// The privacy section: one row per registered privacy setting (choices open their screen, switches toggle).
function PrivacyRows({ onOpen, onToggle }) {
  const loaded = useAccountSettingsLoaded();
  return SECTIONS.privacy.keys.map((key) => <PrivacyRow key={key} settingKey={key} loaded={loaded} onOpen={onOpen} onToggle={onToggle} />);
}

function PrivacyRow({ settingKey, loaded, onOpen, onToggle }) {
  const value = useSetting(settingKey);
  const definition = SETTINGS[settingKey];
  if (definition.type === 'switch') {
    return (
      <Row title={definition.label} subtitle={loaded ? (definition.hint ?? (value ? 'On' : 'Off')) : 'Loading…'} onClick={() => onToggle(settingKey, !value)} disabled={!loaded}>
        <span className={`wa-switch${value ? ' on' : ''}`} aria-hidden="true"><span /></span>
      </Row>
    );
  }
  return <Row title={definition.label} subtitle={loaded ? optionLabel(settingKey, value) : 'Loading…'} onClick={() => onOpen(settingKey)} disabled={!loaded} />;
}

// Delete my account: explains what happens, then asks for the password and the username (server/account.mjs).
function DeleteAccount({ sessionToken, username, onDeleted }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await apiFetch('/api/v1/me', { method: 'DELETE', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ password, confirm: confirm.trim().replace(/^@/, '') }) });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'The account could not be deleted.');
      onDeleted?.();
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }
  return (
    <form className="account-delete" onSubmit={submit}>
      <p>Deleting your account will:</p>
      <ul>
        <li>sign you out on every device and remove your encryption keys</li>
        <li>delete your profile, contacts list, statuses, business profile, catalog, labels and the channels you own</li>
        <li>remove you from your groups and delete the copies of your messages kept on the server</li>
      </ul>
      <p className="account-hint">Messages already on other people’s phones stay with them. This can’t be undone. Save a chat backup first if you want to keep your chats.</p>
      <label className="hm-field">Password<input className="hm-input" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <label className="hm-field">Type your username ({username}) to confirm<input className="hm-input" autoCapitalize="none" value={confirm} onChange={(event) => setConfirm(event.target.value)} /></label>
      {error && <p className="notif-error" role="alert">{error}</p>}
      <button type="submit" className="account-delete-button" disabled={busy || !password || confirm.trim().replace(/^@/, '') !== username}><Trash2 size={16} /> {busy ? 'Deleting…' : 'Delete my account'}</button>
    </form>
  );
}

// section "account": security, linked devices, account info, deletion. section "privacy": who sees what, status, app lock.
export default function AccountSettings({ onClose, section = 'account', initialView = null, onOpenSheet, onAccountDeleted }) {
  const username = useChatStore((state) => state.user?.username ?? '');
  const [scanning, setScanning] = useState(false);
  const sessionToken = useChatStore((state) => state.sessionToken);
  const [view, setView] = useState(initialView);
  // Android Back leaves a sub-screen first; the screen itself is closed by its opener.
  useBackHandler(Boolean(view), () => setView(null));
  const [devices, setDevices] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadDevices = useCallback(() => listDevices(sessionToken).then(setDevices).catch((failure) => setError(failure.message)), [sessionToken]);

  useEffect(() => {
    if (!sessionToken) return;
    appSettings().loadAccount().catch((failure) => setError(failure.message));
    loadDevices();
  }, [sessionToken, loadDevices]);

  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') (view ? setView(null) : onClose()); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, onClose]);

  // A privacy change shows at once; if the server refuses it, it goes back and the reason is shown.
  async function changeSetting(key, value) {
    setError('');
    try {
      await appSettings().set(key, value);
    } catch (failure) {
      setError(failure.message);
    }
  }

  // Account info: a JSON report, saved like any other file.
  async function requestInfo() {
    setError('');
    try {
      const response = await apiFetch('/api/v1/me/account-info', { headers: { Authorization: `Bearer ${sessionToken}` } });
      if (!response.ok) throw new Error('Your account info could not be prepared. Try again.');
      saveBlob(new Blob([JSON.stringify(await response.json(), null, 2)], { type: 'application/json' }), `hidden-messenger-account-info-${username || 'account'}.json`);
      setNotice('Your account info was saved to your downloads.');
    } catch (failure) {
      setError(failure.message);
    }
  }

  async function removeDevice(deviceId) {
    setError('');
    try {
      await signOutDevice(sessionToken, deviceId);
      setDevices((list) => list?.filter((device) => device.id !== deviceId) ?? list);
    } catch (failure) {
      setError(failure.message);
      loadDevices();
    }
  }

  let content;
  if (view && SETTINGS[view]?.type === 'choice') {
    content = <PrivacyChoice settingKey={view} onChange={(value) => changeSetting(view, value)} onBack={() => setView(null)} />;
  } else if (view === 'password') {
    content = (
      <SubView title="Change password" onBack={() => setView(null)}>
        <PasswordForm sessionToken={sessionToken} onDone={(message) => { setNotice(message); setView(null); loadDevices(); }} />
      </SubView>
    );
  } else if (view === 'delete') {
    content = (
      <SubView title="Delete my account" onBack={() => setView(null)}>
        <DeleteAccount sessionToken={sessionToken} username={username} onDeleted={onAccountDeleted} />
      </SubView>
    );
  } else if (view === 'devices') {
    content = (
      <SubView title="Linked devices" onBack={() => { setScanning(false); setView(null); }}>
        {scanning ? (
          <LinkScanner token={sessionToken} onCancel={() => setScanning(false)}
            onDone={(name, result) => { setScanning(false); setNotice(result?.historySent ? `${name} is linked. All your chats were sent to it end-to-end encrypted.` : `${name} is linked. Your chat history was not sent; new messages will show on both.`); loadDevices(); }} />
        ) : (
          <>
            <button type="button" className="link-device-button" onClick={() => setScanning(true)}>Link a device</button>
            {notice && <p className="account-notice" role="status">{notice}</p>}
            <Devices devices={devices} onSignOut={removeDevice} error={error} />
          </>
        )}
      </SubView>
    );
  } else {
    const otherDevices = devices ? devices.length - 1 : null;
    content = (
      <div className="wa-info-subview">
        <header className="wa-info-header">
          <button type="button" className="icon-button" onClick={onClose} aria-label={section === 'privacy' ? 'Close privacy settings' : 'Close account settings'}><ArrowLeft size={20} /></button>
          <h2>{section === 'privacy' ? 'Privacy' : 'Account'}</h2>
        </header>
        <div className="wa-info-scroll">
          {notice && <p className="account-notice" role="status"><KeyRound size={14} /> {notice}</p>}
          {section === 'privacy' ? (
            <>
              <section className="wa-info-section">
                <h3>Who can see my personal info</h3>
                <PrivacyRows onOpen={setView} onToggle={changeSetting} />
                <p className="account-hint account-hint-padded">If you hide your last seen, people you hide it from won&apos;t see when you were last online. Online can stay visible to everyone or follow your last seen setting.</p>
              </section>
              <section className="wa-info-section">
                <Row title="Status" subtitle="Who sees your status updates, muted updates" onClick={() => onOpenSheet?.('statusprivacy')} />
              </section>
              <section className="wa-info-section">
                <h3>App lock</h3>
                <DeviceSecuritySettings />
              </section>
            </>
          ) : (
            <>
              <section className="wa-info-section">
                <h3>Security</h3>
                <Row title="Change password" subtitle="Signs you out everywhere else" onClick={() => setView('password')} />
                <TwoStepSettings token={sessionToken} />
              </section>
              <section className="wa-info-section">
                <h3>Devices</h3>
                <Row
                  title="Linked devices"
                  subtitle={otherDevices === null ? 'Loading…' : otherDevices === 0 ? 'Only this device' : `${otherDevices} other device${otherDevices === 1 ? '' : 's'}`}
                  onClick={() => setView('devices')}
                />
              </section>
              <section className="wa-info-section">
                <Row title="Request account info" subtitle="Download a report of your account and settings" onClick={requestInfo} />
                <Row title="Delete my account" subtitle="Remove your account and its data" onClick={() => setView('delete')} />
              </section>
            </>
          )}
          {error && view === null && <p className="notif-error account-hint-padded" role="alert">{error}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="wa-info-layer notif-layer">
      <div className="wa-info-backdrop" onClick={onClose} role="presentation" />
      <div className="wa-info-drawer" role="dialog" aria-modal="true" aria-label={section === 'privacy' ? 'Privacy settings' : 'Account settings'}>
        {content}
      </div>
    </div>
  );
}
