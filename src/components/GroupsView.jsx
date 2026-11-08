import { apiFetch } from '../api.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, BarChart3, Bell, BellOff, CalendarClock, CalendarDays, ChevronDown, Download, Flag, LockKeyhole, LogOut, MinusCircle, Paperclip,
  Phone, Search, SendHorizontal, Timer, Trash2, UserPlus, Users, Video, X,
} from 'lucide-react';
import { searchPeople } from '../contactsApi.js';
import { uploadFile } from '../upload.js';
import { MAX_CALL_PARTICIPANTS } from '../callRoom.js';
import { groupPreviewText, unreadBadge } from '../groupRows.js';
import { exportGroupChat, parseScheduledCall, scheduledCallContent, senderColor, withDaySeparators } from '../groupChat.js';
import { setGroupMuted, setViewingGroup, useMutedGroups } from '../groupPrefs.js';
import Avatar from './Avatar.jsx';
import MediaRenderer from './MediaRenderer.jsx';
import { EventBubble, EventComposer, PollBubble, PollComposer } from './RichMessages.jsx';
import { parsePollContent } from '../polls.js';
import { parseEventContent } from '../calendarEvents.js';

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

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function formatSchedule(timestamp) {
  return new Date(timestamp).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

function GroupAvatar({ size = 'normal' }) {
  return <span className={`groups-avatar groups-avatar-${size}`} aria-hidden="true"><Users size={size === 'large' ? 56 : size === 'small' ? 18 : 24} /></span>;
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

function defaultScheduleTime() {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  date.setMinutes(0, 0, 0);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function ScheduleCallSheet({ busy, onSchedule, onClose }) {
  const [title, setTitle] = useState('');
  const [when, setWhen] = useState(defaultScheduleTime);
  const [mode, setMode] = useState('video');
  const at = new Date(when).getTime();
  const valid = Boolean(title.trim()) && Number.isFinite(at) && at > Date.now();
  return (
    <form className="groups-sheet" role="dialog" aria-modal="true" aria-label="Schedule call" onSubmit={(event) => { event.preventDefault(); if (valid) onSchedule({ title, at, mode }); }}>
      <header>
        <strong>Schedule call</strong>
        <button type="button" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </header>
      <p>Posts the call to the group so members can see when it starts.</p>
      <label>Call name<input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Weekly catch-up" required /></label>
      <label>Starts<input type="datetime-local" value={when} onChange={(event) => setWhen(event.target.value)} required /></label>
      <div className="groups-segmented" role="radiogroup" aria-label="Call type">
        <button type="button" role="radio" aria-checked={mode === 'video'} onClick={() => setMode('video')}><Video size={16} /> Video</button>
        <button type="button" role="radio" aria-checked={mode === 'audio'} onClick={() => setMode('audio')}><Phone size={16} /> Voice</button>
      </div>
      {Number.isFinite(at) && at <= Date.now() && <p className="groups-field-error">Choose a time in the future.</p>}
      <button type="submit" className="groups-primary" disabled={busy || !valid}><CalendarClock size={16} /> Schedule</button>
    </form>
  );
}

function SettingsRow({ icon: Icon, title, detail, danger = false, onClick, children, disabled = false }) {
  const body = (
    <>
      <Icon size={22} className="groups-setting-icon" />
      <span className="groups-setting-copy"><strong>{title}</strong>{detail && <small>{detail}</small>}</span>
      {children}
    </>
  );
  return onClick
    ? <button type="button" className={`groups-setting ${danger ? 'groups-danger' : ''}`} onClick={onClick} disabled={disabled}>{body}</button>
    : <div className={`groups-setting ${danger ? 'groups-danger' : ''}`}>{body}</div>;
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
  const [scheduling, setScheduling] = useState(false);
  const [richComposer, setRichComposer] = useState('');
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
  const memberSearchRef = useRef(null);
  const lastReadRef = useRef({ groupId: '', at: 0 });
  const mutedGroupIds = useMutedGroups(userId);
  const groupPath = selected ? `/${encodeURIComponent(selected)}` : '';
  const muted = Boolean(selected && mutedGroupIds.includes(selected));

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
  }, [messages.length, selected, settings]);

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

  // Lets the app skip this group's sound while it is open on screen.
  const viewingId = group && !settings && !creating ? selected : '';
  useEffect(() => {
    setViewingGroup(viewingId);
    return () => setViewingGroup('');
  }, [viewingId]);

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
    if (callPicker || scheduling) { setCallPicker(''); setScheduling(false); }
    else if (settings) { setSettings(false); setQuery(''); setMemberFilter(''); setConfirming(''); setReportReason(''); }
    else if (creating) { setCreating(false); setQuery(''); setPicked([]); }
    else if (selected) { setSelected(''); setGroup(null); setMessages([]); setCallMenu(false); }
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

  const scheduleCall = (details) => perform(async () => {
    await groupRequest(token, `${groupPath}/messages`, { method: 'POST', body: { content: scheduledCallContent(details) } });
    setScheduling(false);
    setSettings(false);
    setNotice('Call scheduled and shared with the group.');
  });

  const createSimilarGroup = () => {
    const others = group.members.filter((member) => member.id !== userId);
    setSettings(false);
    setConfirming('');
    setCreating(true);
    setName('');
    setQuery('');
    setPicked(others.map((member) => ({ id: member.id, username: member.username, name: member.name })));
  };

  const exportChat = () => {
    const blob = new Blob([exportGroupChat(group, messages, userId)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${group.name.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || 'group'} chat.txt`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice('Chat exported.');
  };

  const openMemberSearch = () => {
    setInfoTab('members');
    setTimeout(() => memberSearchRef.current?.focus(), 0);
  };

  const inConversation = Boolean(group && !settings && !creating);
  const creator = group?.members.find((member) => member.id === group.createdBy);
  const sortedMembers = group ? [...group.members].sort((left, right) => (left.id === userId ? -1 : right.id === userId ? 1 : 0)) : [];
  const visibleMembers = sortedMembers.filter((member) => `${member.name} ${member.username}`.toLowerCase().includes(memberFilter.trim().toLowerCase()));
  const mediaMessages = messages.filter((message) => message.content.startsWith('media:'));

  return (
    <div className="groups-overlay" role="dialog" aria-modal="true" aria-label="Groups">
      <div className="groups-panel">
        <header className="groups-header">
          <button type="button" onClick={goBack} aria-label="Back"><ArrowLeft size={22} /></button>
          {inConversation ? (
            <button type="button" className="groups-title" onClick={() => setSettings(true)} aria-label="Open group info">
              <GroupAvatar size="small" />
              <span className="groups-title-copy">
                <h2>{group.name}</h2>
                <small>{group.members.map((member) => (member.id === userId ? 'You' : member.name)).join(', ')}</small>
              </span>
            </button>
          ) : <h2>{creating ? 'New group' : settings && group ? group.name : 'Groups'}</h2>}
          {inConversation && onStartGroupCall && (
            <span className="groups-call-menu-wrap">
              <button type="button" className="groups-call-trigger" onClick={() => setCallMenu((open) => !open)} aria-label="Call options" aria-expanded={callMenu} aria-haspopup="menu">
                <Video size={22} /><ChevronDown size={14} />
              </button>
              {callMenu && (
                <ul className="groups-call-menu" role="menu" aria-label="Call options">
                  <li><button type="button" role="menuitem" onClick={() => { setCallMenu(false); setCallPicker('audio'); }}><Phone size={18} /> Voice call</button></li>
                  <li><button type="button" role="menuitem" onClick={() => { setCallMenu(false); setCallPicker('video'); }}><Video size={18} /> Video call</button></li>
                  <li className="groups-menu-divider" role="separator" />
                  <li><button type="button" role="menuitem" onClick={() => { setCallMenu(false); setCallPicker('video'); }}><Users size={18} /> Select people</button></li>
                  <li><button type="button" role="menuitem" onClick={() => { setCallMenu(false); setScheduling(true); }}><CalendarClock size={18} /> Schedule call</button></li>
                </ul>
              )}
            </span>
          )}
          <button type="button" onClick={onClose} aria-label="Close groups"><X size={22} /></button>
        </header>
        {error && <p className="groups-error" role="alert">{error}</p>}
        {!error && notice && <p className="groups-notice" role="status">{notice}</p>}

        {!selected && !creating && (
          <div className="groups-content groups-list">
            <button type="button" className="groups-new" onClick={() => { setCreating(true); setName(''); setPicked([]); }}>
              <span className="groups-new-icon"><UserPlus size={22} /></span><strong>New group</strong>
            </button>
            {groups.length === 0 && <p className="groups-empty">No groups yet.</p>}
            {groups.map((item) => {
              const isMuted = mutedGroupIds.includes(item.id);
              return (
                <button type="button" className="groups-list-row" key={item.id} onClick={() => setSelected(item.id)}>
                  <GroupAvatar />
                  <span className="groups-list-copy">
                    <span className="groups-list-top">
                      <strong>{item.name}</strong>
                      {item.lastMessageAt && <time className={item.unread && !isMuted ? 'is-unread' : ''} dateTime={new Date(item.lastMessageAt).toISOString()}>{formatWhen(item.lastMessageAt)}</time>}
                    </span>
                    <span className="groups-list-bottom">
                      <small>{groupPreviewText(item, userId)}</small>
                      {isMuted && <BellOff size={15} className="groups-muted-icon" aria-label="Muted" />}
                      {item.unread > 0 && <span className={`groups-unread ${isMuted ? 'is-muted' : ''}`} aria-label={`${item.unread} unread`}>{unreadBadge(item.unread)}</span>}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {creating && (
          <div className="groups-content">
            <label>Group name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} placeholder="Group name" /></label>
            <label>Add members by username<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search username" /></label>
            {picked.length > 0 && <div className="groups-chips">{picked.map((person) => (
              <button type="button" key={person.id} onClick={() => setPicked((current) => current.filter((item) => item.id !== person.id))} aria-label={`Remove @${person.username}`}>
                @{person.username} <X size={14} />
              </button>
            ))}</div>}
            {results.filter((person) => !picked.some((item) => item.id === person.id)).map((person) => (
              <button type="button" className="groups-row" key={person.id} onClick={() => { setPicked((current) => [...current, person]); setQuery(''); }}>
                <Avatar {...person} size="small" /><span><strong>{person.name}</strong><small>@{person.username}</small></span>
              </button>
            ))}
            <button type="button" className="groups-primary" disabled={busy || !name.trim()} onClick={() => perform(async () => {
              const created = await groupRequest(token, '', { method: 'POST', body: { name, memberIds: picked.map((person) => person.id) } });
              setCreating(false); setSelected(created.id); setQuery(''); setPicked([]);
            })}>Create group</button>
          </div>
        )}

        {group && settings && !creating && (
          <div className="groups-content groups-info">
            <div className="groups-info-summary">
              <GroupAvatar size="large" />
              <h3>{group.name}</h3>
              <small>Group · {group.members.length} {group.members.length === 1 ? 'member' : 'members'}</small>
              <div className="groups-info-actions">
                {onStartGroupCall && <button type="button" onClick={() => setCallPicker('audio')}><Phone size={20} /><span>Voice</span></button>}
                {onStartGroupCall && <button type="button" onClick={() => setCallPicker('video')}><Video size={20} /><span>Video</span></button>}
                <button type="button" onClick={openMemberSearch}><Search size={20} /><span>Search</span></button>
              </div>
            </div>
            <div className="groups-tabs" role="tablist" aria-label="Group information">
              <button type="button" role="tab" aria-selected={infoTab === 'members'} onClick={() => { setInfoTab('members'); setQuery(''); }}>Members</button>
              <button type="button" role="tab" aria-selected={infoTab === 'media'} onClick={() => { setInfoTab('media'); setQuery(''); }}>Media</button>
              <button type="button" role="tab" aria-selected={infoTab === 'settings'} onClick={() => { setInfoTab('settings'); setQuery(''); }}>Settings</button>
            </div>

            {infoTab === 'members' && <div className="groups-tab-body">
              <div className="groups-members-head">
                <span>{group.members.length} {group.members.length === 1 ? 'member' : 'members'}</span>
                <label className="groups-member-search">
                  <Search size={18} />
                  <input ref={memberSearchRef} value={memberFilter} onChange={(event) => setMemberFilter(event.target.value)} placeholder="Search members" aria-label="Search members" />
                </label>
              </div>
              {group.role === 'admin' && <>
                <label className="groups-add-member"><UserPlus size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Add member by username" aria-label="Add a member" /></label>
                {results.filter((person) => !group.members.some((item) => item.id === person.id)).map((person) => (
                  <button type="button" className="groups-row" key={person.id} disabled={busy} onClick={() => perform(async () => { await groupRequest(token, `${groupPath}/members`, { method: 'POST', body: { userId: person.id } }); setQuery(''); })}>
                    <Avatar {...person} size="small" /><span><strong>Add {person.name}</strong><small>@{person.username}</small></span>
                  </button>
                ))}
              </>}
              {visibleMembers.map((member) => (
                <div className="groups-member" key={member.id}>
                  <Avatar {...member} />
                  <span><strong>{member.id === userId ? 'You' : member.name}</strong><small>@{member.username}</small></span>
                  {member.role === 'admin' && <span className="groups-admin-tag">Group Admin</span>}
                </div>
              ))}
              {visibleMembers.length === 0 && <p className="groups-empty">No members match “{memberFilter}”.</p>}
            </div>}

            {infoTab === 'media' && (
              <div className="groups-media-grid">
                {mediaMessages.length === 0 && <p>No photos, videos or files in this group yet.</p>}
                {mediaMessages.map((message) => (
                  <div className="groups-media-tile" key={message.id}><MediaRenderer mediaRef={message.content} sessionToken={token} /></div>
                ))}
              </div>
            )}

            {infoTab === 'settings' && <div className="groups-tab-body">
              <SettingsRow icon={muted ? BellOff : Bell} title="Notifications" detail={muted ? 'Muted · unread count stays grey and out of the app badge' : 'All'} onClick={() => setGroupMuted(userId, selected, !muted)}>
                <span className={`groups-switch ${muted ? '' : 'is-on'}`} role="switch" aria-checked={!muted} aria-label="Group notifications" />
              </SettingsRow>
              <SettingsRow icon={LockKeyhole} title="Encryption" detail="Messages and calls are protected in transit (HTTPS/WSS, DTLS-SRTP) and stored on the Hidden Messenger server. They are not end-to-end encrypted." />
              <label className="groups-setting">
                <Timer size={22} className="groups-setting-icon" />
                <span className="groups-setting-copy"><strong>Disappearing messages</strong><small>{group.autoDelete ? '24 hours · applies to your new messages in this group' : 'Off'}</small></span>
                <input type="checkbox" className="groups-switch-input" checked={group.autoDelete} disabled={busy} onChange={(event) => toggleAutoDelete(event.target.checked)} aria-label="Disappearing messages (24 hours)" />
              </label>
              <div className="groups-settings-divider" />
              <SettingsRow icon={UserPlus} title="Create a similar group" detail="Start with the same members, then add or remove people." onClick={createSimilarGroup} />
              <SettingsRow icon={Download} title="Export chat" detail="Download this conversation as a text file." onClick={exportChat} disabled={!messages.length} />
              {onStartGroupCall && <SettingsRow icon={CalendarClock} title="Schedule call" detail="Share a planned voice or video call with the group." onClick={() => setScheduling(true)} />}
              <div className="groups-settings-divider" />
              {confirming === 'clear' ? (
                <div className="groups-confirm" role="group" aria-label="Confirm clearing chat">
                  <p>Clear this chat from your view? Other members keep their copies.</p>
                  <button type="button" disabled={busy} onClick={() => setConfirming('')}>Cancel</button>
                  <button type="button" className="groups-danger" disabled={busy} onClick={() => perform(async () => { await groupRequest(token, `${groupPath}/clear`, { method: 'POST', body: {} }); setConfirming(''); setNotice('Chat cleared for you.'); })}>Clear for me</button>
                  {group.role === 'admin' && <button type="button" className="groups-danger" disabled={busy} onClick={() => perform(async () => { await groupRequest(token, `${groupPath}/clear`, { method: 'POST', body: { everyone: true } }); setConfirming(''); setNotice('Chat cleared for everyone.'); })}>Clear for everyone</button>}
                </div>
              ) : <SettingsRow icon={MinusCircle} title="Clear chat" danger onClick={() => setConfirming('clear')} />}
              {group.role === 'member' ? (
                confirming === 'leave' ? (
                  <div className="groups-confirm" role="group" aria-label="Confirm leaving group">
                    <p>Leave this group? You will lose access to its messages.</p>
                    <button type="button" disabled={busy} onClick={() => setConfirming('')}>Cancel</button>
                    <button type="button" className="groups-danger" disabled={busy} onClick={() => perform(() => groupRequest(token, `${groupPath}/membership`, { method: 'DELETE' }))}>Confirm leave group</button>
                  </div>
                ) : <SettingsRow icon={LogOut} title="Leave group" danger onClick={() => setConfirming('leave')} />
              ) : <SettingsRow icon={LogOut} title="Leave group" detail="Admins cannot leave until admin transfer is supported." danger />}
              {confirming === 'report' ? (
                <form className="groups-confirm" aria-label="Report group" onSubmit={(event) => { event.preventDefault(); perform(async () => { await groupRequest(token, `${groupPath}/report`, { method: 'POST', body: { reason: reportReason } }); setConfirming(''); setReportReason(''); setNotice('Report sent. Thank you.'); }); }}>
                  <label>Why are you reporting this group?<textarea value={reportReason} maxLength={500} rows={3} onChange={(event) => setReportReason(event.target.value)} /></label>
                  <button type="button" disabled={busy} onClick={() => { setConfirming(''); setReportReason(''); }}>Cancel</button>
                  <button type="submit" className="groups-danger" disabled={busy || !reportReason.trim()}>Send report</button>
                </form>
              ) : <SettingsRow icon={Flag} title="Report group" danger onClick={() => setConfirming('report')} />}
              <p className="groups-created">Created by {creator ? (creator.id === userId ? 'you' : creator.name) : 'a former member'}, {new Date(group.createdAt).toLocaleDateString()}</p>
            </div>}
          </div>
        )}

        {inConversation && (
          <>
            <div className="groups-messages" aria-label="Group messages" ref={listRef}>
              {messages.length === 0 && <p className="groups-day">No messages yet. Say hi 👋</p>}
              {withDaySeparators(messages).map((item) => {
                if (item.kind === 'day') return <p className="groups-day" key={item.key}>{item.label}</p>;
                const { message } = item;
                const mine = message.senderId === userId;
                const sender = group.members.find((member) => member.id === message.senderId);
                const canDelete = group.role === 'admin' || (mine && Date.now() - message.createdAt < DELETE_WINDOW_MS);
                const isMedia = message.content.startsWith('media:');
                const scheduled = parseScheduledCall(message.content);
                const poll = parsePollContent(message.content);
                const event = parseEventContent(message.content);
                return (
                  <div className={`groups-message-row ${mine ? 'mine' : 'theirs'}`} key={item.key}>
                    {!mine && (sender ? <Avatar {...sender} size="small" /> : <span className="groups-avatar groups-avatar-small" aria-hidden="true" />)}
                    <article tabIndex={0} className={`groups-message ${mine ? 'mine' : 'theirs'} ${isMedia ? 'has-media' : ''} ${scheduled ? 'is-scheduled' : ''}`}>
                      {!mine && <strong className="groups-sender" style={{ color: senderColor(message.senderId) }}>{sender?.name || 'Former member'}</strong>}
                      {scheduled ? (
                        <div className="groups-scheduled-card">
                          <span className="groups-scheduled-icon"><CalendarClock size={22} /></span>
                          <span><strong>{scheduled.title}</strong><small>{scheduled.mode === 'video' ? 'Video call' : 'Voice call'} · {formatSchedule(scheduled.at)}</small></span>
                          {onStartGroupCall && <button type="button" onClick={() => setCallPicker(scheduled.mode)}>{scheduled.at > Date.now() ? 'Start early' : 'Start call'}</button>}
                        </div>
                      ) : isMedia ? <MediaRenderer mediaRef={message.content} sessionToken={token} />
                        : poll ? <PollBubble messageId={message.id} poll={poll} sessionToken={token} userId={userId} nameFor={(id) => group.members.find((member) => member.id === id)?.name} />
                        : event ? <EventBubble messageId={message.id} event={event} />
                        : <p>{message.content}</p>}
                      <span className="groups-message-meta">
                        {canDelete && <button type="button" disabled={busy} aria-label="Delete message" title="Delete message" onClick={() => perform(() => groupRequest(token, `${groupPath}/messages/${encodeURIComponent(message.id)}`, { method: 'DELETE' }))}><Trash2 size={13} /></button>}
                        {message.expiresAt && <Timer size={12} aria-label="Disappears after 24 hours" />}
                        <time dateTime={new Date(message.createdAt).toISOString()}>{formatTime(message.createdAt)}</time>
                      </span>
                    </article>
                  </div>
                );
              })}
            </div>
            <form className="groups-compose" onSubmit={(event) => { event.preventDefault(); if (draft.trim()) perform(async () => { await groupRequest(token, `${groupPath}/messages`, { method: 'POST', body: { content: draft } }); setDraft(''); }); }}>
              <input ref={fileInputRef} type="file" hidden onChange={(event) => { const [file] = event.target.files ?? []; event.target.value = ''; sendAttachment(file); }} />
              <span className="groups-compose-field">
                <input aria-label="Group message" value={draft} maxLength={10000} onChange={(event) => setDraft(event.target.value)} placeholder={uploading ? `Uploading… ${uploading}%` : 'Message'} disabled={uploading > 0} />
                <button type="button" className="groups-attach" onClick={() => fileInputRef.current?.click()} disabled={busy || uploading > 0} aria-label="Attach a file" title="Attach a photo, video or file">
                  <Paperclip size={20} />
                </button>
                <button type="button" className="groups-attach" onClick={() => setRichComposer('poll')} disabled={busy} aria-label="Create poll" title="Poll"><BarChart3 size={20} /></button>
                <button type="button" className="groups-attach" onClick={() => setRichComposer('event')} disabled={busy} aria-label="Create event" title="Event"><CalendarDays size={20} /></button>
              </span>
              <button type="submit" className="groups-send" disabled={busy || uploading > 0 || !draft.trim()} aria-label="Send"><SendHorizontal size={20} /></button>
            </form>
          </>
        )}
        {group && callPicker && <CallPeoplePicker members={group.members} userId={userId} mode={callPicker} busy={busy} onStart={startCall} onClose={() => setCallPicker('')} />}
        {group && scheduling && <ScheduleCallSheet busy={busy} onSchedule={scheduleCall} onClose={() => setScheduling(false)} />}
        {group && richComposer && (() => {
          const Composer = richComposer === 'poll' ? PollComposer : EventComposer;
          const send = (content) => { setRichComposer(''); perform(() => groupRequest(token, `${groupPath}/messages`, { method: 'POST', body: { content } })); };
          return <Composer onSend={send} onClose={() => setRichComposer('')} />;
        })()}
      </div>
    </div>
  );
}
