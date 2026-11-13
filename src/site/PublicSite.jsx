// hiddenmessenger.com's public website: Home, Features, Privacy, Business, Download and the Help Center. The
// messenger itself lives at /app (src/App.jsx). Pages switch without reloading (history API); the Help Center reads
// its articles from the server, where admins edit them on the admin page (src/admin/AdminConsole.jsx).
import { useEffect, useState } from 'react';
import { ArrowRight, BadgeCheck, Building2, Check, ChevronRight, CircleDashed, Download as DownloadIcon, KeyRound, Lock, Megaphone, MessageCircle, Monitor, Phone, Search, ShieldCheck, Smartphone, Store, UsersRound } from 'lucide-react';
import BrandMark from '../components/BrandMark.jsx';
import { apiFetch } from '../api.js';
import { ANDROID_APK_URL, WINDOWS_APP_VERSION, WINDOWS_INSTALLER_URL, WINDOWS_PORTABLE_URL } from './links.js';
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
        <Link to="/" go={go} className="site-brand"><BrandMark className="site-brand-mark" /><span>Hidden Messenger</span></Link>
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
    ['Trust', [['/privacy', 'Privacy & encryption'], ['/terms', 'Terms of Service'], ['/help/end-to-end-encryption', 'How encryption works'], ['/help/report-and-block', 'Report abuse'], ['/delete-account', 'Delete your account']]],
    ['Help', [['/help', 'Help Center'], ['/help/create-account', 'Create an account'], ['/help/install-android', 'Install on Android']]],
  ];
  return (
    <footer className="site-footer">
      <div className="site-wrap site-footer-grid">
        <div className="site-footer-brand"><BrandMark className="site-brand-mark" /><p>Private messaging without a phone number. Your messages are locked on your device.</p></div>
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
              <a href={WINDOWS_INSTALLER_URL} className="site-button is-large is-ghost site-windows-button" download>
                <Monitor size={18} aria-hidden="true" /> Download for Windows (.exe)
              </a>
              <a href="/app" className="site-button is-large is-ghost">Open in your browser</a>
            </div>
            <p className="site-hero-note">The Windows app runs on Windows 10 and 11 (64-bit) and links to the app on your phone with a QR code. <Link to="/download" go={go} className="site-more">More download options <ChevronRight size={14} /></Link></p>
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

// Terms of Service in plain words (Settings › Help and feedback › Terms of Service opens this page).
function Terms() {
  const sections = [
    ['Who can use Hidden Messenger', 'You need to be old enough to use online services where you live (at least 13). One account is for one person or one business, and you are responsible for what is sent from it.'],
    ['Your account', 'Keep your password and two-step PIN to yourself. You can sign out other devices in Settings › Linked devices and delete your account at any time in Settings › Account; deleting it removes your profile, contacts and messages waiting on the server.'],
    ['Your messages', 'Messages, calls and files are end-to-end encrypted: we cannot read them and we do not sell or share your content. Messages wait on the server only until your devices receive them (at most 30 days).'],
    ['Acceptable use', 'Do not use Hidden Messenger to break the law, harass or threaten people, send spam or bulk messages people did not ask for, spread malware, impersonate others, or share content that exploits children. Reported accounts can be reviewed and suspended.'],
    ['Business features', 'Business tools (catalogue, orders, broadcast lists, away and greeting messages) must describe real products and services. Payments agreed in a chat are between you and the customer.'],
    ['Changes and availability', 'We keep improving the app and may change or remove features. We try to keep the service running but cannot promise it will always be available or free of errors.'],
    ['Ending use', 'You can stop using Hidden Messenger at any time. We may suspend accounts that break these terms; you can ask for a review through Help Centre › Contact us.'],
    ['Contact', 'Questions about these terms: Settings › Help and feedback › Send feedback, or Help Centre › Contact us in the app.'],
  ];
  return (
    <div className="site-wrap site-page">
      <h1>Terms of Service</h1>
      <p className="site-lede">The short version: use Hidden Messenger to talk to people who want to hear from you, keep your account safe, and don’t use it to hurt anyone. Your messages stay private.</p>
      {sections.map(([title, body]) => <section key={title} className="site-terms-section"><h2>{title}</h2><p>{body}</p></section>)}
      <p className="site-muted">Last updated {new Date(2026, 10, 13).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}.</p>
    </div>
  );
}

// The privacy policy: every kind of data, who reads it and what the server keeps, matching the code and the Play
// Store Data safety answers (docs/play-store/data-safety.md). Change them together.
export const PRIVACY_ROWS = [
  ['Message text, photos, videos, voice notes, files, shared locations', 'Only the people in the chat', 'Locked ciphertext, deleted once every device received it (30 days at most)'],
  ['Reactions, poll votes, statuses', 'Only the people they are for', 'Locked ciphertext; statuses disappear after 24 hours'],
  ['Link previews', 'Made on the sender’s phone', 'Nothing'],
  ['Your username, display name and date of birth', 'Username and name: people you chat with. Date of birth: no one', 'Kept for your account; the date of birth only checks the minimum age'],
  ['Your profile photo and About', 'Who you choose in Settings › Privacy', 'Kept until you change or delete them'],
  ['Who talks to whom, and when', 'Needed to deliver messages', 'Contacts you add and delivery records (no message content)'],
  ['Push notification token (Firebase Cloud Messaging)', 'Google’s push service, to wake the app', 'Kept while the app is signed in on that phone'],
  ['Messages to Hidden Messenger Support', 'You and the Support team', 'Readable by the Support team; deleted with your account'],
  ['Business profile, catalogue and auto-replies (business accounts)', 'Customers who open your profile or chat with you', 'Readable by the server, which shows them for you; deleted with your account'],
  ['Your phone number or email', 'Never asked for', 'Nothing: there is nowhere to store them'],
  ['Your phone’s contacts', 'Never read', 'Nothing: the app has no permission to read them'],
  ['Your country (from your phone’s time zone)', 'Counted in totals per country', 'The country only: no IP address or location'],
];

function Privacy({ go }) {
  return (
    <div className="site-wrap site-page">
      <h1>Privacy you can check</h1>
      <p className="site-lede">No email. No phone number. We never access your contacts. Hidden Messenger encrypts on your device using the same family of techniques as the Signal Protocol: a new key agreement for every device, keys that change with every message, and group keys that change when people leave.</p>
      <div className="site-table">
        <table>
          <thead><tr><th>What</th><th>Who can read it</th><th>What our server keeps</th></tr></thead>
          <tbody>{PRIVACY_ROWS.map(([what, who, server]) => <tr key={what}><td>{what}</td><td>{who}</td><td>{server}</td></tr>)}</tbody>
        </table>
      </div>
      <div className="site-grid">
        <section className="site-card"><h2><BadgeCheck size={20} /> Verify a chat</h2><p>Open a contact’s info › Encryption. If your 60-digit code matches theirs, the chat reaches the right devices.</p></section>
        <section className="site-card"><h2><Smartphone size={20} /> Code you can trust</h2><p>The Android app carries its own code and never loads it from a website, so nobody can change it from a server.</p></section>
      </div>
      <h2>Your account and your devices</h2>
      <div className="site-grid">
        <section className="site-card"><h2><KeyRound size={20} /> No phone number</h2><p>An account is a username, a date of birth and a password. Add a two-step PIN so a new device also needs it.</p></section>
        <section className="site-card"><h2><Search size={20} /> Finding people</h2><p>People find you only by typing your exact username, or through an invite link you share. Turn off Settings › Privacy › Discoverable by username to be found only through your links.</p></section>
        <section className="site-card"><h2><Smartphone size={20} /> Linked devices</h2><p>Every phone and browser you link has its own keys. See and sign out any device under Settings › Linked devices.</p></section>
        <section className="site-card"><h2><BadgeCheck size={20} /> Reports and safety</h2><p>Report or block someone from their contact info. Reports go to the Hidden Messenger team with the reason you choose; they never include your messages.</p></section>
      </div>
      <h2>How long we keep things</h2>
      <ul className="site-list">
        <li>Messages wait on the server only until every device they are for has received them, and 30 days at most.</li>
        <li>Statuses disappear after 24 hours. Invite links expire after 7 days, or sooner when used up or revoked.</li>
        <li>Your encrypted backup, if you make one, stays until you replace it or delete your account.</li>
        <li>Deleting your account removes your profile, contacts, group memberships, statuses, backup, business profile, Support messages and push tokens at once. A “Deleted account” placeholder keeps other people’s chats readable. Messages already on other people’s phones stay with them.</li>
      </ul>
      <p>Delete your account in the app (Settings › Account › Delete account) or <Link to="/delete-account" go={go}>on the website</Link>. Questions about your data: message Hidden Messenger Support in the app (Settings › Help and feedback).</p>
      <p><Link to="/help/end-to-end-encryption" go={go} className="site-more">Read how encryption works <ChevronRight size={16} /></Link></p>
    </div>
  );
}

// Google Play requires a way to delete an account outside the app: the username, the password and "DELETE".
function DeleteAccount({ go }) {
  const [form, setForm] = useState({ username: '', password: '', confirm: '' });
  const [state, setState] = useState({ busy: false, error: '', done: false });
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  async function submit(event) {
    event.preventDefault();
    setState({ busy: true, error: '', done: false });
    try {
      const response = await apiFetch('/api/v1/account/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      if (response.status === 204) { setForm({ username: '', password: '', confirm: '' }); setState({ busy: false, error: '', done: true }); return; }
      const data = await response.json().catch(() => null);
      setState({ busy: false, error: data?.error || 'Your account could not be deleted. Try again.', done: false });
    } catch {
      setState({ busy: false, error: 'No connection. Check your internet and try again.', done: false });
    }
  }
  return (
    <div className="site-wrap site-page site-narrow">
      <h1>Delete your account</h1>
      <p className="site-lede">This deletes your Hidden Messenger account and the data the server keeps for it, at once. It can’t be undone.</p>
      <ul className="site-list">
        <li>Removed: your profile, username, date of birth, contacts, group memberships, statuses, encrypted backup, business profile and catalogue, Support messages and push tokens.</li>
        <li>Your username becomes free for someone else. Other people see “Deleted account” in their chats with you.</li>
        <li>Messages already on other people’s phones stay with them, as on any messenger.</li>
      </ul>
      <p>You can also delete it in the app: Settings › Account › Delete account.</p>
      {state.done ? (
        <p className="site-notice" role="status">Your account was deleted and every device was signed out.</p>
      ) : (
        <form className="site-form" onSubmit={submit}>
          <label>Username<input value={form.username} onChange={set('username')} autoComplete="username" required maxLength={40} placeholder="@username" /></label>
          <label>Password<input type="password" value={form.password} onChange={set('password')} autoComplete="current-password" required maxLength={128} /></label>
          <label>Type DELETE to confirm<input value={form.confirm} onChange={set('confirm')} required autoComplete="off" /></label>
          {state.error && <p className="site-error" role="alert">{state.error}</p>}
          <button type="submit" className="site-button is-danger" disabled={state.busy || form.confirm !== 'DELETE'}>{state.busy ? 'Deleting…' : 'Delete my account'}</button>
        </form>
      )}
      <p><Link to="/privacy" go={go} className="site-more">Privacy policy <ChevronRight size={16} /></Link></p>
    </div>
  );
}

// An invite link (hiddenmessenger.com/c#<token>): the token stays after "#", so this page never sends it anywhere.
// "Open in the app" hands it to the Android app (hiddenmessenger://c#<token>), which redeems it.
function ConnectInvite() {
  const token = /^#([A-Za-z0-9_-]{22})$/.exec(globalThis.location?.hash ?? '')?.[1] ?? '';
  return (
    <div className="site-wrap site-page site-narrow">
      <h1>You’re invited to chat</h1>
      <p className="site-lede">Someone shared their Hidden Messenger invite with you: private messaging with no phone number and no email.</p>
      {token ? (
        <div className="site-actions">
          <a className="site-button is-large" href={`hiddenmessenger://c#${token}`}>Open in the app</a>
          <a className="site-button is-large is-ghost" href={ANDROID_APK_URL}>Get the app</a>
        </div>
      ) : <p className="site-error">This invite link is incomplete. Ask for the whole link again.</p>}
      <p className="site-muted">New to Hidden Messenger? Install the app and sign up, then open this link again. You can also paste the link into the search box of New chat in the app.</p>
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
      <Steps items={[['Open hiddenmessenger.com/app', 'on your computer and choose “Link with your phone”.'], ['On your phone', 'go to Settings › Account › Linked devices › Link a device.'], ['Scan the QR code', 'Your recent chats arrive end-to-end encrypted, and new messages show on both.']]} />
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
          <h2><Monitor size={20} /> Windows</h2>
          <p>The desktop app for Windows 10 and 11 (64-bit). Install it, then link it to the app on your phone by scanning a QR code: Settings › Linked devices › Link a device.</p>
          <a className="site-button is-large" href={WINDOWS_INSTALLER_URL} download><DownloadIcon size={18} aria-hidden="true" /> Download for Windows (.exe)</a>
          <p className="site-download-alt">Version {WINDOWS_APP_VERSION} · <a href={WINDOWS_PORTABLE_URL} download>Portable version</a> (runs without installing)</p>
          <p className="site-download-note">Windows may show a SmartScreen notice the first time, because the app is new: choose <strong>More info › Run anyway</strong>.</p>
        </section>
        <section className="site-card site-download">
          <h2><MessageCircle size={20} /> Web</h2>
          <p>Use Hidden Messenger in Chrome, Edge, Firefox or Safari on your computer. Link it to the app on your phone by scanning a QR code.</p>
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
  useEffect(() => { document.title = path === '/' ? 'Hidden Messenger · Private messaging' : `${(PAGES.find(([to]) => path.startsWith(to))?.[1] ?? (path.startsWith('/delete-account') ? 'Delete your account' : /^\/c\/?$/.test(path) ? 'Invite' : 'Download'))} · Hidden Messenger`; }, [path]);
  const helpSlug = /^\/help\/([a-z0-9-]+)\/?$/.exec(path)?.[1];
  const page = helpSlug ? <HelpArticle slug={helpSlug} go={go} />
    : path.startsWith('/help') ? <HelpCenter go={go} />
      : path.startsWith('/messaging') ? <Messaging go={go} />
        : path.startsWith('/calling') ? <Calling go={go} />
      : path.startsWith('/features') ? <Features />
        : path.startsWith('/privacy') ? <Privacy go={go} />
        : path.startsWith('/delete-account') ? <DeleteAccount go={go} />
        : /^\/c\/?$/.test(path) ? <ConnectInvite />
        : path.startsWith('/terms') ? <Terms />
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
