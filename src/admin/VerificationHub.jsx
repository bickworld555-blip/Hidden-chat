// Verification hub: business and channel requests, each with its own request ID. Review the public details
// (business profile or channel), then approve or reject with a reason. Verified accounts and channels can have
// the badge removed. Nothing private (chats, media) is part of a request.
import { useEffect, useState } from 'react';
import { BadgeCheck, Check, Copy, Megaphone, Search, Store, X } from 'lucide-react';
import { adminRequest } from './adminApi.js';

const STATUSES = [['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected']];
const ago = (ms) => {
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

function RequestCard({ item, onDecided }) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const subject = item.subject;
  async function decide(decision) {
    setBusy(true); setError('');
    try {
      await adminRequest(`/api/admin/v1/verification/${item.requestId}/decision`, { method: 'POST', body: { decision, note: decision === 'reject' ? reason : '' } });
      onDecided(item.requestId, decision);
    } catch (caught) { setError(caught.message); } finally { setBusy(false); }
  }
  const copy = () => navigator.clipboard?.writeText(item.requestId).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {});
  return (
    <article className={`ad-request is-${item.status}`}>
      <header>
        <button type="button" className="ad-request-id" onClick={copy} title="Copy request ID">{item.requestId}{copied ? <Check size={13} /> : <Copy size={13} />}</button>
        <span className="ad-request-kind">{item.kind === 'channel' ? <Megaphone size={13} /> : <Store size={13} />}{item.kind === 'channel' ? 'Channel' : 'Business'}</span>
        <time dateTime={new Date(item.requestedAt).toISOString()}>{ago(item.requestedAt)}</time>
      </header>
      {subject ? (
        <div className="ad-request-subject">
          <span className="ad-avatar" aria-hidden="true">{(subject.name || subject.username || '?').replace('@', '').slice(0, 1).toUpperCase()}</span>
          <div>
            {item.kind === 'business' ? (
              <>
                <strong>{subject.name}</strong>
                <small>{subject.name === `@${subject.username}` ? '' : `@${subject.username}`}{subject.category ? `${subject.name === `@${subject.username}` ? '' : ' · '}${subject.category}` : ''}{subject.website ? ` · ${subject.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}` : ''}</small>
                {subject.description && <p>{subject.description}</p>}
              </>
            ) : (
              <>
                <strong>{subject.name}</strong>
                <small>Owner @{subject.owner ?? 'unknown'} · {subject.category} · {subject.followers.toLocaleString()} follower{subject.followers === 1 ? '' : 's'}</small>
                {subject.description && <p>{subject.description}</p>}
              </>
            )}
          </div>
        </div>
      ) : <p className="ad-muted">The {item.kind === 'channel' ? 'channel' : 'account'} no longer exists.</p>}
      {item.note && <blockquote>“{item.note}”<cite>— @{item.requester ?? 'unknown'}</cite></blockquote>}
      {error && <p className="ad-error" role="alert">{error}</p>}
      {item.status === 'pending' ? (
        rejecting ? (
          <div className="ad-request-reject">
            <input className="ad-input" value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} placeholder="Reason shown to the requester (optional)" aria-label="Reason for rejecting" autoFocus />
            <button type="button" className="ad-btn" onClick={() => setRejecting(false)} disabled={busy}>Cancel</button>
            <button type="button" className="ad-btn is-danger" onClick={() => decide('reject')} disabled={busy}><X size={14} /> Reject</button>
          </div>
        ) : (
          <div className="ad-request-actions">
            <button type="button" className="ad-btn" onClick={() => setRejecting(true)} disabled={busy || !subject}><X size={14} /> Reject</button>
            <button type="button" className="ad-btn is-gold" onClick={() => decide('approve')} disabled={busy || !subject}><BadgeCheck size={14} /> Approve</button>
          </div>
        )
      ) : (
        <footer className="ad-request-decision">
          <span className={`ad-status ${item.status === 'approved' ? 'is-good' : 'is-critical'}`}>{item.status === 'approved' ? '● Approved' : '✕ Rejected'}</span>
          <small>{item.decidedAt ? ago(item.decidedAt) : ''}{item.decidedBy ? ` · ${item.decidedBy.replace(/^admin:/, '')}` : ''}</small>
          {item.decisionNote && <small className="ad-request-reason">Reason: {item.decisionNote}</small>}
        </footer>
      )}
    </article>
  );
}

