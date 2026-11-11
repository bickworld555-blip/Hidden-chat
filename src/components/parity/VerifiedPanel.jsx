// Settings › Verified: what the verified-business badge means, and asking for it. An admin reviews requests in
// the admin console (server/verification.mjs). Free: no subscription or payment.
import { useEffect, useState } from 'react';
import { apiFetch } from '../../api.js';
import { useChatStore } from '../../store.js';
import VerifiedBadge from '../VerifiedBadge.jsx';
import Panel, { Notice } from './Panel.jsx';

async function call(token, path, options = {}) {
  const response = await apiFetch(path, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Something went wrong. Try again.');
  return body;
}

export default function VerifiedPanel({ token, onClose, onOpenBusinessProfile }) {
  const [state, setState] = useState(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { call(token, '/api/v1/me/verification').then(setState).catch((caught) => setError(caught.message)); }, [token]);
  // Keep our own profile's badge in step with the server.
  useEffect(() => {
    if (!state) return;
    useChatStore.setState((current) => (current.user ? { user: { ...current.user, verified: state.status === 'verified' || undefined } } : {}));
  }, [state?.status]);

  async function run(task) {
    setBusy(true); setError('');
    try { setState(await task()); } catch (caught) { setError(caught.message); } finally { setBusy(false); }
  }
  const day = (ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

  return (
    <Panel title="Verified" onClose={onClose}>
      <Notice error={error} />
      <section className="verified-hero">
        <VerifiedBadge size={64} />
        <h3>Verified business</h3>
        <p>The badge next to your name tells customers they’re talking to the real business. It shows in chats, the chat list and your profile.</p>
      </section>
      {!state ? <p className="hm-muted">Loading…</p> : state.status === 'verified' ? (
        <div className="verified-status is-on"><VerifiedBadge size={20} /><span><strong>Your business is verified</strong><small>Since {day(state.verifiedAt)}</small></span></div>
      ) : state.status === 'pending' ? (
        <>
          <div className="verified-status"><span><strong>Waiting for review</strong><small>Requested {day(state.requestedAt)}. We’ll add the badge once it’s approved.</small></span></div>
          <button type="button" className="hm-primary is-quiet" disabled={busy} onClick={() => run(() => call(token, '/api/v1/me/verification', { method: 'DELETE' }))}>Cancel request</button>
        </>
      ) : (
        <>
          {state.status === 'declined' && <div className="verified-status is-declined"><span><strong>Not approved this time</strong><small>Check your business profile is complete, then ask again.</small></span></div>}
          <ul className="verified-points">
            <li>Your business profile needs a category (Tools › Business profile).</li>
            <li>A Hidden Messenger admin checks the request, usually within a few days.</li>
            <li>The badge is free. There’s no subscription.</li>
          </ul>
          <label className="hm-field">About your business (optional)<textarea className="hm-input" maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} placeholder="For example your shop’s address or website" /></label>
          <button type="button" className="hm-primary" disabled={busy} onClick={() => run(() => call(token, '/api/v1/me/verification', { method: 'POST', body: JSON.stringify({ note }) }))}>Request verification</button>
          {error && /category/i.test(error) && onOpenBusinessProfile && <button type="button" className="hm-primary is-quiet" onClick={onOpenBusinessProfile}>Open business profile</button>}
        </>
      )}
    </Panel>
  );
}
