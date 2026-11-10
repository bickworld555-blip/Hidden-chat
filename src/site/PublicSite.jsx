// hiddenmessenger.com's public website: Home, Features, Privacy, Business, Download and the Help Center. The
// messenger itself lives at /app (src/App.jsx). Pages switch without reloading (history API); the Help Center reads
// its articles from the server, where admins edit them (src/components/admin/AdminConsole.jsx).
import { useEffect, useState } from 'react';
import { ArrowRight, BadgeCheck, Building2, Check, ChevronRight, CircleDashed, KeyRound, Lock, Megaphone, MessageCircle, Phone, Search, ShieldCheck, Smartphone, Store, UsersRound } from 'lucide-react';
import ShieldMark from '../components/ShieldMark.jsx';
import { apiFetch } from '../api.js';
import { ANDROID_APK_URL } from './links.js';
import './site.css';

const PAGES = [
  ['/messaging', 'Messaging'],
  ['/calling', 'Calling'],
  ['/features', 'Features'],
  ['/privacy', 'Privacy'],
  ['/business', 'Business'],
  ['/help', 'Help Center'],
];
const CATEGORY_NAMES = { 'getting-started': 'Getting started', chats: 'Chats', calls: 'Calls', 'groups-communities': 'Groups & communities', 'privacy-security': 'Privacy & security', account: 'Account', business: 'Business' };

function usePath() {
  const [path, setPath] = useState(() => globalThis.location?.pathname ?? '/');
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);
  const go = (next) => {
    if (next === path) return;
    history.pushState(null, '', next);
    setPath(next);
    scrollTo({ top: 0 });
  };
  return [path, go];
}

function Link({ to, go, className, children }) {
  return <a href={to} className={className} onClick={(event) => { if (event.metaKey || event.ctrlKey) return; event.preventDefault(); go(to); }}>{children}</a>;
}

function Header({ path, go }) {
  const [open, setOpen] = useState(false);
  return (
    <header className="site-header">
      <div className="site-wrap site-header-row">
        <Link to="/" go={go} className="site-brand"><ShieldMark className="site-brand-mark" /><span>Hidden Messenger</span></Link>
        <nav className={`site-nav${open ? ' is-open' : ''}`} aria-label="Main">
          {PAGES.map(([to, label]) => <Link key={to} to={to} go={(next) => { setOpen(false); go(next); }} className={path.startsWith(to) ? 'is-active' : ''}>{label}</Link>)}
        </nav>
        <div className="site-header-actions">
          <a href="/app" className="site-button is-ghost">Log in</a>
          <Link to="/download" go={go} className="site-button">Download</Link>
          <button type="button" className="site-menu" aria-label="Menu" aria-expanded={open} onClick={() => setOpen(!open)}><span /><span /><span /></button>
        </div>
      </div>
    </header>
  );
}

function Footer({ go }) {
  const groups = [
    ['Product', [['/messaging', 'Messaging'], ['/calling', 'Calling'], ['/features', 'All features'], ['/business', 'For business'], ['/download', 'Download'], ['/app', 'Open web app']]],
    ['Trust', [['/privacy', 'Privacy & encryption'], ['/help/end-to-end-encryption', 'How encryption works'], ['/help/report-and-block', 'Report abuse']]],
    ['Help', [['/help', 'Help Center'], ['/help/create-account', 'Create an account'], ['/help/install-android', 'Install on Android']]],
  ];
  return (
    <footer className="site-footer">
      <div className="site-wrap site-footer-grid">
        <div className="site-footer-brand"><ShieldMark className="site-brand-mark" /><p>Private messaging without a phone number. Your messages are locked on your device.</p></div>
        {groups.map(([title, links]) => (
          <div key={title}>
            <h4>{title}</h4>
            {links.map(([to, label]) => (to === '/app' ? <a key={to} href={to}>{label}</a> : <Link key={to} to={to} go={go}>{label}</Link>))}
          </div>
        ))}
      </div>
      <div className="site-wrap site-footer-legal">© {new Date().getFullYear()} Hidden Messenger</div>
    </footer>
  );
}

