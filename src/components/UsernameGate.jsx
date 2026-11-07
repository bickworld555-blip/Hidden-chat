import { useEffect, useState } from 'react';
import { ArrowRight, AtSign, Copy, MessageSquarePlus, ShieldAlert } from 'lucide-react';

export default function UsernameGate({ onAuthenticated, onClose }) {
  const [username, setUsername] = useState('');
  const [mode, setMode] = useState('register');
  const [identity, setIdentity] = useState('');
  const [password, setPassword] = useState('');
  const [dob, setDob] = useState('');
  const [availability, setAvailability] = useState(null);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [createdSession, setCreatedSession] = useState(null);
  const [copied, setCopied] = useState(false);
  const normalized = username.trim().replace(/^@+/, '').toLowerCase();

  useEffect(() => {
    setAvailability(null);
    setError('');
    if (mode !== 'register' || !normalized) return undefined;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setChecking(true);
      try {
        const response = await fetch(`/api/v1/auth/availability?username=${encodeURIComponent(normalized)}`, { signal: controller.signal });
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
      const response = await fetch(mode === 'register' ? '/api/v1/auth/register' : '/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mode === 'register'
          ? { username: normalized, dob, password }
          : { identity: identity.trim(), password }),
      });
      const result = await response.json();
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
    : identity.trim() && password;

  if (createdSession) return (
    <div className="identity-backdrop">
      <section className="identity-card identity-success" role="dialog" aria-modal="true" aria-labelledby="identity-success-title">
        <div className="identity-brand"><span><MessageSquarePlus size={19} /></span><strong>relay</strong><small>YOUR WORK, IN FLOW</small></div>
        <div className="identity-kicker">ACCOUNT READY</div>
        <h1 id="identity-success-title">You’re on Relay.</h1>
        <p className="identity-copy">Your unique ID can also be used to sign in. Keep it somewhere safe.</p>
        <div className="generated-id"><span>YOUR UNIQUE ID</span><code>{createdSession.user.id}</code><button onClick={copyUniqueId} title="Copy unique ID"><Copy size={15} />{copied ? 'Copied' : 'Copy'}</button></div>
        <button className="identity-submit" onClick={() => onAuthenticated(createdSession)}>Continue to Relay<ArrowRight size={16} /></button>
      </section>
    </div>
  );

  return (
    <div className="identity-backdrop">
      <section className="identity-card" role="dialog" aria-modal="true" aria-labelledby="identity-title">
        {onClose && <button className="identity-close" aria-label="Close account window" onClick={onClose}>×</button>}
        <div className="identity-brand"><span><MessageSquarePlus size={19} /></span><strong>relay</strong><small>YOUR WORK, IN FLOW</small></div>
        <div className="identity-kicker">A QUIETER KIND OF CONNECTED</div>
        <h1 id="identity-title">Your people,<br />all in one place.</h1>
        <p className="identity-copy">{mode === 'register' ? 'Create your account with a unique handle.' : 'Sign in with your handle or unique ID.'}</p>
        <form onSubmit={submit}>
          {mode === 'register' ? <>
            <label className="identity-label" htmlFor="relay-username">Your username</label>
            <div className={`handle-input ${error || (availability?.valid && !availability.available) ? 'invalid' : ''}`}>
              <AtSign size={17} />
              <input id="relay-username" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="yourname" autoComplete="username" maxLength={25} />
              <span className="handle-domain">on relay</span>
            </div>
            <div className={`availability ${error || (availability?.valid && !availability.available) ? 'availability-error' : ''}`} aria-live="polite">
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
            <div className="handle-input"><AtSign size={17} /><input id="relay-identity" value={identity} onChange={(event) => setIdentity(event.target.value)} placeholder="@yourname or UUID" autoComplete="username" /></div>
          </>}
          <label className="identity-label password-label" htmlFor="relay-password">Password</label>
          <input className="identity-text-input" id="relay-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={mode === 'register' ? 'At least 10 characters' : 'Your password'} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} maxLength={128} />
          <button className="identity-submit" type="submit" disabled={!canSubmit || submitting}>
            {submitting ? 'One moment…' : mode === 'register' ? 'Create account' : 'Sign in'}<ArrowRight size={16} />
          </button>
          {error && <div className="auth-error" role="alert">{error}</div>}
        </form>
        <div className="identity-switch">
          {mode === 'register' ? <>Already have an account? <button onClick={() => { setMode('login'); setAvailability(null); setError(''); }}>Sign in</button></> : <>New to Relay? <button onClick={() => { setMode('register'); setAvailability(null); setError(''); }}>Create an account</button></>}
        </div>
        <div className="identity-warning"><ShieldAlert size={15} /><span>Demo accounts use a local server. Use a unique password and don’t store sensitive conversations here.</span></div>
      </section>
    </div>
  );
}
