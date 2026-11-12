import { apiFetch } from '../api.js';
import { useEffect, useState } from 'react';
import { ArrowRight, AtSign, Copy, Eye, EyeOff, Facebook, Instagram, ShieldCheck } from 'lucide-react';
import ShieldMark from './ShieldMark.jsx';
import { LinkWithPhone } from './LinkDevice.jsx';
import { nativeShell } from '../native.js';
import { companionOnly } from '../companion.js';
import './UsernameGate.css';

// The X (formerly Twitter) mark; lucide only ships the old bird.
function XLogo({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M17.75 3h3.07l-6.7 7.66L22 21h-6.17l-4.83-6.32L5.47 21H2.4l7.17-8.2L2 3h6.33l4.37 5.77L17.75 3Zm-1.08 16.17h1.7L7.4 4.74H5.58l11.09 14.43Z" />
    </svg>
  );
}

// Static for now: the profiles get linked in a later update, so these are images, not dead buttons.
const SOCIAL_PROFILES = [
  { id: 'facebook', name: 'Facebook', Icon: Facebook },
  { id: 'x', name: 'X', Icon: XLogo },
  { id: 'instagram', name: 'Instagram', Icon: Instagram },
];

function SocialLinks() {
  return (
    <div className="identity-social" aria-label="Hidden Messenger on social media">
      {SOCIAL_PROFILES.map(({ id, name, Icon }) => (
        <span key={id} className={`identity-social-icon is-${id}`} role="img" aria-label={name} title={name}><Icon size={18} /></span>
      ))}
    </div>
  );
}

function IdentityBrand() {
  return (
    <header className="identity-brand">
      <ShieldMark className="identity-mark" />
      <div className="identity-wordmark">HIDDEN MESSENGER</div>
      <p>No Email. No Number. Only Privacy.</p>
    </header>
  );
}

// On a computer the only way in is linking with the phone (src/companion.js).
function CompanionSignIn({ onAuthenticated, onClose }) {
  return (
    <div className="identity-backdrop">
      <div className="identity-layout">
        <IdentityBrand />
        <section className="identity-card" role="dialog" aria-modal="true" aria-labelledby="identity-title">
          {onClose && <button className="identity-close" aria-label="Close account window" onClick={onClose}>×</button>}
          <h1 className="identity-title" id="identity-title">Use Hidden Messenger on this computer</h1>
          <p className="identity-copy">Your account lives on your phone. Link this computer by scanning the code with the app.</p>
          <LinkWithPhone onAuthenticated={onAuthenticated} />
          <div className="identity-switch">New to Hidden Messenger? <a href="/download">Get the Android app</a> and create your account there.</div>
          <SocialLinks />
        </section>
      </div>
    </div>
  );
}

export default function UsernameGate({ onAuthenticated, onClose }) {
  if (companionOnly()) return <CompanionSignIn onAuthenticated={onAuthenticated} onClose={onClose} />;
  return <PasswordGate onAuthenticated={onAuthenticated} onClose={onClose} />;
}