function Feature({ icon: Icon, title, children, flip = false, visual }) {
  return (
    <section className={`site-feature${flip ? ' is-flipped' : ''}`}>
      <div className="site-feature-copy">
        <span className="site-feature-icon"><Icon size={22} /></span>
        <h2>{title}</h2>
        <p>{children}</p>
      </div>
      <div className="site-feature-visual" aria-hidden="true">{visual}</div>
    </section>
  );
}

// A small drawn phone chat used as the hero and feature illustration (no photos needed).
function ChatMock({ lines }) {
  return (
    <div className="site-phone">
      <div className="site-phone-bar"><span className="site-phone-avatar" /> <strong>Maya</strong><small>online</small></div>
      <div className="site-phone-body">
        {lines.map(([mine, text], index) => <p key={index} className={mine ? 'is-mine' : ''}>{text}<small>{mine ? '10:4' + index + ' ✓✓' : '10:4' + index}</small></p>)}
        <span className="site-phone-lock"><Lock size={11} /> Messages are end-to-end encrypted</span>
      </div>
    </div>
  );
}

function Home({ go }) {
  return (
    <>
      <section className="site-hero">
        <div className="site-wrap site-hero-grid">
          <div>
            <span className="site-eyebrow"><ShieldCheck size={15} /> End-to-end encrypted by default</span>
            <h1>Talk freely. Nobody else is listening.</h1>
            <p>Chats, calls, groups and channels with no phone number and no email. Everything you send is locked on your device before it leaves.</p>
            <div className="site-hero-actions">
              <Link to="/download" go={go} className="site-button is-large">Download for Android <ArrowRight size={18} /></Link>
              <a href="/app" className="site-button is-large is-ghost">Open in your browser</a>
            </div>
          </div>
          <ChatMock lines={[[false, 'Is the new app really private?'], [true, 'Yes: the server only sees locked data'], [false, 'And it needs no phone number?'], [true, 'Just a username 🔒']]} />
        </div>
      </section>
      <div className="site-wrap">
        <Feature icon={Lock} title="Private by design" visual={<div className="site-code"><span>Your security code</span><strong>81067 12328 00466 40573<br />26146 57599 43989 72411<br />59609 24918 27440 48255</strong></div>}>
          Messages, photos, voice notes, reactions, poll votes and statuses are encrypted with keys that only your chat has. Compare a 60-digit security code to be sure nobody is in between.
        </Feature>
        <Feature flip icon={Phone} title="Calls that feel close" visual={<div className="site-call"><span className="site-call-ring" /><strong>Voice call</strong><small>Encrypted · 04:12</small></div>}>
          Voice and video calls go directly between phones, protected end to end. Call links let people reach you without swapping usernames first.
        </Feature>
        <Feature icon={UsersRound} title="Groups and communities" visual={<div className="site-stack">{['Family', 'Book club', 'Team HQ'].map((name) => <span key={name}><UsersRound size={16} /> {name}</span>)}</div>}>
          Plan with friends, run a team or organise a whole neighbourhood. Admins control who joins, who can post and what the group is about.
        </Feature>
        <Feature flip icon={CircleDashed} title="Status, channels and broadcasts" visual={<div className="site-rings">{[0, 1, 2, 3].map((index) => <span key={index} />)}</div>}>
          Share a moment for 24 hours with the people you choose, follow channels on topics you care about, or send one message to a list of people at once.
        </Feature>
        <Feature icon={Store} title="Built for business" visual={<div className="site-stack">{['Catalog', 'Orders', 'Away messages', 'Quick replies'].map((name) => <span key={name}><Check size={16} /> {name}</span>)}</div>}>
          Show your catalog, take orders in the chat, label conversations and answer when you are closed with business hours and away messages.
        </Feature>
      </div>
      <section className="site-cta">
        <div className="site-wrap">
          <h2>Start a private conversation today.</h2>
          <div className="site-hero-actions"><Link to="/download" go={go} className="site-button is-large is-light">Get Hidden Messenger</Link></div>
        </div>
      </section>
    </>
  );
}

