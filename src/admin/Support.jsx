// Support inbox: every person's conversation with the official Hidden Messenger account (server/support.mjs). Pick a
// conversation on the left, read it and answer on the right, with a photo, video or PDF if you like; the answer reaches
// the person's phone at once. A campaign sends one message (and attachment) to every active account: it lands in each
// account's Hidden Messenger chat, pinned first in their chat list. The lists refresh on their own while visible.
import { useCallback, useEffect, useRef, useState } from 'react';
import { FileText, Inbox, Megaphone, Paperclip, RefreshCw, Send, X } from 'lucide-react';
import { adminMediaUrl, adminRequest, adminUpload } from './adminApi.js';

const REFRESH_MS = 8000;
const REPLY_MAX = 2000;
const ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,application/pdf';
const stamp = (ms) => {
  const date = new Date(ms);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString([], { day: 'numeric', month: 'short' });
};
const who = (user) => user?.name || (user?.username ? `@${user.username}` : 'Account');
const kb = (bytes) => `${Math.max(1, Math.round(bytes / 1024)).toLocaleString()} KB`;

function useEvery(load, ms) {
  useEffect(() => {
    load();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, ms);
    return () => clearInterval(timer);
  }, [load, ms]);
}

// An attachment in the console: fetched with the admin header, then shown (photo, video) or offered (PDF).
function Attachment({ media }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let live = true;
    let made = '';
    adminMediaUrl(media.url).then((url) => { made = url; if (live) setSrc(url); else URL.revokeObjectURL(url); }).catch(() => {});
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [media.url]);
  if (!src) return <span className="ad-support-media is-loading">Loading {media.name}…</span>;
  if (media.kind === 'image') return <a className="ad-support-media" href={src} target="_blank" rel="noreferrer"><img src={src} alt={media.name} /></a>;
  if (media.kind === 'video') return <video className="ad-support-media" src={src} controls preload="metadata" />;
  return <a className="ad-support-media ad-support-file" href={src} download={media.name}><FileText size={20} /> {media.name} <small>{kb(media.size)}</small></a>;
}

// The writing box for a reply or a campaign: text, one attachment (uploaded as soon as it is chosen), and Send.
function Composer({ placeholder, sendLabel, busyLabel, onSend, confirm }) {
  const [text, setText] = useState('');
  const [media, setMedia] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef(null);

  async function attach(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setUploading(true);
    setError('');
    try { setMedia(await adminUpload(file)); } catch (caught) { setError(caught.message); } finally { setUploading(false); }
  }

  async function send(event) {
    event.preventDefault();
    const body = text.trim();
    if ((!body && !media) || busy || uploading) return;
    if (confirm && !window.confirm(confirm)) return;
    setBusy(true);
    setError('');
    try {
      await onSend({ body, mediaId: media?.id });
      setText('');
      setMedia(null);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="ad-support-reply" onSubmit={send}>
      {media && (
        <span className="ad-support-attached">
          {media.kind === 'image' ? '📷' : media.kind === 'video' ? '🎥' : '📄'} {media.name} <small>{kb(media.size)}</small>
          <button type="button" onClick={() => setMedia(null)} aria-label="Remove attachment"><X size={14} /></button>
        </span>
      )}
      <div className="ad-support-reply-row">
        <input ref={fileRef} type="file" accept={ACCEPT} hidden onChange={attach} />
        <button type="button" className="ad-btn is-small" onClick={() => fileRef.current?.click()} disabled={uploading || busy} aria-label="Attach a photo, video or PDF" title="Attach a photo, video or PDF">
          <Paperclip size={15} /> {uploading ? 'Uploading…' : 'Attach'}
        </button>
        <textarea value={text} maxLength={REPLY_MAX} rows={2} onChange={(event) => setText(event.target.value)} placeholder={placeholder} aria-label={placeholder}
          onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) send(event); }} />
        <button type="submit" className="ad-btn" disabled={busy || uploading || (!text.trim() && !media)}><Send size={15} /> {busy ? busyLabel : sendLabel}</button>
      </div>
      {error && <p className="admin-gate-error" role="alert">{error}</p>}
    </form>
  );
}

