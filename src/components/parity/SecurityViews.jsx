// Security screens: the app lock gate, app lock / screen security settings, two-step verification settings and
// the periodic PIN reminder.
import { useEffect, useRef, useState } from 'react';
import { Fingerprint, KeyRound, Lock, ShieldCheck, X } from 'lucide-react';
import { PASSCODE_PATTERN, applyScreenSecurity, authenticateNative, checkPasscode, clearPasscode, setPasscode, unlock, unlockMethod, useAppLock } from '../../appLock.js';
import { SETTINGS, appSettings, useSetting } from '../../settings.js';
import { nativeShell } from '../../native.js';
import { disableTwoStep, enableTwoStep, verifyTwoStep } from '../../parityApi.js';
import { refreshTwoStep, useAccountData } from '../../accountData.js';
import ShieldMark from '../ShieldMark.jsx';

/** Covers the app while it is locked. */
export function AppLockGate() {
  const { locked, method } = useAppLock();
  const [passcode, setPasscodeValue] = useState('');
  const [error, setError] = useState('');
  const prompted = useRef(false);

  async function nativeUnlock() {
    setError('');
    if (await authenticateNative()) unlock();
    else setError('Not unlocked. Try again.');
  }
  useEffect(() => {
    if (!locked) { prompted.current = false; return; }
    if (method === 'biometric' && !prompted.current) {
      prompted.current = true;
      nativeUnlock();
    }
  }, [locked, method]);
  if (!locked) return null;
  return (
    <div className="hm-lock-screen" role="dialog" aria-modal="true" aria-label="Hidden Messenger is locked">
      <ShieldMark className="hm-lock-mark" />
      <h2>Hidden Messenger is locked</h2>
      {method === 'biometric' ? (
        <button type="button" className="groups-primary" onClick={nativeUnlock}><Fingerprint size={20} /> Unlock</button>
      ) : (
        <form onSubmit={async (event) => {
          event.preventDefault();
          if (await checkPasscode(passcode)) { setPasscodeValue(''); setError(''); unlock(); } else { setError('Wrong passcode.'); setPasscodeValue(''); }
        }}>
          <input type="password" inputMode="numeric" autoComplete="off" autoFocus maxLength={8} value={passcode} aria-label="App passcode"
            onChange={(event) => setPasscodeValue(event.target.value.replace(/\D/g, ''))} placeholder="Passcode" />
          <button type="submit" className="groups-primary" disabled={passcode.length < 4}>Unlock</button>
        </form>
      )}
      {error && <p className="hm-error" role="alert">{error}</p>}
    </div>
  );
}

/** App lock and screen security (device settings). */
export function DeviceSecuritySettings() {
  const lock = useSetting('security.appLock');
  const screenSecurity = useSetting('security.screenSecurity');
  const [method, setMethod] = useState(undefined);
  const [settingPasscode, setSettingPasscode] = useState(null);
  const [pendingLock, setPendingLock] = useState(null);
  const [error, setError] = useState('');
  const inApp = nativeShell();
  useEffect(() => { unlockMethod().then(setMethod).catch(() => setMethod(null)); }, []);

  async function chooseLock(value) {
    setError('');
    if (value === 'off') {
      await appSettings().set('security.appLock', 'off');
      if (!inApp) await clearPasscode();
      setMethod(await unlockMethod());
      return;
    }
    if (inApp) {
      if (method !== 'biometric') {
        setError('Set up a screen lock (PIN, pattern, password or fingerprint) in your phone’s settings first.');
        return;
      }
      // Like WhatsApp: confirm it's you before turning the lock on.
      if (!await authenticateNative('Confirm to turn on app lock')) return;
      await appSettings().set('security.appLock', value);
      return;
    }
    if (method === 'passcode') {
      await appSettings().set('security.appLock', value);
      return;
    }
    setPendingLock(value);
    setSettingPasscode({ first: '', second: '' });
  }

  return (
    <div className="hm-security-settings">
      <h3><Lock size={16} aria-hidden="true" /> App lock</h3>
      <p className="account-hint">{inApp ? 'Unlock with your fingerprint, face or your phone’s screen lock.' : 'Unlock with an app passcode kept on this device.'}</p>
      <div role="radiogroup" aria-label="App lock" className="hm-radio-list">
        {SETTINGS['security.appLock'].options.map((option) => (
          <label key={option.id}>
            <input type="radio" name="app-lock" checked={lock === option.id} onChange={() => chooseLock(option.id).catch((caught) => setError(caught.message))} /> {option.label}
          </label>
        ))}
      </div>
      {settingPasscode && (
        <form className="hm-form" onSubmit={async (event) => {
          event.preventDefault();
          if (!PASSCODE_PATTERN.test(settingPasscode.first)) { setError('Use 4 to 8 digits.'); return; }
          if (settingPasscode.first !== settingPasscode.second) { setError('The passcodes don’t match.'); return; }
          await setPasscode(settingPasscode.first);
          await appSettings().set('security.appLock', pendingLock);
          setMethod('passcode');
          setSettingPasscode(null);
          setError('');
        }}>
          <label>New app passcode<input type="password" inputMode="numeric" maxLength={8} value={settingPasscode.first} onChange={(event) => setSettingPasscode({ ...settingPasscode, first: event.target.value.replace(/\D/g, '') })} autoFocus /></label>
          <label>Confirm passcode<input type="password" inputMode="numeric" maxLength={8} value={settingPasscode.second} onChange={(event) => setSettingPasscode({ ...settingPasscode, second: event.target.value.replace(/\D/g, '') })} /></label>
          <div className="hm-row-actions"><button type="button" onClick={() => setSettingPasscode(null)}>Cancel</button><button type="submit" className="groups-primary">Turn on</button></div>
        </form>
      )}
      {inApp && (
        <label className="hm-switch-row">
          <span><strong>Screen security</strong><small>{SETTINGS['security.screenSecurity'].hint}</small></span>
          <input type="checkbox" className="groups-switch-input" checked={screenSecurity} aria-label="Screen security"
            onChange={(event) => appSettings().set('security.screenSecurity', event.target.checked).then(applyScreenSecurity)} />
        </label>
      )}
      {error && <p className="hm-error" role="alert">{error}</p>}
    </div>
  );
}