function Features() {
  const groups = [
    [MessageCircle, 'Messaging', ['Text, photos, videos, documents', 'Voice notes with waveforms and speed control', 'Edit within 15 minutes, delete for everyone', 'View once photos, videos and voice notes', 'Stickers, including ones you make from photos', 'Pins, stars, replies, reactions and mentions', 'Scheduled messages']],
    [Phone, 'Calls', ['Voice and video calls', 'Group calls', 'Call links', 'Calls ring on your phone even when the app is closed']],
    [UsersRound, 'Groups & communities', ['Admins, permissions and invite links', 'Join requests and approvals', 'Communities with announcements', 'Polls and events']],
    [Megaphone, 'Updates', ['Status for 24 hours with privacy controls', 'Replies and muting', 'Channels you follow or run', 'Broadcast lists']],
    [KeyRound, 'Security', ['End-to-end encryption on every device', 'Two-step verification PIN', 'Chat lock and app lock', 'Encrypted backups']],
    [Building2, 'Business', ['Catalog and orders', 'Labels and quick replies', 'Greeting and away messages', 'Business hours']],
  ];
  return (
    <div className="site-wrap site-page">
      <h1>Everything in Hidden Messenger</h1>
      <p className="site-lede">One app for chatting, calling and staying informed, on Android and in your browser.</p>
      <div className="site-grid">
        {groups.map(([Icon, title, items]) => (
          <section key={title} className="site-card">
            <h2><Icon size={20} /> {title}</h2>
            <ul>{items.map((item) => <li key={item}><Check size={15} /> {item}</li>)}</ul>
          </section>
        ))}
      </div>
    </div>
  );
}

function Privacy({ go }) {
  const rows = [
    ['Message text, photos, voice notes', 'Only the people in the chat', 'Locked ciphertext'],
    ['Reactions, poll votes, statuses', 'Only the people they are for', 'Locked ciphertext'],
    ['Link previews', 'Made on the sender’s phone', 'Nothing'],
    ['Who talks to whom, and when', 'Needed to deliver messages', 'Yes'],
    ['Your phone number or email', 'Never asked for', 'Nothing'],
  ];
  return (
    <div className="site-wrap site-page">
      <h1>Privacy you can check</h1>
      <p className="site-lede">Hidden Messenger encrypts on your device using the same family of techniques as the Signal Protocol: a new key agreement for every device, keys that change with every message, and group keys that change when people leave.</p>
      <div className="site-table">
        <table>
          <thead><tr><th>What</th><th>Who can read it</th><th>What our server sees</th></tr></thead>
          <tbody>{rows.map(([what, who, server]) => <tr key={what}><td>{what}</td><td>{who}</td><td>{server}</td></tr>)}</tbody>
        </table>
      </div>
      <div className="site-grid">
        <section className="site-card"><h2><BadgeCheck size={20} /> Verify a chat</h2><p>Open a contact’s info › Encryption. If your 60-digit code matches theirs, the chat reaches the right devices.</p></section>
        <section className="site-card"><h2><Smartphone size={20} /> Code you can trust</h2><p>The Android app carries its own code and never loads it from a website, so nobody can change it from a server.</p></section>
      </div>
      <h2>Your account and your devices</h2>
      <div className="site-grid">
        <section className="site-card"><h2><KeyRound size={20} /> No phone number</h2><p>An account is a username, a date of birth and a password. Add a two-step PIN so a new device also needs it.</p></section>
        <section className="site-card"><h2><Smartphone size={20} /> Linked devices</h2><p>Every phone and browser you link has its own keys. See and sign out any device under Settings › Linked devices.</p></section>
        <section className="site-card"><h2><BadgeCheck size={20} /> Reports and safety</h2><p>Report or block someone from their contact info. Reports go to the Hidden Messenger team with the reason you choose; they never include your messages.</p></section>
      </div>
      <p><Link to="/help/end-to-end-encryption" go={go} className="site-more">Read how encryption works <ChevronRight size={16} /></Link></p>
    </div>
  );
}

