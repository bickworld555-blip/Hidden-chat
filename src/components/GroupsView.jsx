import { apiFetch } from '../api.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Flag, Paperclip, Phone, Settings, Users, Video, X } from 'lucide-react';
import { searchPeople } from '../contactsApi.js';
import { uploadFile } from '../upload.js';
import { MAX_CALL_PARTICIPANTS } from '../callRoom.js';
import { groupPreviewText, unreadBadge } from '../groupRows.js';
import Avatar from './Avatar.jsx';
import MediaRenderer from './MediaRenderer.jsx';

const DELETE_WINDOW_MS = 24 * 60 * 60 * 1000;

async function groupRequest(token, path, { method = 'GET', body, signal } = {}) {
  const response = await apiFetch(`/api/v1/groups${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${response.status}).`);
  }
  return response.status === 204 ? null : response.json();
}

function formatWhen(timestamp) {
  const date = new Date(timestamp);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Picks up to MAX_CALL_PARTICIPANTS - 1 other members for a group call; everyone is preselected when they all fit.
function CallPeoplePicker({ members, userId, mode, busy, onStart, onClose }) {
  const others = members.filter((member) => member.id !== userId);
  const limit = MAX_CALL_PARTICIPANTS - 1;
  const [picked, setPicked] = useState(() => others.slice(0, limit).map((member) => member.id));
  const [filter, setFilter] = useState('');
  const visible = others.filter((member) => `${member.name} ${member.username}`.toLowerCase().includes(filter.trim().toLowerCase()));
  const toggle = (id) => setPicked((current) => current.includes(id) ? current.filter((item) => item !== id) : current.length < limit ? [...current, id] : current);
  return (
    <div className="groups-sheet" role="dialog" aria-modal="true" aria-label="Select people">
      <header>
        <strong>Select people · {mode === 'video' ? 'Video call' : 'Voice call'}</strong>
        <button type="button" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </header>
      <p>Up to {limit} other people can join one call. {picked.length}/{limit} selected.</p>
      <label>Search members<input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Search name or username" /></label>
      <ul>
        {visible.map((member) => (
          <li key={member.id}>
            <label className="groups-pick">
              <input type="checkbox" checked={picked.includes(member.id)} disabled={!picked.includes(member.id) && picked.length >= limit} onChange={() => toggle(member.id)} />
              <Avatar {...member} size="small" />
              <span><strong>{member.name}</strong><small>@{member.username}</small></span>
            </label>
          </li>
        ))}
      </ul>
      <button type="button" className="groups-primary" disabled={busy || picked.length === 0} onClick={() => onStart(mode, picked)}>
        {mode === 'video' ? <Video size={16} /> : <Phone size={16} />} Start call with {picked.length} {picked.length === 1 ? 'person' : 'people'}
      </button>
    </div>
  );
}

export default function GroupsView({ token, userId, revision, onClose, onStartGroupCall, initialCreate = false, initialGroupId = '' }) {
  const [groups, setGroups] = useState([]);
  const [selected, setSelected] = useState(initialCreate ? '' : initialGroupId);
  const [group, setGroup] = useState(null);
  const [messages, setMessages] = useState([]);
  const [creating, setCreating] = useState(initialCreate);
  const [settings, setSettings] = useState(false);
  const [infoTab, setInfoTab] = useState('members');
  const [memberFilter, setMemberFilter] = useState('');
  const [confirming, setConfirming] = useState('');
  const [reportReason, setReportReason] = useState('');
  const [callMenu, setCallMenu] = useState(false);
  const [callPicker, setCallPicker] = useState('');
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [picked, setPicked] = useState([]);
  const [draft, setDraft] = useState('');
  const [uploading, setUploading] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const fileInputRef = useRef(null);
  const listRef = useRef(null);
  const lastReadRef = useRef({ groupId: '', at: 0 });
  const groupPath = selected ? `/${encodeURIComponent(selected)}` : '';

  const refresh = useCallback(async (signal) => {
    const list = await groupRequest(token, '', { signal });
    if (signal.aborted) return;
    if (selected && !list.some((item) => item.id === selected)) {
      setGroups(list);
      setSelected('');
      setGroup(null);
      setMessages([]);
      setSettings(false);
      setConfirming('');
      return;
    }
    const [details, history] = selected
      ? await Promise.all([groupRequest(token, groupPath, { signal }), groupRequest(token, `${groupPath}/messages`, { signal })])
      : [null, []];
    if (signal.aborted) return;
    setGroups(list);
    setGroup(details);
    setMessages(history);
  }, [token, selected, groupPath]);

  useEffect(() => {
    const controller = new AbortController();
    refresh(controller.signal).catch((caught) => { if (caught.name !== 'AbortError') setError(caught.message); });
    return () => controller.abort();
  }, [refresh, revision]);

  // Viewing the conversation marks it read; the list's badge comes from the server so other devices agree.
  useEffect(() => {
    if (!selected || settings || creating || !messages.length) return;
    const latest = messages[messages.length - 1];
    if (latest.senderId === userId) return;
    const mark = lastReadRef.current;
    if (mark.groupId === selected && mark.at >= latest.createdAt) return;
    lastReadRef.current = { groupId: selected, at: latest.createdAt };
    groupRequest(token, `${groupPath}/read`, { method: 'PUT' })
      .then(() => setGroups((current) => current.map((item) => (item.id === selected ? { ...item, unread: 0 } : item))))
      .catch(() => {});
  }, [messages, selected, settings, creating, token, groupPath, userId]);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages.length, selected]);

  useEffect(() => {
    if (!query.trim() || (!creating && !settings)) { setResults([]); return undefined; }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchPeople(token, query.trim(), { signal: controller.signal })
        .then((people) => setResults(people.filter((person) => person.id !== userId)))
        .catch((caught) => { if (caught.name !== 'AbortError') setError(caught.message); });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, creating, settings, token, userId]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  async function perform(action) {
    setBusy(true);
    setError('');
    try {
      await action();
      await refresh(new AbortController().signal);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  }

  async function sendAttachment(file) {
    if (!file || !selected) return;
    setError('');
    setUploading(1);
    try {
      const data = await uploadFile(file, { groupId: selected, sessionToken: token, onProgress: (done, total) => setUploading(Math.max(1, Math.round((done / total) * 100))) });
      await groupRequest(token, `${groupPath}/messages`, { method: 'POST', body: { content: `media:${data.id}:${data.filename || file.name || 'attachment'}` } });
      await refresh(new AbortController().signal);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setUploading(0);
    }
  }

  function goBack() {
    if (settings) { setSettings(false); setQuery(''); setMemberFilter(''); setConfirming(''); setReportReason(''); }
    else if (creating) { setCreating(false); setQuery(''); setPicked([]); }
    else if (selected) { setSelected(''); setGroup(null); setMessages([]); setCallMenu(false); setCallPicker(''); }
    else onClose();
    setError('');
  }

  const toggleAutoDelete = (autoDelete) => {
    const previous = group.autoDelete;
    setGroup((current) => ({ ...current, autoDelete }));
    perform(async () => {
      try {
        await groupRequest(token, `${groupPath}/member-settings`, { method: 'PUT', body: { autoDelete } });
      } catch (caught) {
        setGroup((current) => current && ({ ...current, autoDelete: previous }));
        throw caught;
      }
    });
  };

  const startCall = (mode, memberIds) => {
    setCallPicker('');
    setCallMenu(false);
    const chosen = group.members.filter((member) => memberIds.includes(member.id));
    onStartGroupCall?.({ mode, members: chosen, groupName: group.name });
    onClose();
  };

  return (
    <div className="groups-overlay" role="dialog" aria-modal="true" aria-label="Groups">
      <div className="groups-panel">
        <header className="groups-header">
          <button type="button" onClick={goBack} aria-label="Back"><ArrowLeft size={20} /></button>
          {group && !settings && !creating ? (
            <button type="button" className="groups-title" onClick={() => setSettings(true)} aria-label="Open group info">
              <h2>{group.name}</h2>
              <small>{group.members.map((member) => (member.id === userId ? 'You' : member.name)).join(', ')}</small>
            </button>
          ) : <h2>{creating ? 'Create a group' : settings ? 'Group info' : 'Groups'}</h2>}
          {group && !settings && !creating && onStartGroupCall && (
            <span className="groups-call-menu-wrap">
              <button type="button" onClick={() => setCallMenu((open) => !open)} aria-label="Call options" aria-expanded={callMenu} aria-haspopup="menu"><Video size={20} /></button>
              {callMenu && (
                <ul className="groups-call-menu" role="menu" aria-label="Call options">
                  <li><button type="button" role="menuitem" onClick={() => { setCallMenu(false); setCallPicker('audio'); }}><Phone size={18} /> Voice call</button></li>
                  <li><button type="button" role="menuitem" onClick={() => { setCallMenu(false); setCallPicker('video'); }}><Video size={18} /> Video call</button></li>
                  <li><button type="button" role="menuitem" onClick={() => { setCallMenu(false); setCallPicker('audio'); }}><Users size={18} /> Select people</button></li>
                </ul>
              )}
            </span>
          )}
          {group && !settings && !creating && <button type="button" onClick={() => setSettings(true)} aria-label="Group settings"><Settings size={20} /></button>}
          <button type="button" onClick={onClose} aria-label="Close groups"><X size={20} /></button>
        </header>
        {error && <p className="groups-error" role="alert">{error}</p>}
        {!error && notice && <p className="groups-notice" role="status">{notice}</p>}

        {!selected && !creating && (
          <div className="groups-content">
            <button type="button" className="groups-primary" onClick={() => { setCreating(true); setName(''); setPicked([]); }}>Create a group</button>
            {groups.length === 0 && <p>No groups yet.</p>}
            {groups.map((item) => (
              <button type="button" className="groups-row groups-list-row" key={item.id} onClick={() => setSelected(item.id)}>
                <span className="groups-list-icon"><Users size={22} /></span>
                <span className="groups-list-copy">
                  <strong>{item.name}</strong>
                  <small>{groupPreviewText(item, userId)}</small>
                </span>
                <span className="groups-list-meta">
                  {item.lastMessageAt && <time className={item.unread ? 'is-unread' : ''} dateTime={new Date(item.lastMessageAt).toISOString()}>{formatWhen(item.lastMessageAt)}</time>}
                  {item.unread > 0 && <span className="groups-unread" aria-label={`${item.unread} unread`}>{unreadBadge(item.unread)}</span>}
                </span>
              </button>
            ))}
          </div>
        )}

        {creating && (
          <div className="groups-content">
            <label>Group name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} /></label>
            <label>Find members by username<input value={query} onChange={(event) => setQuery(event.target.value)} /></label>
            {picked.map((person) => <button type="button" className="groups-row" key={person.id} onClick={() => setPicked((current) => current.filter((item) => item.id !== person.id))}>Remove @{person.username}</button>)}
            {results.filter((person) => !picked.some((item) => item.id === person.id)).map((person) => <button type="button" className="groups-row" key={person.id} onClick={() => { setPicked((current) => [...current, person]); setQuery(''); }}>Add @{person.username}</button>)}
            <button type="button" className="groups-primary" disabled={busy || !name.trim()} onClick={() => perform(async () => {
              const created = await groupRequest(token, '', { method: 'POST', body: { name, memberIds: picked.map((person) => person.id) } });
              setCreating(false); setSelected(created.id); setQuery(''); setPicked([]);
            })}>Create group</button>
          </div>
        )}

        {group && settings && !creating && (
          <div className="groups-content">
            <div className="groups-info-summary"><span className="groups-info-icon"><Users size={36} /></span><h3>{group.name}</h3><small>Group · {group.members.length} members</small></div>
            <div className="groups-tabs" role="tablist" aria-label="Group information">
              <button type="button" role="tab" aria-selected={infoTab === 'members'} onClick={() => { setInfoTab('members'); setQuery(''); }}>Members</button>
              <button type="button" role="tab" aria-selected={infoTab === 'media'} onClick={() => { setInfoTab('media'); setQuery(''); }}>Media</button>
              <button type="button" role="tab" aria-selected={infoTab === 'settings'} onClick={() => { setInfoTab('settings'); setQuery(''); }}>Settings</button>
            </div>
            {infoTab === 'members' && <>
              <label>Search members<input value={memberFilter} onChange={(event) => setMemberFilter(event.target.value)} placeholder="Search name or username" /></label>
              {group.members.filter((member) => `${member.name} ${member.username}`.toLowerCase().includes(memberFilter.trim().toLowerCase())).map((member) => (
                <div className="groups-row groups-member" key={member.id}>
                  <Avatar {...member} size="small" />
                  <span><strong>{member.id === userId ? 'You' : member.name}</strong><small>@{member.username}</small></span>
                  {member.role === 'admin' && <span className="groups-admin-tag">Group Admin</span>}
                </div>
              ))}
              {group.role === 'admin' && <>
                <label>Add a member<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search username" /></label>
                {results.filter((person) => !group.members.some((item) => item.id === person.id)).map((person) => <button type="button" className="groups-row" key={person.id} disabled={busy} onClick={() => perform(async () => { await groupRequest(token, `${groupPath}/members`, { method: 'POST', body: { userId: person.id } }); setQuery(''); })}>Add @{person.username}</button>)}
              </>}
            </>}
            {infoTab === 'media' && (
              <div className="groups-media-grid">
                {messages.filter((message) => message.content.startsWith('media:')).length === 0 && <p>No attachments in this group yet.</p>}
                {messages.filter((message) => message.content.startsWith('media:')).map((message) => (
                  <div className="groups-media-tile" key={message.id}><MediaRenderer mediaRef={message.content} sessionToken={token} /></div>
                ))}
              </div>
            )}
            {infoTab === 'settings' && <>
              <h3>Member settings</h3>
              <label className="groups-toggle">
                <span>Auto-Delete (24 Hours)<small>Applies to your future messages in this group.</small></span>
                <input type="checkbox" checked={group.autoDelete} disabled={busy} onChange={(event) => toggleAutoDelete(event.target.checked)} />
              </label>
              <p className="groups-privacy">Messages are stored on the server and are not end-to-end encrypted.</p>
              <h3>Actions</h3>
              {confirming === 'clear' ? (
                <div className="groups-confirm" role="group" aria-label="Confirm clearing chat">
                  <p>Clear this chat from your view? Other members keep their copies.</p>
                  <button type="button" disabled={busy} onClick={() => setConfirming('')}>Cancel</button>
                  <button type="button" className="groups-danger" disabled={busy} onClick={() => perform(async () => { await groupRequest(token, `${groupPath}/clear`, { method: 'POST', body: {} }); setConfirming(''); setNotice('Chat cleared for you.'); })}>Clear for me</button>
                  {group.role === 'admin' && <button type="button" className="groups-danger" disabled={busy} onClick={() => perform(async () => { await groupRequest(token, `${groupPath}/clear`, { method: 'POST', body: { everyone: true } }); setConfirming(''); setNotice('Chat cleared for everyone.'); })}>Clear for everyone</button>}
                </div>
              ) : <button type="button" className="groups-row groups-danger" onClick={() => setConfirming('clear')}>Clear chat</button>}
              {confirming === 'report' ? (
                <form className="groups-confirm" aria-label="Report group" onSubmit={(event) => { event.preventDefault(); perform(async () => { await groupRequest(token, `${groupPath}/report`, { method: 'POST', body: { reason: reportReason } }); setConfirming(''); setReportReason(''); setNotice('Report sent. Thank you.'); }); }}>
                  <label>Why are you reporting this group?<textarea value={reportReason} maxLength={500} rows={3} onChange={(event) => setReportReason(event.target.value)} /></label>
                  <button type="button" disabled={busy} onClick={() => { setConfirming(''); setReportReason(''); }}>Cancel</button>
                  <button type="submit" className="groups-danger" disabled={busy || !reportReason.trim()}>Send report</button>
                </form>
              ) : <button type="button" className="groups-row groups-danger" onClick={() => setConfirming('report')}><Flag size={16} /> Report group</button>}
              {group.role === 'member' ? (
                confirming === 'leave' ? (
                  <div className="groups-confirm" role="group" aria-label="Confirm leaving group">
                    <p>Leave this group? You will lose access to its messages.</p>
                    <button type="button" disabled={busy} onClick={() => setConfirming('')}>Cancel</button>
                    <button type="button" className="groups-danger" disabled={busy} onClick={() => perform(() => groupRequest(token, `${groupPath}/membership`, { method: 'DELETE' }))}>Confirm leave group</button>
                  </div>
                ) : <button type="button" className="groups-row groups-danger" onClick={() => setConfirming('leave')}>Leave group</button>
              ) : <p className="groups-privacy">Admins cannot leave until admin transfer is supported.</p>}
            </>}
          </div>
        )}

        {group && !settings && !creating && (
          <>
            <div className="groups-messages" aria-label="Group messages" ref={listRef}>
              {messages.length === 0 && <p>No messages yet.</p>}
              {messages.map((message) => {
                const mine = message.senderId === userId;
                const sender = group.members.find((member) => member.id === message.senderId);
                const canDelete = group.role === 'admin' || (mine && Date.now() - message.createdAt < DELETE_WINDOW_MS);
                const isMedia = message.content.startsWith('media:');
                return (
                  <article className={`groups-message ${mine ? 'mine' : 'theirs'} ${isMedia ? 'has-media' : ''}`} key={message.id}>
                    {!mine && <strong className="groups-sender">{sender?.name || 'Former member'}</strong>}
                    {isMedia ? <MediaRenderer mediaRef={message.content} sessionToken={token} /> : <p>{message.content}</p>}
                    <span className="groups-message-meta">
                      <small>{formatWhen(message.createdAt)}{message.expiresAt ? ' · 24h' : ''}</small>
                      {canDelete && <button type="button" disabled={busy} onClick={() => perform(() => groupRequest(token, `${groupPath}/messages/${encodeURIComponent(message.id)}`, { method: 'DELETE' }))}>Delete</button>}
                    </span>
                  </article>
                );
              })}
            </div>
            <form className="groups-compose" onSubmit={(event) => { event.preventDefault(); if (draft.trim()) perform(async () => { await groupRequest(token, `${groupPath}/messages`, { method: 'POST', body: { content: draft } }); setDraft(''); }); }}>
              <input ref={fileInputRef} type="file" hidden onChange={(event) => { const [file] = event.target.files ?? []; event.target.value = ''; sendAttachment(file); }} />
              <button type="button" className="groups-attach" onClick={() => fileInputRef.current?.click()} disabled={busy || uploading > 0} aria-label="Attach a file" title="Attach a photo, video or file">
                <Paperclip size={20} />
              </button>
              <input aria-label="Group message" value={draft} maxLength={10000} onChange={(event) => setDraft(event.target.value)} placeholder={uploading ? `Uploading… ${uploading}%` : 'Type a message'} disabled={uploading > 0} />
              <button type="submit" disabled={busy || uploading > 0 || !draft.trim()}>Send</button>
            </form>
            {callPicker && <CallPeoplePicker members={group.members} userId={userId} mode={callPicker} busy={busy} onStart={startCall} onClose={() => setCallPicker('')} />}
          </>
        )}
      </div>
    </div>
  );
}
