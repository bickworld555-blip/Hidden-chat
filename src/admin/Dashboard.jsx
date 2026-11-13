// The admin dashboard shell: sidebar navigation, live status tickers, and the sections. Each section loads its
// own counts from /api/admin/v1; nothing is kept in browser storage, and no message or media content exists here.
import { useEffect, useState } from 'react';
import { BadgeCheck, CreditCard, FileText, Flag, LayoutDashboard, LifeBuoy, Lock, LogOut, Users } from 'lucide-react';
import BrandMark from '../components/BrandMark.jsx';
import { adminRequest } from './adminApi.js';
import Overview from './Overview.jsx';
import VerificationHub from './VerificationHub.jsx';
import Billing from './Billing.jsx';
import Support from './Support.jsx';
import { HelpTab, ReportsTab, UsersTab } from './AdminConsole.jsx';

const SECTIONS = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'verification', label: 'Verification', icon: BadgeCheck, count: 'pendingVerifications', tone: 'is-gold' },
  { id: 'users', label: 'Users', icon: Users },
  { id: 'reports', label: 'Reports', icon: Flag, count: 'openReports', tone: 'is-alert' },
  { id: 'support', label: 'Support', icon: LifeBuoy, count: 'openSupport', tone: 'is-alert' },
  { id: 'help', label: 'Help Center', icon: FileText },
  { id: 'billing', label: 'Subscriptions', icon: CreditCard, tag: 'Soon' },
];
const TITLES = { overview: 'Overview', verification: 'Verification', users: 'Users', reports: 'Reports', support: 'Support', help: 'Help Center', billing: 'Subscriptions' };
const sectionFromHash = () => {
  const id = window.location.hash.replace('#', '');
  return SECTIONS.some((section) => section.id === id) ? id : 'overview';
};
const LIVE_EVERY_MS = 10_000;

function useLive() {
  const [live, setLive] = useState(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let stopped = false;
    const load = () => adminRequest('/api/admin/v1/live').then((data) => { if (!stopped) setLive(data); }).catch(() => {});
    load();
    const poll = setInterval(() => { if (document.visibilityState === 'visible') load(); }, LIVE_EVERY_MS);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { stopped = true; clearInterval(poll); clearInterval(clock); };
  }, []);
  return { live, age: live ? Math.max(0, Math.round((now - live.at) / 1000)) : null, refresh: () => adminRequest('/api/admin/v1/live').then(setLive).catch(() => {}) };
}

function Ticker({ live, age }) {
  const items = live ? [
    ['Online now', live.online, 'is-live'],
    ['Active last hour', live.activeLastHour],
    ['Messages last hour', live.messagesLastHour],
    ['Sign-ups today', live.signupsToday],
    ['Pending verifications', live.pendingVerifications, live.pendingVerifications ? 'is-gold' : ''],
    ['Open reports', live.openReports, live.openReports ? 'is-alert' : ''],
  ] : [];
  return (
    <div className="ad-ticker" aria-live="polite" aria-label="Live status">
      {items.map(([label, value, tone]) => (
        <span key={label} className={`ad-tick ${tone ?? ''}`}><b>{Number(value).toLocaleString()}</b>{label}</span>
      ))}
      <span className="ad-tick-age"><i className="ad-pulse" aria-hidden="true" />{age === null ? 'Connecting…' : age < 3 ? 'Live' : `Updated ${age}s ago`}</span>
    </div>
  );
}

export default function Dashboard({ username, onSignOut }) {
  const [section, setSection] = useState(sectionFromHash);
  const { live, age, refresh } = useLive();
  useEffect(() => {
    const onHash = () => setSection(sectionFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const go = (id) => { window.location.hash = id; setSection(id); window.scrollTo({ top: 0 }); };

  return (
    <div className="ad-shell">
      <aside className="ad-sidebar">
        <div className="ad-brand"><BrandMark className="ad-brand-mark" /><span>Hidden Messenger<small>Admin</small></span></div>
        <nav aria-label="Sections">
          {SECTIONS.map(({ id, label, icon: Icon, count, tone, tag }) => (
            <button key={id} type="button" className={`ad-nav${section === id ? ' is-on' : ''}`} aria-current={section === id ? 'page' : undefined} onClick={() => go(id)}>
              <Icon size={17} aria-hidden="true" /><span>{label}</span>
              {count && live?.[count] ? <span className={`ad-count ${tone}`}>{live[count]}</span> : null}
              {tag && <span className="ad-tag">{tag}</span>}
            </button>
          ))}
        </nav>
        <div className="ad-sidebar-foot">
          <p className="ad-privacy"><Lock size={13} aria-hidden="true" /> Chat messages and media are end-to-end encrypted and never visible here. Support conversations are not encrypted.</p>
          <div className="ad-me"><span>{username}</span><button type="button" className="ad-btn is-small" onClick={onSignOut}><LogOut size={14} /> Sign out</button></div>
        </div>
      </aside>
      <div className="ad-main">
        <header className="ad-topbar">
          <h1>{TITLES[section]}</h1>
          <Ticker live={live} age={age} />
        </header>
        <main className="ad-content">
          {section === 'overview' && <Overview onNavigate={go} />}
          {section === 'verification' && <VerificationHub onChanged={refresh} />}
          {section === 'users' && <div className="ad-card ad-legacy"><UsersTab /></div>}
          {section === 'reports' && <div className="ad-card ad-legacy"><ReportsTab /></div>}
          {section === 'support' && <Support onChanged={refresh} />}
          {section === 'help' && <div className="ad-card ad-legacy"><HelpTab /></div>}
          {section === 'billing' && <Billing />}
        </main>
      </div>
    </div>
  );
}