function Steps({ items }) {
  return <ol className="site-steps">{items.map(([title, text]) => <li key={title}><strong>{title}</strong><span>{text}</span></li>)}</ol>;
}

function Messaging({ go }) {
  return (
    <div className="site-wrap site-page">
      <span className="site-eyebrow"><MessageCircle size={15} /> Messaging</span>
      <h1>Say it any way you like, privately</h1>
      <p className="site-lede">Text, voice notes, photos, videos, documents, stickers and polls, on your phone and in your browser, all end-to-end encrypted.</p>
      <div className="site-grid">
        {[[MessageCircle, 'Messages that keep up', 'Edit for 15 minutes, delete for everyone, reply, react, pin, star and forward. Schedule a message to go out later.'],
          [Smartphone, 'Voice notes and video notes', 'Record a voice note with a live waveform, or a round video note up to a minute. Send either as view once.'],
          [UsersRound, 'Groups that stay organised', 'Mentions, polls, events, admins and invite links. Communities bring related groups together with announcements.'],
          [Lock, 'Locked chats', 'Move your most private chats into a folder that opens only with your fingerprint, screen lock or passcode.']].map(([Icon, title, text]) => (
          <section key={title} className="site-card"><h2><Icon size={20} /> {title}</h2><p>{text}</p></section>
        ))}
      </div>
      <h2>Use it on your computer</h2>
      <Steps items={[['Open hiddenmessenger.com/app', 'on your computer and choose “Link with your phone”.'], ['On your phone', 'go to Settings › Account & privacy › Linked devices › Link a device.'], ['Scan the QR code', 'Your recent chats arrive end-to-end encrypted, and new messages show on both.']]} />
      <p><a className="site-button" href="/app">Open the web app</a></p>
    </div>
  );
}

function Calling({ go }) {
  return (
    <div className="site-wrap site-page">
      <span className="site-eyebrow"><Phone size={15} /> Calling</span>
      <h1>Call anyone, in a voice they can trust</h1>
      <p className="site-lede">Voice and video calls go straight between devices and are encrypted end to end, on mobile data or Wi-Fi.</p>
      <div className="site-grid">
        {[[Phone, 'Voice and video', 'Switch between voice and video during a call, share your screen from a computer, and react without interrupting.'],
          [UsersRound, 'Group calls', 'Bring your group together in one call and add people while it is running.'],
          [Smartphone, 'Rings like a phone call', 'On Android, incoming calls ring on the lock screen and through your phone’s own call screen, even when the app is closed.'],
          [KeyRound, 'Call links', 'Share a link so people can call you without your username, and revoke it at any time.']].map(([Icon, title, text]) => (
          <section key={title} className="site-card"><h2><Icon size={20} /> {title}</h2><p>{text}</p></section>
        ))}
      </div>
      <p><Link to="/help/end-to-end-encryption" go={go} className="site-more">How calls stay private <ChevronRight size={16} /></Link></p>
    </div>
  );
}

function Business({ go }) {
  return (
    <div className="site-wrap site-page">
      <h1>Hidden Messenger for business</h1>
      <p className="site-lede">Talk to customers where they already chat, with the same encryption as everyone else.</p>
      <div className="site-grid">
        {[[Store, 'Catalog', 'Show products with photos and prices; customers browse them in the chat.'], [Check, 'Orders', 'Customers pick items and send an order; you accept it and mark it paid, shipped and delivered.'], [Megaphone, 'Away & greeting', 'Answer automatically when you are closed, using your business hours, and welcome new customers.'], [MessageCircle, 'Labels & quick replies', 'Sort chats with coloured labels and answer common questions with a shortcut.']].map(([Icon, title, text]) => (
          <section key={title} className="site-card"><h2><Icon size={20} /> {title}</h2><p>{text}</p></section>
        ))}
      </div>
      <p><Link to="/download" go={go} className="site-button">Get started</Link></p>
    </div>
  );
}

