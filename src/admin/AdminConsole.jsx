// Admin console sections reused by the dashboard (Dashboard.jsx): users, reports, the Help Center editor and the
// stored-media check. Requests use the admin session (adminApi.js); chat content is never shown here.
import { useEffect, useState } from 'react';
import { Notice } from '../components/parity/Panel.jsx';
import { adminRequest } from './adminApi.js';

const CATEGORIES = { 'getting-started': 'Getting started', chats: 'Chats', calls: 'Calls', 'groups-communities': 'Groups & communities', 'privacy-security': 'Privacy & security', account: 'Account', business: 'Business' };
const when = (value) => (value ? new Date(value).toLocaleString() : '—');


// Attachments whose file is missing on the server: how many, from when, and a clean-up of their records.
export function MediaIntegrity() {
  const [scan, setScan] = useState(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const load = () => adminRequest('/api/admin/v1/media-integrity').then(setScan).catch((caught) => setError(caught.message));
  useEffect(() => { load(); }, []);
  const day = (ms) => (ms ? new Date(ms).toLocaleDateString() : '—');
  async function clean() {
    setConfirming(false);
    try {
      const { removed } = await adminRequest('/api/admin/v1/media-integrity/clean', { method: 'POST' });
      setNotice(`Removed ${removed} record${removed === 1 ? '' : 's'} of missing files.`);
      await load();
    } catch (caught) { setError(caught.message); }
  }
  return (
    <section className="admin-media-integrity" aria-label="Stored media">
      <h3 className="hm-section">Stored media</h3>
      <Notice error={error} notice={notice} />
      {!scan ? <p className="hm-muted">Checking files…</p> : scan.missing === 0 ? (
        <p><span className="admin-pill is-ok">All {scan.checked.toLocaleString()} files present</span></p>
      ) : (
        <>
          <p><span className="admin-pill is-warn">{scan.missing} of {scan.checked.toLocaleString()} files missing</span></p>
          <p className="hm-muted">Missing files were uploaded between {day(scan.oldestMissingAt)} and {day(scan.newestMissingAt)}. The newest file that is present is from {day(scan.newestPresentAt)}.
            {scan.newestMissingAt && scan.newestPresentAt && scan.newestMissingAt < scan.newestPresentAt ? ' Newer uploads are intact, so this looks like an old loss rather than an ongoing one.' : ' Recent uploads are affected: check that the data directory is persistent.'}</p>
          {confirming ? (
            <div className="hm-row-actions">
              <button type="button" onClick={() => setConfirming(false)}>Cancel</button>
              <button type="button" className="is-danger" onClick={clean}>Remove {scan.missing} records</button>
            </div>
          ) : <button type="button" onClick={() => setConfirming(true)}>Remove records of missing files</button>}
        </>
      )}
    </section>
  );
}

export function UsersTab() {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = () => adminRequest(`/api/admin/v1/users?q=${encodeURIComponent(query)}`).then(setRows).catch((caught) => setError(caught.message));
  useEffect(() => { const timer = setTimeout(load, 250); return () => clearTimeout(timer); }, [query]);
  const act = (user, action, done) => adminRequest(`/api/admin/v1/users/${user.id}/${action}`, { method: 'POST' })
    .then(() => { setError(''); setNotice(done); return load(); }).catch((caught) => setError(caught.message));
  return (
    <div>
      <Notice error={error} notice={notice} />
      <input className="hm-input" placeholder="Search by username or name" value={query} onChange={(event) => setQuery(event.target.value)} />
      <div className="admin-table">
        <table>
          <thead><tr><th>Account</th><th>Joined</th><th>Last seen</th><th>Reports</th><th>Status</th><th /></tr></thead>
          <tbody>
            {rows.map((user) => (
              <tr key={user.id}>
                <td><strong>{user.name}</strong><small>@{user.username}</small></td>
                <td>{when(user.createdAt)}</td>
                <td>{when(user.lastSeenAt)}</td>
                <td>{user.openReports || ''}</td>
                <td>{user.suspendedAt ? <span className="admin-pill is-warn">Suspended</span> : <span className="admin-pill is-ok">Active</span>}</td>
                <td className="admin-actions">
                  {user.suspendedAt
                    ? <button type="button" onClick={() => act(user, 'restore', `@${user.username} restored`)}>Restore</button>
                    : <button type="button" className="is-danger" onClick={() => act(user, 'suspend', `@${user.username} suspended and signed out`)}>Suspend</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ReportsTab() {
  const [status, setStatus] = useState('open');
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  const load = () => adminRequest(`/api/admin/v1/reports?status=${status}`).then(setRows).catch((caught) => setError(caught.message));
  useEffect(() => { load(); }, [status]);
  const close = (report, value) => adminRequest(`/api/admin/v1/reports/${report.kind}/${report.id}`, { method: 'POST', body: { status: value } }).then(load).catch((caught) => setError(caught.message));
  const suspend = (report) => adminRequest(`/api/admin/v1/users/${report.targetId}/suspend`, { method: 'POST' }).then(() => close(report, 'resolved')).catch((caught) => setError(caught.message));
  return (
    <div>
      <Notice error={error} />
      <div className="admin-segment" role="tablist">
        {['open', 'closed'].map((value) => <button key={value} type="button" role="tab" aria-selected={status === value} className={status === value ? 'is-on' : ''} onClick={() => setStatus(value)}>{value === 'open' ? 'Open' : 'Closed'}</button>)}
      </div>
      {rows.map((report) => (
        <article key={`${report.kind}-${report.id}`} className="admin-report">
          <header><strong>{report.kind === 'group' ? `Group “${report.targetName}”` : `@${report.targetName}`}</strong><span className="admin-pill">{report.reason}</span></header>
          <p>Reported by @{report.reporterName} · {when(report.createdAt)}{report.details ? ` · “${report.details}”` : ''}</p>
          {status === 'open' && (
            <span className="admin-actions">
              {report.kind === 'user' && !report.targetSuspended && <button type="button" className="is-danger" onClick={() => suspend(report)}>Suspend account</button>}
              <button type="button" onClick={() => close(report, 'resolved')}>Mark resolved</button>
              <button type="button" onClick={() => close(report, 'dismissed')}>Dismiss</button>
            </span>
          )}
          {status === 'closed' && <small>{report.status}</small>}
        </article>
      ))}
      {!rows.length && <p className="hm-muted">{status === 'open' ? 'No open reports.' : 'No closed reports yet.'}</p>}
    </div>
  );
}

const EMPTY_ARTICLE = { slug: '', category: 'getting-started', title: '', body: '', published: true };

export function HelpTab() {
  const [articles, setArticles] = useState([]);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = () => adminRequest('/api/admin/v1/help').then(setArticles).catch((caught) => setError(caught.message));
  useEffect(() => { load(); }, []);
  async function save() {
    setError('');
    try {
      const body = { slug: editing.slug, category: editing.category, title: editing.title, body: editing.body, published: editing.published };
      if (editing.id) await adminRequest(`/api/admin/v1/help/${editing.id}`, { method: 'PUT', body });
      else await adminRequest('/api/admin/v1/help', { method: 'POST', body });
      setNotice(editing.published ? 'Published.' : 'Saved as hidden.');
      setEditing(null);
      await load();
    } catch (caught) { setError(caught.message); }
  }
  if (editing) {
    return (
      <div className="admin-editor">
        <Notice error={error} />
        <label className="hm-field">Title<input className="hm-input" value={editing.title} maxLength={140} onChange={(event) => setEditing({ ...editing, title: event.target.value, slug: editing.id ? editing.slug : event.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) })} /></label>
        <label className="hm-field">Web address<input className="hm-input" value={editing.slug} onChange={(event) => setEditing({ ...editing, slug: event.target.value })} /><small>hiddenmessenger.com/help/{editing.slug || '…'}</small></label>
        <label className="hm-field">Category<select className="hm-input" value={editing.category} onChange={(event) => setEditing({ ...editing, category: event.target.value })}>
          {Object.entries(CATEGORIES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <label className="hm-field">Text<textarea className="hm-input admin-body" value={editing.body} onChange={(event) => setEditing({ ...editing, body: event.target.value })} /><small>Blank lines start new paragraphs.</small></label>
        <label className="hm-check-row"><input type="checkbox" checked={editing.published} onChange={(event) => setEditing({ ...editing, published: event.target.checked })} /><span>Published (visible on the Help Center)</span></label>
        <span className="admin-actions">
          <button type="button" className="is-primary" onClick={save} disabled={!editing.title.trim() || !editing.body.trim()}>Save</button>
          <button type="button" onClick={() => setEditing(null)}>Cancel</button>
          {editing.id && <button type="button" className="is-danger" onClick={() => adminRequest(`/api/admin/v1/help/${editing.id}`, { method: 'DELETE' }).then(() => { setEditing(null); return load(); }).catch((caught) => setError(caught.message))}>Delete</button>}
        </span>
      </div>
    );
  }
  return (
    <div>
      <Notice error={error} notice={notice} />
      <button type="button" className="hm-row-button" onClick={() => setEditing({ ...EMPTY_ARTICLE })}>+ New article</button>
      {Object.entries(CATEGORIES).map(([category, label]) => {
        const list = articles.filter((article) => article.category === category);
        if (!list.length) return null;
        return (
          <section key={category}>
            <h3 className="hm-section">{label}</h3>
            {list.map((article) => (
              <button key={article.id} type="button" className="hm-row-main" onClick={() => setEditing(article)}>
                <span><strong>{article.title}</strong><small>/help/{article.slug}{article.published ? '' : ' · hidden'}</small></span>
              </button>
            ))}
          </section>
        );
      })}
    </div>
  );
}
