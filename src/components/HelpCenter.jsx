// Help Center, laid out like a business messenger's: "How can we help?", a search box, help topics, articles, and a
// floating "Contact us" that opens the conversation with Hidden Messenger Support (answered from the admin console).
import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, FileText, Briefcase, ChevronRight, LifeBuoy, Lock, MessageCircle, Phone, Search, Send, ShieldCheck, UserRound, Users } from 'lucide-react';
import Panel, { Notice } from './parity/Panel.jsx';
import FormattedText from './FormattedText.jsx';
import VerifiedBadge from './VerifiedBadge.jsx';
import BrandMark from './BrandMark.jsx';
import { useAvatarSrc } from '../avatar.js';
import { SUPPORT_EVENT, SUPPORT_MESSAGE_MAX, SUPPORT_NAME, SUPPORT_READ_EVENT, fetchArticle, fetchHelp, fetchSupportMessages, mergeSupportMessage, sendSupportMessage } from '../supportApi.js';
import { formatMessageTime } from '../time.js';

// The server's help categories (server/admin.mjs HELP_CATEGORIES), in the app's words.
export const HELP_TOPICS = {
  'getting-started': { label: 'Get started', icon: BookOpen },
  chats: { label: 'Chats', icon: MessageCircle },
  calls: { label: 'Voice and video calls', icon: Phone },
  'groups-communities': { label: 'Groups and communities', icon: Users },
  'privacy-security': { label: 'Privacy, safety and security', icon: ShieldCheck },
  account: { label: 'Accounts and account bans', icon: UserRound },
  business: { label: 'Hidden Messenger for business', icon: Briefcase },
};

// A photo, video or PDF from support: fetched with the session (an <img> can't send it), then shown or offered.
function SupportMedia({ media }) {
  const src = useAvatarSrc(media.url);
  if (!src) return <span className="support-media is-loading">Loading {media.kind === 'image' ? 'photo' : media.kind === 'video' ? 'video' : 'document'}…</span>;
  if (media.kind === 'image') return <a className="support-media" href={src} target="_blank" rel="noreferrer"><img src={src} alt={media.name} /></a>;
  if (media.kind === 'video') return <video className="support-media" src={src} controls playsInline preload="metadata" />;
  return (
    <a className="support-media support-file" href={src} download={media.name}>
      <FileText size={26} aria-hidden="true" /><span><strong>{media.name}</strong><small>{Math.max(1, Math.round(media.size / 1024)).toLocaleString()} KB · PDF</small></span>
    </a>
  );
}

