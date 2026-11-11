// Dashboard overview: headline numbers, where people use the app, the last two weeks, and system health.
// Everything here is a count; no account, message or file is shown.
import { useEffect, useState } from 'react';
import { BadgeCheck, Flag, Globe2, HardDrive, RefreshCw, ShieldCheck, Users } from 'lucide-react';
import { adminRequest } from './adminApi.js';
import { MediaIntegrity } from './AdminConsole.jsx';
import WorldMap, { MAP_STEPS } from './WorldMap.jsx';
import { TrendBars } from './charts.jsx';

const bytes = (value) => (value === null || value === undefined ? '—' : value < 1024 ** 2 ? `${Math.round(value / 1024)} KB` : value < 1024 ** 3 ? `${(value / 1024 ** 2).toFixed(1)} MB` : `${(value / 1024 ** 3).toFixed(2)} GB`);
const n = (value) => Number(value ?? 0).toLocaleString();

function Tile({ label, value, hint, tone = '', onClick, icon: Icon }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} className={`ad-tile ${tone}`} onClick={onClick}>
      <span className="ad-tile-label">{Icon && <Icon size={14} aria-hidden="true" />}{label}</span>
      <strong>{value}</strong>
      {hint && <small>{hint}</small>}
    </Tag>
  );
}

export default function Overview({ onNavigate }) {
  const [stats, setStats] = useState(null);
  const [geo, setGeo] = useState(null);
  const [metric, setMetric] = useState('active');
  const [error, setError] = useState('');
  const load = () => {
    setError('');
    adminRequest('/api/admin/v1/stats').then(setStats).catch((caught) => setError(caught.message));
    adminRequest('/api/admin/v1/geo').then(setGeo).catch((caught) => setError(caught.message));
  };
  useEffect(() => { load(); }, []);

  const ranked = (geo?.countries ?? []).slice().sort((a, b) => b[metric] - a[metric]).filter((row) => row[metric] > 0);
  const top = ranked[0]?.[metric] ?? 0;
  const known = (geo?.countries ?? []).reduce((sum, row) => sum + row[metric], 0);
  const unknown = geo?.unknown?.[metric] ?? 0;

  return (
    <div className="ad-overview">
      {error && <p className="ad-error" role="alert">{error}</p>}
      <section className="ad-tiles" aria-label="Headline numbers">
        <Tile tone="is-hero" icon={Users} label="Active this week" value={stats ? n(stats.activeWeek) : '…'} hint={stats ? `${n(stats.activeToday)} today` : ''} />
        <Tile icon={Users} label="Accounts" value={stats ? n(stats.users) : '…'} hint={stats ? `${n(stats.suspended)} suspended` : ''} onClick={() => onNavigate('users')} />
        <Tile tone="is-gold" icon={BadgeCheck} label="Verified businesses" value={stats ? n(stats.verifiedBusinesses) : '…'} onClick={() => onNavigate('verification')} />
        <Tile tone="is-gold" icon={BadgeCheck} label="Verified channels" value={stats ? n(stats.verifiedChannels) : '…'} hint={stats ? `of ${n(stats.channels)} channels` : ''} onClick={() => onNavigate('verification')} />
        <Tile tone={stats?.pendingVerifications ? 'is-attention' : ''} icon={ShieldCheck} label="Pending verifications" value={stats ? n(stats.pendingVerifications) : '…'} onClick={() => onNavigate('verification')} />
        <Tile tone={stats?.openReports ? 'is-alert' : ''} icon={Flag} label="Open reports" value={stats ? n(stats.openReports) : '…'} onClick={() => onNavigate('reports')} />
      </section>

      <section className="ad-card ad-geo" aria-label="Where people use Hidden Messenger">
        <header className="ad-card-head">
          <h2><Globe2 size={16} aria-hidden="true" /> Where people use Hidden Messenger</h2>
          <div className="ad-seg" role="tablist" aria-label="Measure">
            {[['active', 'Active this week'], ['users', 'All accounts']].map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={metric === id} className={metric === id ? 'is-on' : ''} onClick={() => setMetric(id)}>{label}</button>
            ))}
          </div>
        </header>
        <div className="ad-geo-body">
          <WorldMap data={geo} metric={metric} />
          <div className="ad-geo-list">
            <h3>Top countries</h3>
            {!geo ? <p className="ad-muted">Loading…</p> : ranked.length === 0 ? <p className="ad-muted">No countries yet. Apps report their country (from the device time zone) after sign-in.</p> : (
              <ol>
                {ranked.slice(0, 12).map((row) => (
                  <li key={row.code}>
                    <span className="ad-geo-name">{row.name}</span>
                    <span className="ad-geo-bar"><i style={{ width: `${(row[metric] / top) * 100}%`, background: MAP_STEPS[2] }} /></span>
                    <span className="ad-geo-value">{n(row[metric])}<small>{known ? `${Math.round((row[metric] / (known + unknown)) * 100)}%` : ''}</small></span>
                  </li>
                ))}
              </ol>
            )}
            {unknown > 0 && <p className="ad-muted">Country not reported yet: {n(unknown)}</p>}
            <p className="ad-fineprint">Country comes from each device’s time zone. No IP addresses or locations are stored.</p>
          </div>
        </div>
      </section>

      <section className="ad-grid-2" aria-label="Last 14 days">
        <div className="ad-card">{stats ? <TrendBars title="New accounts" series={stats.signups} /> : <p className="ad-muted">Loading…</p>}</div>
        <div className="ad-card">{stats ? <TrendBars title="Direct messages sent (count only)" series={stats.messages} /> : <p className="ad-muted">Loading…</p>}</div>
      </section>

      <section className="ad-card" aria-label="System health">
        <header className="ad-card-head">
          <h2><HardDrive size={16} aria-hidden="true" /> System health</h2>
          <button type="button" className="ad-icon-btn" onClick={load} aria-label="Refresh"><RefreshCw size={15} /></button>
        </header>
        {stats && (
          <div className="ad-health">
            <span className={`ad-status ${stats.push ? 'is-good' : 'is-warning'}`}>{stats.push ? '●' : '▲'} Push notifications {stats.push ? 'on' : 'off'}</span>
            <span className="ad-chip">Media stored <b>{bytes(stats.mediaBytes)}</b></span>
            <span className="ad-chip">Data folder <b>{bytes(stats.diskBytes)}</b></span>
            <span className="ad-chip">Encrypted devices <b>{n(stats.encryptedDevices)}</b></span>
            <span className="ad-chip">Groups <b>{n(stats.groups)}</b></span>
            <span className="ad-chip">Channels <b>{n(stats.channels)}</b></span>
          </div>
        )}
        <MediaIntegrity />
      </section>
    </div>
  );
}
