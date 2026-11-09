import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Check, CircleDashed, Search, Send, Users } from 'lucide-react';
import Avatar from './Avatar.jsx';
import { apiFetch } from '../api.js';
import { uploadFile } from '../upload.js';
import { useChatStore } from '../store.js';
import { nativeReadSharedFile } from '../native.js';
import { SHARE_TARGET_LIMIT, shareSections, shareSteps, shareSummary } from '../shareTarget.js';
import { STATUS_BACKGROUNDS, postMediaStatus, postTextStatus } from '../statusApi.js';
import { presentName } from '../profile.js';
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

const MY_STATUS = { kind: 'status', id: 'me' };

// "Send to…" for something shared from another app (Android share sheet), laid out like WhatsApp's: "My status"
// first, then "Frequently contacted", "Recent chats", "Groups" and "Other contacts". Up to five chats (plus your
// status) get every shared file and the link or text.
export default function ShareSheet({ share, groups = [], userId, sessionToken, onDone, onClose }) {
  const chats = useChatStore((state) => state.chats);
  const messages = useChatStore((state) => state.messages);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  // Shared to one of our Android share-sheet shortcuts: that chat starts out chosen.
  const [selected, setSelected] = useState(() => {
    const target = share?.target;
    if (!target) return [];
    const source = target.kind === 'group' ? groups : useChatStore.getState().chats;
    const match = source.find((item) => item?.id === target.id);
    return match ? [{ ...match, kind: target.kind }] : [];
  });
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

  const sections = useMemo(() => shareSections({ chats, groups, messages, userId, query }), [chats, groups, messages, userId, query]);
  const key = (item) => `${item.kind}:${item.id}`;
  const selectedKeys = new Set(selected.map(key));
  const chatCount = selected.filter((item) => item.kind !== 'status').length;
  const statusAllowed = share.files.every((file) => /^(image|video)\//.test(file.mimeType)) || share.files.length === 0;

  function toggle(item) {
    if (busy) return;
    if (selectedKeys.has(key(item))) setSelected((current) => current.filter((entry) => key(entry) !== key(item)));
    else if (item.kind !== 'status' && chatCount >= SHARE_TARGET_LIMIT) setNotice(`You can only share with up to ${SHARE_TARGET_LIMIT} chats`);
    else setSelected((current) => [...current, item]);
  }

  async function send(targets = selected) {
    if (busy || targets.length === 0) return;
    setError('');
    const steps = shareSteps(share);
    const files = new Map();
    const readShared = async (file) => {
      if (!files.has(file.index)) files.set(file.index, await nativeReadSharedFile(file));
      return files.get(file.index);
    };
    const total = targets.length * steps.length;
    let done = 0;
    try {
      for (const target of targets) {
        for (const step of steps) {
          setProgress(total > 1 ? `Sending ${done + 1} of ${total}…` : 'Sending…');
          if (target.kind === 'status') {
            // Your status: photos and videos as media statuses, a link or text as a coloured text status.
            if (step.kind === 'file') await postMediaStatus(sessionToken, userId, await readShared(step.file));
            else await postTextStatus(sessionToken, step.text.slice(0, 700), STATUS_BACKGROUNDS[Math.floor(Math.random() * STATUS_BACKGROUNDS.length)]);
            done += 1;
            continue;
          }
          let content = step.text;
          if (step.kind === 'file') {
            // Read once from Android, then uploaded to each chat (attachments belong to their conversation).
            const file = await readShared(step.file);
            const data = await uploadFile(file, target.kind === 'group' ? { groupId: target.id, sessionToken } : { receiverId: target.id, sessionToken });
            content = `media:${data.id}:${data.filename || file.name}`;
          }
          if (target.kind === 'group') await postToGroup(sessionToken, target.id, content);
          else if (!useChatStore.getState().sendMessage(target.id, content)) throw new Error('Sign in again to send messages.');
          done += 1;
        }
      }
      onDone(targets.filter((target) => target.kind !== 'status'));
    } catch (caught) {
      setError(caught?.message || 'Sharing failed. Try again.');
    } finally {
      setProgress('');
    }
  }

  const row = (item, { title, subtitle, avatar }) => {
    const checked = selectedKeys.has(key(item));
    return (
      <button type="button" key={key(item)} role="checkbox" aria-checked={checked} className={`wa-share-row ${checked ? 'checked' : ''}`} onClick={() => toggle(item)}>
        <span className="wa-share-avatar">{avatar}</span>
        <span className="wa-forward-text"><strong>{title}</strong>{subtitle && <small>{subtitle}</small>}</span>
        <span className="wa-share-circle" aria-hidden="true">{checked && <Check size={14} strokeWidth={3} />}</span>
      </button>
    );
  };

  return (
    <div className="modal-overlay wa-forward-overlay" onClick={busy ? undefined : onClose}>
      <div className="wa-forward-sheet wa-share-sheet" role="dialog" aria-modal="true" aria-label="Send to" onClick={(event) => event.stopPropagation()}>
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
                {selected.length > 0 && <small>{chatCount} of {SHARE_TARGET_LIMIT} selected</small>}
              </div>
              <button type="button" className="wa-forward-icon" onClick={() => setSearching(true)} aria-label="Search"><Search size={20} /></button>
            </>
          )}
        </header>
        <p className="wa-share-preview">{shareSummary(share)}</p>
        <div className="wa-forward-list">
          {!query && statusAllowed && row(MY_STATUS, {
            title: 'My status',
            subtitle: 'My contacts',
            avatar: <span className="avatar wa-share-status-avatar"><CircleDashed size={26} /></span>,
          })}
          {sections.length === 0 && <p className="wa-forward-empty">{query ? `No results for “${query.trim()}”` : 'No chats yet'}</p>}
          {sections.map((section) => (
            <section key={section.id} className="wa-forward-section" aria-label={section.title}>
              <h4>{section.title}</h4>
              {section.items.map((item) => row(item, {
                title: item.kind === 'group' ? item.name : presentName(item),
                subtitle: item.kind === 'chat' && item.username && presentName(item) !== `@${item.username}` ? `@${item.username}` : '',
                avatar: item.kind === 'group'
                  ? <span className="avatar wa-share-group-avatar"><Users size={22} /></span>
                  : <Avatar name={item.name} initials={item.initials ?? item.name?.slice(0, 2)?.toUpperCase() ?? '?'} color={item.color} image={item.avatar} />,
              }))}
            </section>
          ))}
        </div>
        {(notice || error || progress) && <div className="wa-forward-notice" role="status">{progress || error || notice}</div>}
        {selected.length > 0 && (
          <footer className="wa-forward-footer">
            <span className="wa-forward-names">{selected.map((item) => (item.kind === 'status' ? 'My status' : item.kind === 'group' ? item.name : presentName(item))).join(', ')}</span>
            <button type="button" className="wa-forward-send" onClick={() => send()} disabled={busy} aria-label={`Send to ${selected.length} chat${selected.length === 1 ? '' : 's'}`}>
              <Send size={20} />
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}