export function SupportChat({ token, onBack, onClose }) {
  const [messages, setMessages] = useState(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const endRef = useRef(null);
  useEffect(() => {
    let live = true;
    let arrived = false;
    const read = () => window.dispatchEvent(new Event(SUPPORT_READ_EVENT));
    fetchSupportMessages(token).then((list) => { read(); if (live) setMessages(list); }).catch((caught) => { if (live) { setMessages([]); setError(caught.message); } });
    const onMessage = (event) => { if (event.detail?.fromSupport) arrived = true; setMessages((current) => mergeSupportMessage(current ?? [], event.detail)); };
    window.addEventListener(SUPPORT_EVENT, onMessage);
    // Replies that arrived while the chat was open were seen: loading the chat once more marks them read.
    return () => { live = false; window.removeEventListener(SUPPORT_EVENT, onMessage); if (arrived) fetchSupportMessages(token).then(read, () => {}); };
  }, [token]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [messages?.length]);

  async function send(event) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    setError('');
    try {
      const message = await sendSupportMessage(token, body);
      setMessages((current) => mergeSupportMessage(current ?? [], message));
      setDraft('');
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title={<span className="support-title"><BrandMark className="support-title-mark" />{SUPPORT_NAME} <VerifiedBadge size={16} /></span>} subtitle="Official account · Support" label={SUPPORT_NAME} onClose={onClose} onBack={onBack}>
      <div className="support-chat">
        <p className="support-notice"><Lock size={14} aria-hidden="true" /> Messages to support aren’t end-to-end encrypted: the Hidden Messenger team reads them to help you. Never share your password.</p>
        <div className="support-messages" aria-live="polite">
          {messages === null && <p className="hm-muted">Loading…</p>}
          {messages?.length === 0 && <p className="support-empty">Tell us what’s wrong and we’ll reply here. You’ll get a notification when we do.</p>}
          {messages?.map((message) => (
            <div key={message.id} className={`support-bubble ${message.fromSupport ? 'is-support' : 'is-mine'}`}>
              {message.media && <SupportMedia media={message.media} />}
              {message.body && <FormattedText text={message.body} />}
              <time>{formatMessageTime(message.createdAt)}{!message.fromSupport && (message.readBySupport ? ' · Seen' : '')}</time>
            </div>
          ))}
          <span ref={endRef} />
        </div>
        <Notice error={error} />
        <form className="support-composer" onSubmit={send}>
          <textarea value={draft} rows={1} maxLength={SUPPORT_MESSAGE_MAX} onChange={(event) => setDraft(event.target.value)} placeholder="Message" aria-label="Message to support" />
          <button type="submit" className="support-send" disabled={busy || !draft.trim()} aria-label="Send"><Send size={20} /></button>
        </form>
      </div>
    </Panel>
  );
}

export default function HelpCenter({ token, onClose, initialView = 'home' }) {
  const [view, setView] = useState(initialView === 'support' ? { kind: 'support' } : { kind: 'home' });
  const [help, setHelp] = useState(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [article, setArticle] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => { fetchHelp().then(setHelp).catch((caught) => setError(caught.message)); }, []);
  useEffect(() => {
    const text = query.trim();
    if (!text) { setResults(null); return undefined; }
    const timer = setTimeout(() => fetchHelp(text).then((data) => setResults(data.articles)).catch((caught) => setError(caught.message)), 250);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (view.kind !== 'article') return;
    setArticle(null);
    fetchArticle(view.slug).then(setArticle).catch((caught) => setError(caught.message));
  }, [view]);

  const topics = useMemo(() => (help?.categories ?? Object.keys(HELP_TOPICS)).filter((id) => (help?.articles ?? []).some((item) => item.category === id)), [help]);
  const inTopic = view.kind === 'topic' ? (help?.articles ?? []).filter((item) => item.category === view.topic) : [];
  const home = () => { setView({ kind: 'home' }); setError(''); };

  if (view.kind === 'support') return <SupportChat token={token} onClose={onClose} onBack={initialView === 'support' ? undefined : home} />;

  const articleRow = (item) => (
    <button type="button" key={item.slug} className="help-row" onClick={() => setView({ kind: 'article', slug: item.slug, from: view })}>
      <span className="help-row-copy"><strong>{item.title}</strong>{item.summary && <small>{item.summary}</small>}</span>
      <ChevronRight size={18} aria-hidden="true" />
    </button>
  );
  const contactUs = <button type="button" className="help-contact" onClick={() => setView({ kind: 'support' })}><LifeBuoy size={18} /> Contact us</button>;

  if (view.kind === 'article') {
    return (
      <Panel title="Help Center" onClose={onClose} onBack={() => setView(view.from ?? { kind: 'home' })}>
        <article className="help-article">
          {!article ? <p className="hm-muted">Loading…</p> : <>
            <small className="help-article-topic">{HELP_TOPICS[article.category]?.label ?? 'Help'}</small>
            <h3>{article.title}</h3>
            {article.body.split('\n\n').map((paragraph, index) => <p key={index}><FormattedText text={paragraph} /></p>)}
            <p className="help-article-more">Still need help? {contactUs}</p>
          </>}
        </article>
        <Notice error={error} />
      </Panel>
    );
  }

  return (
    <Panel title="Help Center" onClose={onClose} onBack={view.kind === 'topic' ? home : undefined}>
      <div className="help-center">
        {view.kind === 'home' && <>
          <h3 className="help-greeting">How can we help?</h3>
          <label className="help-search">
            <Search size={20} aria-hidden="true" />
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Help Center" aria-label="Search Help Center" />
          </label>
          {results ? (
            <section aria-label="Search results">
              <h4 className="help-heading">{results.length ? 'Articles' : `No articles match “${query.trim()}”`}</h4>
              {results.map(articleRow)}
            </section>
          ) : (
            <section aria-label="Help topics">
              <h4 className="help-heading">Help topics</h4>
              {!help && !error && <p className="hm-muted">Loading…</p>}
              {topics.map((id) => {
                const topic = HELP_TOPICS[id] ?? { label: id, icon: BookOpen };
                const Icon = topic.icon;
                return (
                  <button type="button" key={id} className="help-row help-topic" onClick={() => setView({ kind: 'topic', topic: id })}>
                    <Icon size={22} aria-hidden="true" /><span className="help-row-copy"><strong>{topic.label}</strong></span>
                  </button>
                );
              })}
            </section>
          )}
        </>}
        {view.kind === 'topic' && (
          <section aria-label={HELP_TOPICS[view.topic]?.label}>
            <h3 className="help-greeting">{HELP_TOPICS[view.topic]?.label ?? 'Help'}</h3>
            {inTopic.map(articleRow)}
          </section>
        )}
        <Notice error={error} />
        <div className="help-contact-wrap">{contactUs}</div>
      </div>
    </Panel>
  );
}