function Campaigns() {
  const [campaigns, setCampaigns] = useState(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(() => adminRequest('/api/admin/v1/support-campaigns').then((data) => setCampaigns(data.campaigns)).catch((caught) => setError(caught.message)), []);
  useEvery(load, REFRESH_MS * 2);

  async function send(message) {
    const result = await adminRequest('/api/admin/v1/support-campaigns', { method: 'POST', body: message });
    setNotice(`Sent to ${result.recipients.toLocaleString()} account${result.recipients === 1 ? '' : 's'}.`);
    await load();
  }

  return (
    <>
      <div className="ad-card-head"><h2><Megaphone size={16} /> New campaign</h2></div>
      <p className="ad-muted">One message to every active account, from the verified Hidden Messenger account. It appears in their Hidden Messenger chat, pinned first in the chat list. Phones with the app open show it at once; the others when they next open the app.</p>
      <Composer placeholder="Write the announcement…" sendLabel="Send to everyone" busyLabel="Sending…" onSend={send}
        confirm="Send this message to every active account? It can’t be taken back." />
      {notice && <p className="ad-support-notice" role="status">{notice}</p>}
      {error && <p className="admin-gate-error" role="alert">{error}</p>}
      <h3 className="ad-support-subhead">Sent campaigns</h3>
      {!campaigns ? <p className="ad-muted">Loading…</p> : campaigns.length === 0 ? <p className="ad-muted">No campaigns yet.</p> : (
        <div className="ad-support-messages">
          {campaigns.map((campaign) => (
            <div key={campaign.id} className="ad-support-bubble is-support">
              {campaign.media && <Attachment media={campaign.media} />}
              {campaign.body}
              <time>{stamp(campaign.createdAt)} · {campaign.recipients.toLocaleString()} sent · {campaign.seen.toLocaleString()} seen</time>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export default function Support({ onChanged }) {
  const [threads, setThreads] = useState(null);
  // A person's id, or 'campaign' for the campaign composer.
  const [openId, setOpenId] = useState('');
  const [conversation, setConversation] = useState(null);
  const [error, setError] = useState('');
  const endRef = useRef(null);
  const personId = openId === 'campaign' ? '' : openId;

  const loadThreads = useCallback(() => adminRequest('/api/admin/v1/support').then((data) => setThreads(data.threads)).catch((caught) => setError(caught.message)), []);
  const loadConversation = useCallback(() => {
    if (!personId) return Promise.resolve();
    return adminRequest(`/api/admin/v1/support/${encodeURIComponent(personId)}`)
      .then((data) => { setConversation(data); onChanged?.(); loadThreads(); })
      .catch((caught) => setError(caught.message));
  }, [personId, onChanged, loadThreads]);
  useEvery(loadThreads, REFRESH_MS);
  useEvery(loadConversation, REFRESH_MS);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [conversation?.messages?.length]);

  async function reply(message) {
    await adminRequest(`/api/admin/v1/support/${encodeURIComponent(personId)}`, { method: 'POST', body: message });
    await Promise.all([loadConversation(), loadThreads()]);
  }

  return (
    <div className="ad-support">
      <section className="ad-card ad-support-list" aria-label="Conversations">
        <button type="button" className={`ad-btn ad-support-campaign${openId === 'campaign' ? ' is-on' : ''}`} onClick={() => { setOpenId('campaign'); setConversation(null); }}>
          <Megaphone size={15} /> Campaign to everyone
        </button>
        <div className="ad-card-head"><h2><Inbox size={16} /> Conversations</h2>
          <button type="button" className="ad-btn is-small" onClick={loadThreads} aria-label="Refresh"><RefreshCw size={14} /></button></div>
        {!threads ? <p className="ad-muted">Loading…</p> : threads.length === 0 ? <p className="ad-muted">No one has written to support yet. People reach you from the app: the pinned Hidden Messenger chat, or Tools › Help Centre › Contact us.</p> : (
          <ul>
            {threads.map((thread) => (
              <li key={thread.user.id}>
                <button type="button" className={`ad-support-thread${openId === thread.user.id ? ' is-on' : ''}`} onClick={() => { setOpenId(thread.user.id); setConversation(null); }}>
                  <span className="ad-support-top"><strong>{who(thread.user)}</strong><time>{stamp(thread.lastAt)}</time></span>
                  <span className="ad-support-bottom">
                    <small>{thread.last.fromSupport ? 'You: ' : ''}{thread.last.body}</small>
                    {thread.unread > 0 && <span className="ad-count is-alert">{thread.unread}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="ad-card ad-support-chat" aria-label={openId === 'campaign' ? 'Campaign' : 'Conversation'}>
        {openId === 'campaign' ? <Campaigns /> : !openId ? <p className="ad-muted">Choose a conversation to read and answer it, or send a campaign to everyone.</p> : !conversation ? <p className="ad-muted">Loading…</p> : (
          <>
            <div className="ad-card-head"><h2>{who(conversation.user)}{conversation.user.username && <small className="ad-muted"> @{conversation.user.username}</small>}</h2></div>
            <div className="ad-support-messages">
              {conversation.messages.map((message) => (
                <div key={message.id} className={`ad-support-bubble${message.fromSupport ? ' is-support' : ''}`}>
                  {message.campaign && <small className="ad-support-tag"><Megaphone size={12} /> Campaign</small>}
                  {message.media && <Attachment media={message.media} />}
                  {message.body}
                  <time>{stamp(message.createdAt)}{message.fromSupport && (message.readByUser ? ' · Seen' : ' · Sent')}</time>
                </div>
              ))}
              <span ref={endRef} />
            </div>
            <Composer key={personId} placeholder="Write a reply…" sendLabel="Send" busyLabel="Sending…" onSend={reply} />
          </>
        )}
        {error && <p className="admin-gate-error" role="alert">{error}</p>}
      </section>
    </div>
  );
}
