// Admin console (server/admin.mjs): overview, users, reports and the Help Center editor. Only admin accounts
// can open it; the server checks every request. Chat content is end-to-end encrypted and never shown here.
import { useEffect, useState } from 'react';
import { BarChart3, FileText, Flag, RefreshCw, Users } from 'lucide-react';
import Panel, { Notice } from '../parity/Panel.jsx';
import { request } from '../../parityApi.js';

const TABS = [
  { id: 'overview', label: 'Overview', icon: BarChart3 },
  { id: 'users', label: 'Users', icon: Users },
  { id: 'reports', label: 'Reports', icon: Flag },
  { id: 'help', label: 'Help Center', icon: FileText },
];
const CATEGORIES = { 'getting-started': 'Getting started', chats: 'Chats', calls: 'Calls', 'groups-communities': 'Groups & communities', 'privacy-security': 'Privacy & security', account: 'Account', business: 'Business' };
const bytes = (value) => (value === null || value === undefined ? '—' : value < 1024 ** 2 ? `${Math.round(value / 1024)} KB` : value < 1024 ** 3 ? `${(value / 1024 ** 2).toFixed(1)} MB` : `${(value / 1024 ** 3).toFixed(2)} GB`);
const when = (value) => (value ? new Date(value).toLocaleString() : '—');


function Bars({ series, label }) {
  const max = Math.max(1, ...series.map((point) => point.value));
  return (
    <figure className="admin-bars" aria-label={label}>
      <figcaption>{label} · last 14 days</figcaption>
      <div className="admin-bars-row">
        {series.map((point) => (
          <span key={point.day} className="admin-bar" title={`${point.day}: ${point.value}`}>
            <i style={{ height: `${Math.max(2, (point.value / max) * 100)}%` }} />
          </span>
        ))}
      </div>
      <div className="admin-bars-axis"><span>{series[0]?.day.slice(5)}</span><span>{series.at(-1)?.day.slice(5)}</span></div>
    </figure>
  );
}

function Overview({ token }) {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState('');
  const load = () => request(token, '/api/v1/admin/stats').then(setStats).catch((caught) => setError(caught.message));
  useEffect(() => { load(); }, [token]);
  if (!stats) return <Notice error={error} />;
  const tiles = [
    ['Accounts', stats.users], ['Active today', stats.activeToday], ['Active this week', stats.activeWeek], ['Open reports', stats.openReports],
    ['Groups', stats.groups], ['Channels', stats.channels], ['Encrypted devices', stats.encryptedDevices], ['Suspended', stats.suspended],
  ];
  return (
    <div className="admin-overview">
      <div className="admin-tiles">
        {tiles.map(([label, value]) => <div key={label} className="admin-tile"><span>{label}</span><strong>{Number(value).toLocaleString()}</strong></div>)}
      </div>
      <div className="admin-status">
        <span className={`admin-pill ${stats.push ? 'is-ok' : 'is-warn'}`}>Push notifications {stats.push ? 'on' : 'off'}</span>
        <span className="admin-pill">Media stored {bytes(stats.mediaBytes)}</span>
        <button type="button" className="icon-button" onClick={load} aria-label="Refresh"><RefreshCw size={16} /></button>
      </div>
      <Bars series={stats.signups} label="New accounts" />
      <Bars series={stats.messages} label="Direct messages sent" />
    </div>
  );
}

function UsersTab({ token }) {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = () => request(token, `/api/v1/admin/users?q=${encodeURIComponent(query)}`).then(setRows).catch((caught) => setError(caught.message));
  useEffect(() => { const timer = setTimeout(load, 250); return () => clearTimeout(timer); }, [token, query]);
  const act = (user, action, done) => request(token, `/api/v1/admin/users/${user.id}/${action}`, { method: 'POST' })
    .then(() => { setNotice(done); return load(); }).catch((caught) => setError(caught.message));
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
                <td><strong>{user.name}</strong><small>@{user.username}{user.isAdmin ? ' · admin' : ''}</small></td>
                <td>{when(user.createdAt)}</td>
                <td>{when(user.lastSeenAt)}</td>
                <td>{user.openReports || ''}</td>
                <td>{user.suspendedAt ? <span className="admin-pill is-warn">Suspended</span> : <span className="admin-pill is-ok">Active</span>}</td>
                <td className="admin-actions">
                  {user.suspendedAt
                    ? <button type="button" onClick={() => act(user, 'restore', `@${user.username} restored`)}>Restore</button>
                    : <button type="button" className="is-danger" onClick={() => act(user, 'suspend', `@${user.username} suspended and signed out`)}>Suspend</button>}
                  <button type="button" onClick={() => act(user, user.isAdmin ? 'unadmin' : 'admin', user.isAdmin ? `@${user.username} is no longer an admin` : `@${user.username} is now an admin`)}>{user.isAdmin ? 'Remove admin' : 'Make admin'}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ReportsTab({ token }) {
  const [status, setStatus] = useState('open');
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  const load = () => request(token, `/api/v1/admin/reports?status=${status}`).then(setRows).catch((caught) => setError(caught.message));
  useEffect(() => { load(); }, [token, status]);
  const close = (report, value) => request(token, `/api/v1/admin/reports/${report.kind}/${report.id}`, { method: 'POST', body: { status: value } }).then(load).catch((caught) => setError(caught.message));
  const suspend = (report) => request(token, `/api/v1/admin/users/${report.targetId}/suspend`, { method: 'POST' }).then(() => close(report, 'resolved')).catch((caught) => setError(caught.message));
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

function HelpTab({ token }) {
  const [articles, setArticles] = useState([]);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = () => request(token, '/api/v1/admin/help').then(setArticles).catch((caught) => setError(caught.message));
  useEffect(() => { load(); }, [token]);
  async function save() {
    setError('');
    try {
      const body = { slug: editing.slug, category: editing.category, title: editing.title, body: editing.body, published: editing.published };
      if (editing.id) await request(token, `/api/v1/admin/help/${editing.id}`, { method: 'PUT', body });
      else await request(token, '/api/v1/admin/help', { method: 'POST', body });
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
          {editing.id && <button type="button" className="is-danger" onClick={() => request(token, `/api/v1/admin/help/${editing.id}`, { method: 'DELETE' }).then(() => { setEditing(null); return load(); }).catch((caught) => setError(caught.message))}>Delete</button>}
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

export default function AdminConsole({ token, onClose }) {
  const [tab, setTab] = useState('overview');
  return (
    <Panel title="Admin console" subtitle="Hidden Messenger" onClose={onClose}>
      <nav className="admin-tabs" role="tablist">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'is-on' : ''} onClick={() => setTab(id)}><Icon size={16} /> {label}</button>
        ))}
      </nav>
      {tab === 'overview' && <Overview token={token} />}
      {tab === 'users' && <UsersTab token={token} />}
      {tab === 'reports' && <ReportsTab token={token} />}
      {tab === 'help' && <HelpTab token={token} />}
    </Panel>
  );
}
