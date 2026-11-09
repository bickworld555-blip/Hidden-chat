import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Check, Search, Send, Users } from 'lucide-react';
import Avatar from './Avatar.jsx';
import { apiFetch } from '../api.js';
import { uploadFile } from '../upload.js';
import { useChatStore } from '../store.js';
import { nativeReadSharedFile } from '../native.js';
import { SHARE_TARGET_LIMIT, shareSteps, shareSummary } from '../shareTarget.js';
import { useBackHandler } from '../backStack.js';

async function postToGroup(token, groupId, content) {
  const response = await apiFetch(`/api/v1/groups/${encodeURIComponent(groupId)}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `The group message could not be sent (${response.status}).`);
  }
}

// "Send to…" for something shared from another app (Android share sheet): pick up to five chats and groups, and
// every shared file and the link or text is sent to each of them, like WhatsApp.
export default function ShareSheet({ share, groups = [], userId, sessionToken, onDone, onClose }) {
  const chats = useChatStore((state) => state.chats);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState([]);
  const [notice, setNotice] = useState('');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const busy = Boolean(progress);
  useBackHandler(true, () => { if (!busy) onClose(); });
  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(''), 2500);
    return () => clearTimeout(timer);
  }, [notice]);

  const sections = useMemo(() => {
    const needle = query.trim().replace(/^@+/, '').toLowerCase();
    const matches = (text) => !needle || text.toLowerCase().includes(needle);
    const people = chats
      .filter((chat) => chat?.id && chat.id !== userId && matches(`${chat.name ?? ''} ${chat.username ?? ''}`))
      .map((chat) => ({ ...chat, kind: 'chat' }));
    const groupRows = groups.filter((group) => group?.id && matches(group.name ?? '')).map((group) => ({ ...group, kind: 'group' }));
    return [
      { id: 'chats', title: 'Recent chats', items: people },
      { id: 'groups', title: 'Groups', items: groupRows },
    ].filter((section) => section.items.length > 0);
  }, [chats, groups, query, userId]);

  const key = (item) => `${item.kind}:${item.id}`;
  const selectedKeys = new Set(selected.map(key));

  function toggle(item) {
    if (busy) return;
    if (selectedKeys.has(key(item))) setSelected((current) => current.filter((entry) => key(entry) !== key(item)));
    else if (selected.length >= SHARE_TARGET_LIMIT) setNotice(`You can only share with up to ${SHARE_TARGET_LIMIT} chats`);
    else setSelected((current) => [...current, item]);
  }

  async function send() {
    if (busy || selected.length === 0) return;
    setError('');
    const steps = shareSteps(share);
    const files = new Map();
    const total = selected.length * steps.length;
    let done = 0;
    try {
      for (const target of selected) {
        for (const step of steps) {
          setProgress(total > 1 ? `Sending ${done + 1} of ${total}…` : 'Sending…');
          let content = step.text;
          if (step.kind === 'file') {
            // Read once from Android, then uploaded to each chat (attachments belong to their conversation).
            if (!files.has(step.file.index)) files.set(step.file.index, await nativeReadSharedFile(step.file));
            const file = files.get(step.file.index);
            const data = await uploadFile(file, target.kind === 'group' ? { groupId: target.id, sessionToken } : { receiverId: target.id, sessionToken });
            content = `media:${data.id}:${data.filename || file.name}`;
          }
          if (target.kind === 'group') await postToGroup(sessionToken, target.id, content);
          else if (!useChatStore.getState().sendMessage(target.id, content)) throw new Error('Sign in again to send messages.');
          done += 1;
        }
      }
      onDone(selected);
    } catch (caught) {
      setError(caught?.message || 'Sharing failed. Try again.');
    } finally {
      setProgress('');
    }
  }

  return (
    <div className="modal-overlay wa-forward-overlay" onClick={busy ? undefined : onClose}>
      <div className="wa-forward-sheet" role="dialog" aria-modal="true" aria-label="Send to" onClick={(event) => event.stopPropagation()}>
        <header className="wa-forward-header">
          {searching ? (
            <>
              <button type="button" className="wa-forward-icon" onClick={() => { setSearching(false); setQuery(''); }} aria-label="Close search"><ArrowLeft size={20} /></button>
              <input autoFocus className="wa-forward-search-input" type="search" placeholder="Search…" aria-label="Search chats and groups" value={query} onChange={(event) => setQuery(event.target.value)} />
            </>
          ) : (
            <>
              <button type="button" className="wa-forward-icon" onClick={onClose} disabled={busy} aria-label="Cancel sharing"><ArrowLeft size={20} /></button>
              <div className="wa-forward-title">
                <strong>Send to…</strong>
                <small>{selected.length > 0 ? `${selected.length} of ${SHARE_TARGET_LIMIT} selected` : shareSummary(share)}</small>
              </div>
              <button type="button" className="wa-forward-icon" onClick={() => setSearching(true)} aria-label="Search"><Search size={20} /></button>
            </>
          )}
        </header>
        <p className="wa-share-preview">{shareSummary(share)}</p>
        <div className="wa-forward-list">
          {sections.length === 0 && <p className="wa-forward-empty">{query ? `No results for “${query.trim()}”` : 'No chats yet'}</p>}
          {sections.map((section) => (
            <section key={section.id} className="wa-forward-section" aria-label={section.title}>
              <h4>{section.title}</h4>
              {section.items.map((item) => {
                const checked = selectedKeys.has(key(item));
                const handle = item.kind === 'chat' && item.username ? `@${item.username}` : '';
                return (
                  <button type="button" key={key(item)} role="checkbox" aria-checked={checked} className={`wa-forward-row ${checked ? 'checked' : ''}`} onClick={() => toggle(item)}>
                    <span className="wa-forward-avatar">
                      {item.kind === 'group'
                        ? <span className="avatar wa-share-group-avatar"><Users size={20} /></span>
                        : <Avatar name={item.name} initials={item.initials ?? item.name?.slice(0, 2)?.toUpperCase() ?? '?'} color={item.color} image={item.avatar} />}
                      {checked && <span className="wa-forward-check"><Check size={12} strokeWidth={3} /></span>}
                    </span>
                    <span className="wa-forward-text">
                      <strong>{item.name ?? handle}</strong>
                      {handle && handle !== item.name && <small>{handle}</small>}
                    </span>
                  </button>
                );
              })}
            </section>
          ))}
        </div>
        {(notice || error || progress) && <div className="wa-forward-notice" role="status">{progress || error || notice}</div>}
        {selected.length > 0 && (
          <footer className="wa-forward-footer">
            <span className="wa-forward-names">{selected.map((item) => item.name ?? item.username).join(', ')}</span>
            <button type="button" className="wa-forward-send" onClick={send} disabled={busy} aria-label={`Send to ${selected.length} chat${selected.length === 1 ? '' : 's'}`}>
              <Send size={20} />
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}