function VerifiedList({ kind, revision }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const load = () => adminRequest(`/api/admin/v1/verified?kind=${kind}`).then(setRows).catch((caught) => setError(caught.message));
  useEffect(() => { setRows(null); load(); }, [kind, revision]);
  async function remove(row) {
    const label = kind === 'business' ? `@${row.user.username}` : row.channel.name;
    if (!window.confirm(`Remove the verified badge from ${label}?`)) return;
    try {
      await adminRequest(kind === 'business' ? `/api/admin/v1/users/${row.user.id}/verified` : `/api/admin/v1/channels/${row.channel.id}/verified`, { method: 'PUT', body: { verified: false } });
      await load();
    } catch (caught) { setError(caught.message); }
  }
  return (
    <section className="ad-card ad-verified" aria-label={kind === 'business' ? 'Verified businesses' : 'Verified channels'}>
      <header className="ad-card-head"><h2><BadgeCheck size={16} aria-hidden="true" /> {kind === 'business' ? 'Verified businesses' : 'Verified channels'}{rows ? ` · ${rows.length}` : ''}</h2></header>
      {error && <p className="ad-error" role="alert">{error}</p>}
      {rows?.length === 0 && <p className="ad-muted">None yet.</p>}
      <ul>
        {(rows ?? []).filter((row) => (kind === 'business' ? row.user : row.channel)).map((row) => (
          <li key={kind === 'business' ? row.user.id : row.channel.id}>
            <span>{kind === 'business' ? <><strong>{row.user.name}</strong> <small>@{row.user.username}</small></> : <strong>{row.channel.name}</strong>}</span>
            <small>since {new Date(row.verifiedAt).toLocaleDateString()}</small>
            <button type="button" className="ad-btn is-small" onClick={() => remove(row)}>Remove</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function VerificationHub({ onChanged }) {
  const [kind, setKind] = useState('business');
  const [status, setStatus] = useState('pending');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState(null);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    adminRequest('/api/admin/v1/verification/summary').then(setSummary).catch(() => {});
  }, [revision]);
  useEffect(() => {
    setItems(null);
    const timer = setTimeout(() => {
      adminRequest(`/api/admin/v1/verification?kind=${kind}&status=${status}&q=${encodeURIComponent(query.trim())}`)
        .then(setItems).catch((caught) => setError(caught.message));
    }, query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [kind, status, query, revision]);
  const decided = () => { setRevision((value) => value + 1); onChanged?.(); };

  return (
    <div className="ad-verification">
      <div className="ad-toolbar">
        <div className="ad-seg is-large" role="tablist" aria-label="Request type">
          {[['business', 'Business profiles', Store], ['channel', 'Channels', Megaphone]].map(([id, label, Icon]) => (
            <button key={id} type="button" role="tab" aria-selected={kind === id} className={kind === id ? 'is-on' : ''} onClick={() => setKind(id)}>
              <Icon size={15} aria-hidden="true" /> {label}{summary?.[id]?.pending ? <span className="ad-count is-gold">{summary[id].pending}</span> : null}
            </button>
          ))}
        </div>
        <div className="ad-seg" role="tablist" aria-label="Status">
          {STATUSES.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={status === id} className={status === id ? 'is-on' : ''} onClick={() => setStatus(id)}>
              {label}{summary?.[kind]?.[id] ? <span className="ad-count">{summary[kind][id]}</span> : null}
            </button>
          ))}
        </div>
        <label className="ad-search"><Search size={15} aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Request ID, e.g. VR-7KQ2MX" aria-label="Search by request ID" /></label>
      </div>
      {error && <p className="ad-error" role="alert">{error}</p>}
      <div className="ad-requests">
        {items === null ? <p className="ad-muted">Loading…</p> : items.length === 0 ? (
          <div className="ad-empty"><BadgeCheck size={28} aria-hidden="true" /><p>{status === 'pending' ? `No ${kind === 'channel' ? 'channel' : 'business'} requests waiting.` : `No ${status} ${kind === 'channel' ? 'channel' : 'business'} requests.`}</p></div>
        ) : items.map((item) => <RequestCard key={item.requestId} item={item} onDecided={decided} />)}
      </div>
      <VerifiedList kind={kind} revision={revision} />
    </div>
  );
}
