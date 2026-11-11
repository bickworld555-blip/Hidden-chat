// The standalone admin page: sign in with the server's admin credentials (ADMIN_USERNAME / ADMIN_PASSWORD),
// then the console. Separate from chat accounts and chat sessions.
import { useEffect, useState } from 'react';
import { Lock, ShieldCheck } from 'lucide-react';
import Dashboard from './Dashboard.jsx';
import { SIGNED_OUT_EVENT, adminSession, adminSignIn, adminSignOut } from './adminApi.js';

function SignIn({ configured, onSignedIn }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const session = await adminSignIn(username, password);
      setPassword('');
      onSignedIn(session.username);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="admin-gate">
      <form className="admin-gate-card" onSubmit={submit} aria-labelledby="admin-gate-title">
        <span className="admin-gate-mark" aria-hidden="true"><ShieldCheck size={30} /></span>
        <h1 id="admin-gate-title">Hidden Messenger admin</h1>
        <p className="admin-gate-sub">Sign in with the admin account set on the server. Chat accounts can’t sign in here.</p>
        {!configured && <p className="admin-gate-error" role="alert">Admin sign-in isn’t set up yet. Add ADMIN_USERNAME and ADMIN_PASSWORD (at least 12 characters) to the server’s environment, then redeploy.</p>}
        {error && <p className="admin-gate-error" role="alert">{error}</p>}
        <label>Username<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} required disabled={!configured} /></label>
        <label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required disabled={!configured} /></label>
        <button type="submit" disabled={busy || !configured || !username || !password}><Lock size={16} /> {busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </main>
  );
}

// Dark only: the console is a high-density navy workspace.
export default function AdminApp() {
  const [state, setState] = useState({ loading: true, configured: true, username: null });
  useEffect(() => {
    adminSession()
      .then((session) => setState({ loading: false, configured: session.configured, username: session.signedIn ? session.username : null }))
      .catch(() => setState({ loading: false, configured: true, username: null }));
    const signedOut = () => setState((current) => ({ ...current, username: null }));
    window.addEventListener(SIGNED_OUT_EVENT, signedOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, signedOut);
  }, []);
  useEffect(() => { document.documentElement.classList.add('admin-dark'); }, []);

  const signOut = async () => {
    await adminSignOut().catch(() => {});
    setState((current) => ({ ...current, username: null }));
  };

  return (
    <div className="admin-page dark-theme">
      {state.loading ? <main className="admin-gate"><p className="ad-muted">Loading…</p></main>
        : !state.username ? <SignIn configured={state.configured} onSignedIn={(username) => setState((current) => ({ ...current, username }))} />
          : <Dashboard username={state.username} onSignOut={signOut} />}
    </div>
  );
}