const PIN_INPUT = { type: 'password', inputMode: 'numeric', autoComplete: 'off', maxLength: 6, pattern: '\\d{6}' };

/** Two-step verification: a 6-digit PIN asked when signing in (set and turned off with the account password). */
export function TwoStepSettings({ token }) {
  const twoStep = useAccountData((state) => state.twoStep);
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const digits = (value) => value.replace(/\D/g, '').slice(0, 6);
  async function submit(event) {
    event.preventDefault();
    setError('');
    try {
      if (form.mode === 'off') {
        await disableTwoStep(token, form.password);
        setNotice('Two-step verification is off.');
      } else {
        if (!/^\d{6}$/.test(form.pin)) throw new Error('The PIN is 6 digits.');
        if (form.pin !== form.confirm) throw new Error('The PINs don’t match.');
        await enableTwoStep(token, form.pin, form.password);
        localStorage.setItem('hm:two-step-verified-at', String(Date.now()));
        setNotice(form.mode === 'change' ? 'PIN changed.' : 'Two-step verification is on.');
      }
      setForm(null);
      await refreshTwoStep();
    } catch (caught) {
      setError(caught.message);
    }
  }
  return (
    <div className="hm-security-settings">
      <h3><KeyRound size={16} aria-hidden="true" /> Two-step verification</h3>
      <p className="account-hint">For extra security, a 6-digit PIN is asked when your account signs in on a new device.</p>
      {!form && (twoStep?.enabled ? (
        <div className="hm-row-actions">
          <button type="button" onClick={() => setForm({ mode: 'change', pin: '', confirm: '', password: '' })}>Change PIN</button>
          <button type="button" className="groups-danger" onClick={() => setForm({ mode: 'off', password: '' })}>Turn off</button>
        </div>
      ) : <button type="button" className="groups-primary" disabled={!twoStep} onClick={() => setForm({ mode: 'on', pin: '', confirm: '', password: '' })}>Turn on</button>)}
      {form && (
        <form className="hm-form" onSubmit={submit}>
          {form.mode !== 'off' && <>
            <label>{form.mode === 'change' ? 'New 6-digit PIN' : 'Create a 6-digit PIN'}<input {...PIN_INPUT} value={form.pin} onChange={(event) => setForm({ ...form, pin: digits(event.target.value) })} autoFocus /></label>
            <label>Confirm PIN<input {...PIN_INPUT} value={form.confirm} onChange={(event) => setForm({ ...form, confirm: digits(event.target.value) })} /></label>
          </>}
          <label>Your account password<input type="password" autoComplete="current-password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} required autoFocus={form.mode === 'off'} /></label>
          <div className="hm-row-actions">
            <button type="button" onClick={() => setForm(null)}>Cancel</button>
            <button type="submit" className={form.mode === 'off' ? 'groups-danger' : 'groups-primary'}>{form.mode === 'off' ? 'Turn off' : 'Save'}</button>
          </div>
        </form>
      )}
      {error && <p className="hm-error" role="alert">{error}</p>}
      {notice && <p className="hm-notice" role="status">{notice}</p>}
    </div>
  );
}

const REMINDER_KEY = 'hm:two-step-verified-at';
const REMINDER_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/** Every 7 days, asks for the two-step PIN so it isn't forgotten (like WhatsApp). "Not now" postpones a day. */
export function TwoStepReminder({ token }) {
  const twoStep = useAccountData((state) => state.twoStep);
  const [due, setDue] = useState(false);
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!twoStep?.enabled) { setDue(false); return; }
    const last = Number(localStorage.getItem(REMINDER_KEY) || 0) || twoStep.setAt || 0;
    if (!localStorage.getItem(REMINDER_KEY)) localStorage.setItem(REMINDER_KEY, String(last || Date.now()));
    setDue(Date.now() - (last || Date.now()) >= REMINDER_INTERVAL_MS);
  }, [twoStep]);
  if (!due) return null;
  const later = () => { localStorage.setItem(REMINDER_KEY, String(Date.now() - REMINDER_INTERVAL_MS + 24 * 60 * 60 * 1000)); setDue(false); };
  return (
    <div className="wa-sheet-backdrop" role="presentation">
      <form className="hm-sheet hm-two-step-reminder" role="dialog" aria-modal="true" aria-label="Enter your two-step verification PIN" onSubmit={async (event) => {
        event.preventDefault();
        try {
          await verifyTwoStep(token, pin);
          localStorage.setItem(REMINDER_KEY, String(Date.now()));
          setDue(false);
        } catch (caught) {
          setError(caught.message);
          setPin('');
        }
      }}>
        <button type="button" className="icon-button hm-sheet-x" onClick={later} aria-label="Not now"><X size={18} /></button>
        <ShieldCheck size={36} aria-hidden="true" />
        <h3>Enter your PIN</h3>
        <p className="hm-muted">Confirm your two-step verification PIN to help you remember it.</p>
        <input {...PIN_INPUT} value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 6))} aria-label="Two-step PIN" autoFocus />
        {error && <p className="hm-error" role="alert">{error}</p>}
        <button type="submit" className="groups-primary" disabled={pin.length !== 6}>Confirm</button>
        <button type="button" onClick={later}>Not now</button>
      </form>
    </div>
  );
}