function PasswordGate({ onAuthenticated, onClose }) {
  // A development browser can also link with the phone.
  const [linkMode, setLinkMode] = useState(() => !nativeShell() && (globalThis.innerWidth ?? 0) >= 900);
  const [username, setUsername] = useState('');
  const [mode, setMode] = useState('register');
  const [identity, setIdentity] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [dob, setDob] = useState('');
  const [availability, setAvailability] = useState(null);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [createdSession, setCreatedSession] = useState(null);
  const [copied, setCopied] = useState(false);
  // Two-step verification: the server asks for the 6-digit PIN after the password matched.
  const [pinRequired, setPinRequired] = useState(false);
  const [pin, setPin] = useState('');
  const normalized = username.trim().replace(/^@+/, '').toLowerCase();

  useEffect(() => {
    setAvailability(null);
    setError('');
    if (mode !== 'register' || !normalized) return undefined;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setChecking(true);
      try {
        const response = await apiFetch(`/api/v1/auth/availability?username=${encodeURIComponent(normalized)}`, { signal: controller.signal });
        if (!response.ok) throw new Error('Could not check handle availability.');
        setAvailability(await response.json());
      } catch (reason) {
        if (reason.name !== 'AbortError') setError(reason.message);
      } finally {
        if (!controller.signal.aborted) setChecking(false);
      }
    }, 280);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [mode, normalized]);

  async function submit(event) {
    event.preventDefault();
    if (mode === 'register' && (!availability?.valid || !availability.available)) return;
    if (mode === 'login' && (!identity.trim() || !password)) return;
    setSubmitting(true);
    setError('');
    try {
      const response = await apiFetch(mode === 'register' ? '/api/v1/auth/register' : '/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mode === 'register'
          ? { username: normalized, dob, password }
          : { identity: identity.trim(), password, ...(pinRequired ? { pin } : {}) }),
      });
      const result = await response.json();
      if (mode === 'login' && response.status === 401 && result.twoStepRequired) {
        setPinRequired(true);
        if (result.wrongPin) setPin('');
        if (!pinRequired || result.wrongPin) throw new Error(result.wrongPin ? result.error : 'Enter your two-step verification PIN.');
      }
      if (!response.ok) throw new Error(result.error ?? 'Could not continue with this handle.');
      if (mode === 'register') setCreatedSession(result);
      else onAuthenticated(result);
    } catch (reason) {
      setError(reason.message);
      if (reason.message.toLowerCase().includes('already taken')) setAvailability({ valid: true, available: false });
    } finally {
      setSubmitting(false);
    }
  }

  async function copyUniqueId() {
    await navigator.clipboard.writeText(createdSession.user.id);
    setCopied(true);
  }

  const canSubmit = mode === 'register'
    ? availability?.valid && availability.available && dob && password.length >= 10
    : identity.trim() && password && (!pinRequired || /^\d{6}$/.test(pin));

  if (createdSession) return (
    <div className="identity-backdrop">
      <div className="identity-layout">
        <IdentityBrand />
        <section className="identity-card identity-success" role="dialog" aria-modal="true" aria-labelledby="identity-success-title">
        <div className="identity-kicker">ACCOUNT READY</div>
        <h1 id="identity-success-title">Your account is ready.</h1>
        <p className="identity-copy">Your unique ID can also be used to sign in. Keep it somewhere safe.</p>
        <div className="generated-id"><span>YOUR UNIQUE ID</span><code>{createdSession.user.id}</code><button onClick={copyUniqueId} title="Copy unique ID"><Copy size={15} />{copied ? 'Copied' : 'Copy'}</button></div>
        <button className="identity-submit" onClick={() => onAuthenticated(createdSession)}>Continue to Hidden Messenger<ArrowRight size={16} /></button>
        </section>
      </div>
    </div>
  );

  return (
    <div className="identity-backdrop">
      <div className="identity-layout">
      <IdentityBrand />
      <section className="identity-card" role="dialog" aria-modal="true" aria-labelledby="identity-title">
        {onClose && <button className="identity-close" aria-label="Close account window" onClick={onClose}>×</button>}
        <h1 className="identity-title" id="identity-title">{mode === 'register' ? 'Create your account' : 'Welcome back'}</h1>
        {mode === 'login' && <p className="identity-copy">Sign in with your username or unique ID.</p>}
        {mode === 'login' && (
          <button type="button" className="identity-link-toggle" onClick={() => setLinkMode(!linkMode)}>
            {linkMode ? 'Sign in with a password instead' : 'Link with your phone (scan a QR code)'}
          </button>
        )}
        {mode === 'login' && linkMode ? <LinkWithPhone onAuthenticated={onAuthenticated} /> : (
        <form onSubmit={submit}>
          {mode === 'register' ? <>
            <label className="identity-label" htmlFor="relay-username">Your username</label>
            <div className={`handle-input ${error || (availability?.valid && !availability.available) ? 'invalid' : ''}`}>
              <AtSign size={17} />
              <input id="relay-username" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="yourname" autoComplete="username" maxLength={25} aria-describedby="username-availability" />
              <ShieldCheck className="handle-shield" size={19} aria-hidden="true" />
              <span className="handle-domain" aria-label="Hidden Messenger">HM</span>
            </div>
            <div id="username-availability" className={`availability ${error || (availability?.valid && !availability.available) ? 'availability-error' : ''}`} aria-live="polite">
              {error || (availability?.valid && !availability.available
                ? `@${normalized} is already taken. Try another handle.`
                : availability?.valid && availability.available
                  ? `@${normalized} is available`
                  : availability && !availability.valid
                    ? availability.reason
                    : checking ? 'Checking availability…' : '3–24 characters · letters, numbers, underscores')}
            </div>
            <label className="identity-label" htmlFor="relay-dob">Date of birth</label>
            <input className="identity-text-input" id="relay-dob" type="date" value={dob} max={new Date().toISOString().slice(0, 10)} onChange={(event) => setDob(event.target.value)} autoComplete="bday" />
          </> : <>
            <label className="identity-label" htmlFor="relay-identity">Username or unique ID</label>
            <div className="handle-input"><AtSign size={17} /><input id="relay-identity" value={identity} onChange={(event) => { setIdentity(event.target.value); setPinRequired(false); setPin(''); }} placeholder="@yourname or UUID" autoComplete="username" /></div>
          </>}
          <label className="identity-label password-label" htmlFor="relay-password">Password</label>
          <div className="identity-password">
            <input className="identity-text-input" id="relay-password" type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={mode === 'register' ? 'At least 10 characters' : 'Your password'} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} maxLength={128} />
            <button type="button" className="password-toggle" aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff size={20} /> : <Eye size={20} />}</button>
          </div>
          {mode === 'login' && pinRequired && <>
            <label className="identity-label" htmlFor="relay-pin">Two-step verification PIN</label>
            <input className="identity-text-input" id="relay-pin" type="password" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={pin} autoFocus
              onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="6-digit PIN" />
          </>}
          <button className="identity-submit" type="submit" disabled={!canSubmit || submitting}>
            {submitting ? 'One moment…' : mode === 'register' ? 'Create account' : 'Sign in'}<ShieldMark className="button-mark" />
          </button>
          {error && <div className="auth-error" role="alert">{error}</div>}
        </form>
        )}
        <div className="identity-switch">
          {mode === 'register' ? <>Already have an account? <button onClick={() => { setMode('login'); setAvailability(null); setError(''); setShowPassword(false); }}>Sign in</button></> : <>New to Hidden Messenger? <button onClick={() => { setMode('register'); setAvailability(null); setError(''); setShowPassword(false); }}>Create an account</button></>}
        </div>
        <SocialLinks />
      </section>
      </div>
    </div>
  );
}