function Download() {
  return (
    <div className="site-wrap site-page">
      <h1>Get Hidden Messenger</h1>
      <div className="site-grid">
        <section className="site-card site-download">
          <h2><Smartphone size={20} /> Android</h2>
          <p>Install the app on Android 7 or newer. If your phone asks, allow installing apps from your browser.</p>
          <a className="site-button is-large" href={ANDROID_APK_URL}>Download the APK</a>
        </section>
        <section className="site-card site-download">
          <h2><MessageCircle size={20} /> Web</h2>
          <p>Use Hidden Messenger in Chrome, Edge, Firefox or Safari on your computer. Sign in with your username and password.</p>
          <a className="site-button is-large is-ghost" href="/app">Open the web app</a>
        </section>
      </div>
    </div>
  );
}

function HelpCenter({ go }) {
  const [data, setData] = useState(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => {
      apiFetch(`/api/v1/help${query ? `?q=${encodeURIComponent(query)}` : ''}`).then((response) => (response.ok ? response.json() : Promise.reject(new Error('The Help Center is not available right now.'))))
        .then((value) => { setData(value); setError(''); }).catch((caught) => setError(caught.message));
    }, query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [query]);
  return (
    <div className="site-help">
      <section className="site-help-hero">
        <div className="site-wrap">
          <h1>How can we help?</h1>
          <label className="site-search"><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search help articles" aria-label="Search help articles" /></label>
        </div>
      </section>
      <div className="site-wrap">
        {error && <p className="site-error">{error}</p>}
        {data && (data.categories ?? []).map((category) => {
          const list = data.articles.filter((article) => article.category === category);
          if (!list.length) return null;
          return (
            <section key={category} className="site-help-group">
              <h2>{CATEGORY_NAMES[category] ?? category}</h2>
              {list.map((article) => (
                <Link key={article.slug} to={`/help/${article.slug}`} go={go} className="site-help-row"><span><strong>{article.title}</strong><small>{article.summary}</small></span><ChevronRight size={18} /></Link>
              ))}
            </section>
          );
        })}
        {data && !data.articles.length && <p className="site-lede">No articles match “{query}”.</p>}
      </div>
    </div>
  );
}

function HelpArticle({ slug, go }) {
  const [article, setArticle] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    apiFetch(`/api/v1/help/${encodeURIComponent(slug)}`).then((response) => (response.ok ? response.json() : Promise.reject(new Error('This article does not exist.'))))
      .then(setArticle).catch((caught) => setError(caught.message));
  }, [slug]);
  return (
    <div className="site-wrap site-page site-article">
      <Link to="/help" go={go} className="site-more">‹ Help Center</Link>
      {error && <p className="site-error">{error}</p>}
      {article && (
        <article>
          <small className="site-eyebrow">{CATEGORY_NAMES[article.category] ?? article.category}</small>
          <h1>{article.title}</h1>
          {article.body.split(/\n{2,}/).map((paragraph, index) => <p key={index}>{paragraph}</p>)}
          <small className="site-updated">Updated {new Date(article.updatedAt).toLocaleDateString()}</small>
        </article>
      )}
    </div>
  );
}

export default function PublicSite() {
  const [path, go] = usePath();
  useEffect(() => { document.title = path === '/' ? 'Hidden Messenger · Private messaging' : `${(PAGES.find(([to]) => path.startsWith(to))?.[1] ?? 'Download')} · Hidden Messenger`; }, [path]);
  const helpSlug = /^\/help\/([a-z0-9-]+)\/?$/.exec(path)?.[1];
  const page = helpSlug ? <HelpArticle slug={helpSlug} go={go} />
    : path.startsWith('/help') ? <HelpCenter go={go} />
      : path.startsWith('/messaging') ? <Messaging go={go} />
        : path.startsWith('/calling') ? <Calling go={go} />
      : path.startsWith('/features') ? <Features />
        : path.startsWith('/privacy') ? <Privacy go={go} />
          : path.startsWith('/business') ? <Business go={go} />
            : path.startsWith('/download') ? <Download />
              : <Home go={go} />;
  return (
    <div className="site">
      <Header path={path} go={go} />
      <main>{page}</main>
      <Footer go={go} />
    </div>
  );
}
