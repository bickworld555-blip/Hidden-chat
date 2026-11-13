// Support inbox: every person's conversation with Hidden Messenger Support (server/support.mjs). Pick a conversation
// on the left, read it and answer on the right; the answer reaches the person's phone at once. Both lists refresh on
// their own while the page is visible.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Inbox, RefreshCw, Send } from 'lucide-react';
import { adminRequest } from './adminApi.js';

const REFRESH_MS = 8000;
const REPLY_MAX = 2000;
const stamp = (ms) => {
  const date = new Date(ms);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString([], { day: 'numeric', month: 'short' });
};
const who = (user) => user?.name || (user?.username ? `@${user.username}` : 'Account');

function useEvery(load, ms) {
  useEffect(() => {
    load();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, ms);
    return () => clearInterval(timer);
  }, [load, ms]);
}

export default function Support({ onChanged }) {
  const [threads, setThreads] = useState(null);
  const [openId, setOpenId] = useState('');
  const [conversation, setConversation] = useState(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const endRef = useRef(null);

  const loadThreads = useCallback(() => adminRequest('/api/admin/v1/support').then((data) => setThreads(data.threads)).catch((caught) => setError(caught.message)), []);
  const loadConversation = useCallback(() => {
    if (!openId) return Promise.resolve();
    return adminRequest(`/api/admin/v1/support/${encodeURIComponent(openId)}`)
      .then((data) => { setConversation(data); onChanged?.(); loadThreads(); })
      .catch((caught) => setError(caught.message));
  }, [openId, onChanged, loadThreads]);
  useEvery(loadThreads, REFRESH_MS);
  useEvery(loadConversation, REFRESH_MS);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [conversation?.messages?.length]);

  async function send(event) {
    event.preventDefault();
    const body = reply.trim();
    if (!body || !openId) return;
    setBusy(true);
    setError('');
    try {
      await adminRequest(`/api/admin/v1/support/${encodeURIComponent(openId)}`, { method: 'POST', body: { body } });
      setReply('');
      await Promise.all([loadConversation(), loadThreads()]);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ad-support">
      <section className="ad-card ad-support-list" aria-label="Conversations">
        <div className="ad-card-head"><h2><Inbox size={16} /> Conversations</h2>
          <button type="button" className="ad-btn is-small" onClick={loadThreads} aria-label="Refresh"><RefreshCw size={14} /></button></div>
        {!threads ? <p className="ad-muted">Loading…</p> : threads.length === 0 ? <p className="ad-muted">No one has written to support yet. People reach you from the app: Tools › Help Centre › Contact us.</p> : (
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
      <section className="ad-card ad-support-chat" aria-label="Conversation">
        {!openId ? <p className="ad-muted">Choose a conversation to read and answer it.</p> : !conversation ? <p className="ad-muted">Loading…</p> : (
          <>
            <div className="ad-card-head"><h2>{who(conversation.user)}{conversation.user.username && <small className="ad-muted"> @{conversation.user.username}</small>}</h2></div>
            <div className="ad-support-messages">
              {conversation.messages.map((message) => (
                <p key={message.id} className={`ad-support-bubble${message.fromSupport ? ' is-support' : ''}`}>
                  {message.body}<time>{stamp(message.createdAt)}{message.fromSupport && (message.readByUser ? ' · Seen' : ' · Sent')}</time>
                </p>
              ))}
              <span ref={endRef} />
            </div>
            <form className="ad-support-reply" onSubmit={send}>
              <textarea value={reply} maxLength={REPLY_MAX} rows={2} onChange={(event) => setReply(event.target.value)} placeholder="Write a reply…" aria-label="Reply"
                onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) send(event); }} />
              <button type="submit" className="ad-btn" disabled={busy || !reply.trim()}><Send size={15} /> {busy ? 'Sending…' : 'Send'}</button>
            </form>
          </>
        )}
        {error && <p className="admin-gate-error" role="alert">{error}</p>}
      </section>
    </div>
  );
}
