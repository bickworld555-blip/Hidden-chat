import { apiFetch } from '../api.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, BarChart3, Bell, BellOff, CalendarClock, CalendarDays, Check, ChevronDown, Clock, Copy, Download, Flag, Link2, LockKeyhole, LogOut, Megaphone, MinusCircle, Paperclip,
  Pencil, Phone, Pin, PinOff, Search, SendHorizontal, Star, Sticker, Timer, Trash2, UserPlus, Users, Video, X,
} from 'lucide-react';
import { editGroupMessage } from '../parityApi.js';
import { groupChatKey, loadPins, setMessagePinned, toggleStar, useAccountData } from '../accountData.js';
import { canEditMessage } from '../selection.js';
import { appSettings } from '../settings.js';
import { prepareForSend } from '../mediaQuality.js';
import { isStickerContent, stickerContent } from '../stickers.js';
import { previewFor } from '../store.js';
import { StickerMessage, StickerPalette } from './parity/Stickers.jsx';
import { ComposerAssist, MentionText } from './parity/ComposerAssist.jsx';
import PinnedBanner from './parity/PinnedBanner.jsx';
import { ProductCard, parseProductContent } from './parity/ProductCard.jsx';
import { GroupAdminSettings, JoinGroupSheet, MemberAdminActions, inviteCodeFrom } from './parity/GroupAdmin.jsx';
import { searchPeople } from '../contactsApi.js';
import { uploadFile } from '../upload.js';
import { attachmentContent, sealForUpload } from '../mediaCrypto.js';
import { groupEncryption, sendGroupContent } from '../e2e/client.js';
import { fetchGroupMessages } from '../groupHistory.js';
import { dropPending, enqueuePending, flushPending, pendingFor, usePending } from '../groupPending.js';
import FormattedText from './FormattedText.jsx';
import { useChatStore } from '../store.js';
import { isMediaContent } from '../media.js';
import { MAX_CALL_PARTICIPANTS } from '../callRoom.js';
import { fetchCallTopology, newCallKey, parseRelayCall, relayCallContent, relayCallJoinable } from '../groupRelayCall.js';
import { lazyComponent } from '../lazy.js';
const GroupRelayCall = lazyComponent(() => import('./call/GroupRelayCall.jsx'));
import { groupPreviewText, unreadBadge } from '../groupRows.js';
import { exportGroupChat, parseScheduledCall, scheduledCallContent, senderColor, withDaySeparators } from '../groupChat.js';
import { setGroupMuted, setViewingGroup, useMutedGroups } from '../groupPrefs.js';
import Avatar from './Avatar.jsx';
import MediaRenderer from './MediaRenderer.jsx';
import { useBackHandler } from '../backStack.js';
import { nativeClearMessageNotifications, nativeShell } from '../native.js';
import { EventBubble, EventComposer, PollBubble, PollComposer } from './RichMessages.jsx';
import { parsePollContent } from '../polls.js';
import { parseEventContent } from '../calendarEvents.js';

const DELETE_WINDOW_MS = 24 * 60 * 60 * 1000;

// Group messages are end-to-end encrypted on the way out (Sender Keys, src/e2e/client.js) and opened on the way in.
const GROUP_MESSAGES = /^\/([^/]+)\/messages$/;
async function groupRequest(token, path, options = {}) {
  const groupId = GROUP_MESSAGES.exec(path)?.[1];
  if (groupId && options.method === 'POST' && typeof options.body?.content === 'string') {
    const id = decodeURIComponent(groupId);
    const plain = options.body.content;
    try {
      const row = await sendGroupContent(id, plain, (content) => rawGroupRequest(token, path, { ...options, body: { ...options.body, content } }));
      return row ? { ...row, content: plain } : row;
    } catch (error) {
      // Strict end-to-end encryption: a member has no keys yet, so the message waits on this device.
      if (error?.code !== 'group-keys-missing') throw error;
      enqueuePending(useChatStore.getState().userId, id, plain);
      return { pending: true };
    }
  }
  if (groupId && (options.method ?? 'GET') === 'GET') return fetchGroupMessages(token, decodeURIComponent(groupId), { signal: options.signal });
  return rawGroupRequest(token, path, options);
}

async function rawGroupRequest(token, path, { method = 'GET', body, signal } = {}) {
  const response = await apiFetch(`/api/v1/groups${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const error = new Error(data.error || `Request failed (${response.status}).`);
    error.status = response.status;
    error.data = data;
    throw error;
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
  const pendingMessages = usePending(userId, selected);
  const [group, setGroup] = useState(null);
  const [messages, setMessages] = useState([]);
  // Whether every member can receive end-to-end encrypted messages; otherwise the group shows a warning.
  const [groupSecurity, setGroupSecurity] = useState(null);
  const [creating, setCreating] = useState(initialCreate);
  const [settings, setSettings] = useState(false);
  const [infoTab, setInfoTab] = useState('members');
  const [memberFilter, setMemberFilter] = useState('');
  const [confirming, setConfirming] = useState('');
  const [reportReason, setReportReason] = useState('');
  const [callMenu, setCallMenu] = useState(false);
  const [callPicker, setCallPicker] = useState('');
  // Large groups: a call for everyone through the media relay, when this server has one (src/groupRelayCall.js).
  const [relay, setRelay] = useState(null);
  const [relayCall, setRelayCall] = useState(null);
  useEffect(() => { fetchCallTopology(token).then((value) => setRelay(value.sfu)).catch(() => setRelay(null)); }, [token]);
  const [scheduling, setScheduling] = useState(false);
  const [richComposer, setRichComposer] = useState('');
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [picked, setPicked] = useState([]);
  const [draft, setDraft] = useState('');
  const [caret, setCaret] = useState(0);
  const [activeMessageId, setActiveMessageId] = useState('');
  const [editing, setEditing] = useState(null);
  const [stickersOpen, setStickersOpen] = useState(false);
  const [joinInput, setJoinInput] = useState(null);
  const [joinCode, setJoinCode] = useState('');
  const draftRef = useRef(null);
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
  const chatKey = selected ? groupChatKey(selected) : '';
  const pins = useAccountData((state) => (chatKey ? state.pins[chatKey] : null));
  const starred = useAccountData((state) => state.starred);
  const pinnedIds = useMemo(() => new Set((pins ?? []).map((pin) => pin.messageId)), [pins]);
  useEffect(() => {
    if (chatKey && token) loadPins(chatKey).catch(() => {});
  }, [chatKey, token, revision]);
  useEffect(() => { setActiveMessageId(''); setEditing(null); setStickersOpen(false); }, [selected]);

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
    const security = selected ? await groupEncryption(selected, { fresh: pendingFor(userId, selected).length > 0 }) : null;
    setGroupSecurity(security);
    // Waiting messages go out (sealed) as soon as every member has keys.
    if (selected && security?.encrypted && pendingFor(userId, selected).length) {
      const sent = await flushPending(userId, selected, (content) => sendGroupContent(selected, content, (sealed) => rawGroupRequest(token, `${groupPath}/messages`, { method: 'POST', body: { content: sealed } })));
      if (sent) setMessages(await groupRequest(token, `${groupPath}/messages`, { signal }));
    }
  }, [token, selected, groupPath]);

  useEffect(() => {
    const controller = new AbortController();
    refresh(controller.signal).catch((caught) => { if (caught.name !== 'AbortError') setError(caught.message); });
    return () => controller.abort();
  }, [refresh, revision]);
  // While messages wait for members' keys, check again every 30 s (refresh sends them once everyone has keys).
  useEffect(() => {
    if (!selected || !pendingMessages.length) return undefined;
    const timer = setInterval(() => refresh(new AbortController().signal).catch(() => {}), 30_000);
    return () => clearInterval(timer);
  }, [selected, pendingMessages.length, refresh]);

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
    if (viewingId && nativeShell()) nativeClearMessageNotifications(`group:${viewingId}`);
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
      const prepared = await prepareForSend(file, file.name || 'attachment', appSettings().get('media.uploadQuality'));
      const plain = prepared.blob instanceof File ? prepared.blob : new File([prepared.blob], prepared.filename, { type: prepared.blob.type });
      // Encrypted on this device before upload; the key travels in the end-to-end encrypted group message.
      const { upload, descriptor } = await sealForUpload(plain);
      const data = await uploadFile(upload, { groupId: selected, sessionToken: token, onProgress: (done, total) => setUploading(Math.max(1, Math.round((done / total) * 100))) });
      await groupRequest(token, `${groupPath}/messages`, { method: 'POST', body: { content: attachmentContent(data.id, descriptor ? prepared.filename || 'attachment' : data.filename || prepared.filename || 'attachment', descriptor) } });
      await refresh(new AbortController().signal);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setUploading(0);
    }
  }

  // Android Back walks the same levels as the on-screen back arrow (picker → settings → conversation → list → close).
  useBackHandler(true, () => goBack());

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

  const relayFits = Boolean(relay && group && group.members.length > MAX_CALL_PARTICIPANTS && group.members.length <= relay.maxParticipants);
  const startRelayCall = (mode) => perform(async () => {
    setCallMenu(false);
    // The call card carries the media key, so it may only travel end-to-end encrypted: no encrypted group, no call.
    const security = await groupEncryption(group.id, { fresh: true });
    setGroupSecurity(security);
    if (!security.encrypted) {
      throw new Error(`An encrypted group call needs everyone on the updated app. ${security.missing.length === 1 ? '1 member hasn’t' : `${security.missing.length} members haven’t`} opened it yet.`);
    }
    const content = relayCallContent({ mode, key: newCallKey() });
    await groupRequest(token, `${groupPath}/messages`, { method: 'POST', body: { content } });
    setRelayCall(parseRelayCall(content));
  });

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

  const sendText = (content) => perform(async () => {
    await groupRequest(token, `${groupPath}/messages`, { method: 'POST', body: { content } });
  });

  function submitDraft() {
    const content = draft.trim();
    if (!content) return;
    if (editing) {
      const target = editing;
      setEditing(null);
      setDraft('');
      if (content !== target.content) perform(() => editGroupMessage(token, selected, target.id, content));
      return;
    }
    perform(async () => {
      await groupRequest(token, `${groupPath}/messages`, { method: 'POST', body: { content } });
      setDraft('');
    });
  }

  function startEdit(message) {
    setActiveMessageId('');
    setStickersOpen(false);
    setEditing(message);
    setDraft(message.content);
    requestAnimationFrame(() => draftRef.current?.focus());
  }

  const describePinned = (messageId) => {
    const found = messages.find((item) => item.id === messageId);
    return found ? previewFor(found.content) : 'Pinned message';
  };
  const showMessage = (messageId) => {
    const node = listRef.current?.querySelector(`[data-group-message-id="${CSS.escape(messageId)}"]`);
    node?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    node?.classList.add('flash-highlight');
    setTimeout(() => node?.classList.remove('flash-highlight'), 1600);
  };
  const canPin = group && (group.role === 'admin' || !group.onlyAdminsEdit);
  const canSend = group && (group.role === 'admin' || !(group.onlyAdminsSend || group.isAnnouncement));
  const usernames = useMemo(() => new Set((group?.members ?? []).map((member) => member.username.toLowerCase())), [group?.members]);
  const ownUsername = group?.members.find((member) => member.id === userId)?.username;

  const openMemberSearch = () => {
    setInfoTab('members');
    setTimeout(() => memberSearchRef.current?.focus(), 0);
  };

  const inConversation = Boolean(group && !settings && !creating);
  const creator = group?.members.find((member) => member.id === group.createdBy);
  const sortedMembers = group ? [...group.members].sort((left, right) => (left.id === userId ? -1 : right.id === userId ? 1 : 0)) : [];
  const visibleMembers = sortedMembers.filter((member) => `${member.name} ${member.username}`.toLowerCase().includes(memberFilter.trim().toLowerCase()));
  const mediaMessages = messages.filter((message) => isMediaContent(message.content));

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
                  {relayFits ? <>
                    <li><button type="button" role="menuitem" onClick={() => startRelayCall('audio')}><Phone size={18} /> Voice call (everyone)</button></li>
                    <li><button type="button" role="menuitem" onClick={() => startRelayCall('video')}><Video size={18} /> Video call (everyone)</button></li>
                  </> : <>
                    <li><button type="button" role="menuitem" onClick={() => { setCallMenu(false); setCallPicker('audio'); }}><Phone size={18} /> Voice call</button></li>
                    <li><button type="button" role="menuitem" onClick={() => { setCallMenu(false); setCallPicker('video'); }}><Video size={18} /> Video call</button></li>
                  </>}
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
            {joinInput === null ? (
              <button type="button" className="groups-new" onClick={() => setJoinInput('')}>
                <span className="groups-new-icon"><Link2 size={22} /></span><strong>Join with an invite link</strong>
              </button>
            ) : (
              <form className="hm-join-form" onSubmit={(event) => {
                event.preventDefault();
                const code = inviteCodeFrom(joinInput);
                if (!code) { setError('Paste a Hidden Messenger group invite link.'); return; }
                setJoinCode(code);
                setJoinInput(null);
              }}>
                <input autoFocus value={joinInput} onChange={(event) => setJoinInput(event.target.value)} placeholder="Paste invite link" aria-label="Invite link" />
                <button type="submit" className="groups-primary">Open</button>
                <button type="button" onClick={() => setJoinInput(null)} aria-label="Cancel"><X size={16} /></button>
              </form>
            )}
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
                  <MemberAdminActions group={group} member={member} userId={userId} token={token}
                    onChanged={() => refresh(new AbortController().signal)} onNotice={setNotice} onError={setError} />
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
              <GroupAdminSettings key={group.id} group={group} token={token} onChanged={() => refresh(new AbortController().signal)} onNotice={setNotice} onError={setError} />
              <SettingsRow icon={muted ? BellOff : Bell} title="Notifications" detail={muted ? 'Muted · unread count stays grey and out of the app badge' : 'All'} onClick={() => setGroupMuted(userId, selected, !muted)}>
                <span className={`groups-switch ${muted ? '' : 'is-on'}`} role="switch" aria-checked={!muted} aria-label="Group notifications" />
              </SettingsRow>
              <SettingsRow icon={LockKeyhole} title="Encryption" detail="Messages and attachments are end-to-end encrypted with group sender keys; the server stores only ciphertext. Calls use DTLS-SRTP between members." />
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
              {confirming === 'leave' ? (
                <div className="groups-confirm" role="group" aria-label="Confirm leaving group">
                  <p>{group.role === 'admin' && !group.members.some((member) => member.role === 'admin' && member.id !== userId)
                    ? 'Leave this group? You are its only admin, so the longest-standing member becomes admin.'
                    : 'Leave this group? You will lose access to its messages.'}</p>
                  <button type="button" disabled={busy} onClick={() => setConfirming('')}>Cancel</button>
                  <button type="button" className="groups-danger" disabled={busy} onClick={() => perform(() => groupRequest(token, `${groupPath}/membership`, { method: 'DELETE' }))}>Confirm leave group</button>
                </div>
              ) : <SettingsRow icon={LogOut} title="Leave group" danger onClick={() => setConfirming('leave')} />}
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
            {group.isAnnouncement && <p className="hm-announcement-note"><Megaphone size={14} aria-hidden="true" /> Community announcements: only admins send messages.</p>}
            <PinnedBanner pins={pins} describe={describePinned} onJump={showMessage} canUnpin={canPin}
              onUnpin={(messageId) => setMessagePinned(chatKey, messageId, false).catch((caught) => setError(caught.message))} />
            <div className="groups-messages" aria-label="Group messages" ref={listRef}>
              {messages.length === 0 && <p className="groups-day">No messages yet. Say hi 👋</p>}
              {withDaySeparators(messages).map((item) => {
                if (item.kind === 'day') return <p className="groups-day" key={item.key}>{item.label}</p>;
                const { message } = item;
                const mine = message.senderId === userId;
                const sender = group.members.find((member) => member.id === message.senderId);
                const canDelete = group.role === 'admin' || (mine && Date.now() - message.createdAt < DELETE_WINDOW_MS);
                const isMedia = isMediaContent(message.content);
                const scheduled = parseScheduledCall(message.content);
                // Only a card that arrived end-to-end encrypted is joinable: its key must never have been readable on the way.
                const relayCard = parseRelayCall(message.content);
                const relaySafe = Boolean(relayCard && message.e2e);
                const poll = parsePollContent(message.content);
                const event = parseEventContent(message.content);
                const productId = parseProductContent(message.content);
                const sticker = isStickerContent(message.content);
                const active = activeMessageId === message.id;
                return (
                  <div className={`groups-message-row ${mine ? 'mine' : 'theirs'}${active ? ' is-active' : ''}`} key={item.key} data-group-message-id={message.id}>
                    {!mine && (sender ? <Avatar {...sender} size="small" /> : <span className="groups-avatar groups-avatar-small" aria-hidden="true" />)}
                    <article tabIndex={0} className={`groups-message ${mine ? 'mine' : 'theirs'} ${isMedia ? 'has-media' : ''} ${scheduled ? 'is-scheduled' : ''} ${sticker ? 'is-sticker' : ''}`}
                      onClick={(clickEvent) => { if (!clickEvent.target.closest('button, a, input, audio, video')) setActiveMessageId(active ? '' : message.id); }}
                      onKeyDown={(keyEvent) => { if (keyEvent.key === 'Enter' && keyEvent.target === keyEvent.currentTarget) setActiveMessageId(active ? '' : message.id); }}>
                      {!mine && <strong className="groups-sender" style={{ color: senderColor(message.senderId) }}>{sender?.name || 'Former member'}</strong>}
                      {relayCard ? (
                        <div className="groups-scheduled-card groups-relay-card">
                          <span className="groups-scheduled-icon">{relayCard.mode === 'video' ? <Video size={22} /> : <Phone size={22} />}</span>
                          <span><strong>Group {relayCard.mode === 'video' ? 'video' : 'voice'} call</strong><small>{!relaySafe ? 'Not encrypted, so it can’t be joined' : relayCallJoinable(relayCard) ? `Started ${formatSchedule(relayCard.startedAt)} · end-to-end encrypted` : 'Ended'}</small></span>
                          {relaySafe && relayCallJoinable(relayCard) && relay && <button type="button" onClick={() => setRelayCall(relayCard)}>Join</button>}
                        </div>
                      ) : scheduled ? (
                        <div className="groups-scheduled-card">
                          <span className="groups-scheduled-icon"><CalendarClock size={22} /></span>
                          <span><strong>{scheduled.title}</strong><small>{scheduled.mode === 'video' ? 'Video call' : 'Voice call'} · {formatSchedule(scheduled.at)}</small></span>
                          {onStartGroupCall && <button type="button" onClick={() => setCallPicker(scheduled.mode)}>{scheduled.at > Date.now() ? 'Start early' : 'Start call'}</button>}
                        </div>
                      ) : message.e2eError ? <p className="deleted-text"><span aria-hidden="true">🔒</span> Waiting for this message. It is end-to-end encrypted.</p>
                        : isMedia ? <MediaRenderer mediaRef={message.content} sessionToken={token} />
                        : poll ? <PollBubble messageId={message.id} poll={poll} sessionToken={token} userId={userId} nameFor={(id) => group.members.find((member) => member.id === id)?.name} context={{ groupId: selected }} />
                        : event ? <EventBubble messageId={message.id} event={event} />
                        : sticker ? <StickerMessage content={message.content} />
                        : productId ? <ProductCard itemId={productId} sessionToken={token} />
                        : <p><MentionText text={message.content} usernames={usernames} ownUsername={ownUsername} /></p>}
                      <span className="groups-message-meta">
                        {canDelete && <button type="button" disabled={busy} aria-label="Delete message" title="Delete message" onClick={() => perform(() => groupRequest(token, `${groupPath}/messages/${encodeURIComponent(message.id)}`, { method: 'DELETE' }))}><Trash2 size={13} /></button>}
                        {message.expiresAt && <Timer size={12} aria-label="Disappears after 24 hours" />}
                        {pinnedIds.has(message.id) && <Pin size={12} aria-label="Pinned" />}
                        {starred[message.id] && <Star size={12} fill="currentColor" aria-label="Starred" />}
                        {message.editedAt && <span className="message-edited">Edited</span>}
                        <time dateTime={new Date(message.createdAt).toISOString()}>{formatTime(message.createdAt)}</time>
                      </span>
                      {active && (
                        <span className="hm-message-actions" role="toolbar" aria-label="Message actions">
                          <button type="button" aria-label={starred[message.id] ? 'Unstar' : 'Star'} onClick={() => { setActiveMessageId(''); toggleStar(message.id, chatKey, !starred[message.id]).catch((caught) => setError(caught.message)); }}>
                            <Star size={16} fill={starred[message.id] ? 'currentColor' : 'none'} />
                          </button>
                          {canPin && (
                            <button type="button" aria-label={pinnedIds.has(message.id) ? 'Unpin' : 'Pin'} onClick={() => { setActiveMessageId(''); setMessagePinned(chatKey, message.id, !pinnedIds.has(message.id)).catch((caught) => setError(caught.message)); }}>
                              {pinnedIds.has(message.id) ? <PinOff size={16} /> : <Pin size={16} />}
                            </button>
                          )}
                          {canEditMessage(message, userId) && <button type="button" aria-label="Edit" onClick={() => startEdit(message)}><Pencil size={16} /></button>}
                          {!isMedia && !sticker && !poll && !event && !scheduled && !productId && (
                            <button type="button" aria-label="Copy" onClick={() => { setActiveMessageId(''); navigator.clipboard?.writeText(message.content).then(() => setNotice('Message copied.')).catch(() => {}); }}><Copy size={16} /></button>
                          )}
                        </span>
                      )}
                    </article>
                  </div>
                );
              })}
              {pendingMessages.map((entry) => (
                <div className="groups-message-row mine" key={entry.id}>
                  <article className="groups-message mine is-waiting">
                    <p className="groups-message-text">{parseRelayCall(entry.content) ? 'Group call' : <FormattedText text={entry.content} />}</p>
                    <span className="groups-waiting"><Clock size={12} aria-hidden="true" /> Waiting until everyone has the updated app · end-to-end encrypted</span>
                    <button type="button" className="groups-waiting-cancel" onClick={() => dropPending(userId, selected, entry.id)}>Don’t send</button>
                  </article>
                </div>
              ))}
            </div>
            {!canSend ? (
              <p className="hm-admins-only" role="status"><LockKeyhole size={16} aria-hidden="true" /> Only admins can send messages</p>
            ) : (<>
            {editing && (
              <div className="hm-edit-strip">
                <Pencil size={14} aria-hidden="true" /><span>Editing message</span>
                <button type="button" onClick={() => { setEditing(null); setDraft(''); }} aria-label="Cancel edit"><X size={16} /></button>
              </div>
            )}
            {!editing && <ComposerAssist text={draft} caret={caret} members={group.members} userId={userId} onReplace={(next, nextCaret) => {
              setDraft(next);
              setCaret(nextCaret);
              requestAnimationFrame(() => { draftRef.current?.focus(); draftRef.current?.setSelectionRange(nextCaret, nextCaret); });
            }} />}
            {stickersOpen && !editing && <StickerPalette onPick={(key) => { setStickersOpen(false); sendText(stickerContent(key)); }} />}
            {groupSecurity && !groupSecurity.encrypted && (
              <p className="e2e-warning" role="status">🔓 {groupSecurity.missing.length === 1 ? '1 member hasn’t' : `${groupSecurity.missing.length} members haven’t`} opened an updated Hidden Messenger yet. Messages to this group <strong>wait on your phone</strong> and go out end-to-end encrypted as soon as they do.</p>
            )}
            <form className="groups-compose" onSubmit={(event) => { event.preventDefault(); submitDraft(); }}>
              <input ref={fileInputRef} type="file" hidden onChange={(event) => { const [file] = event.target.files ?? []; event.target.value = ''; sendAttachment(file); }} />
              <span className="groups-compose-field">
                <input ref={draftRef} aria-label="Group message" value={draft} maxLength={10000}
                  onChange={(event) => { setDraft(event.target.value); setCaret(event.target.selectionStart ?? event.target.value.length); }}
                  onSelect={(event) => setCaret(event.target.selectionStart ?? 0)}
                  placeholder={uploading ? `Uploading… ${uploading}%` : editing ? 'Edit message' : 'Message'} disabled={uploading > 0} />
                {!editing && <button type="button" className="groups-attach" onClick={() => setStickersOpen((open) => !open)} disabled={busy} aria-label="Stickers" aria-expanded={stickersOpen} title="Stickers"><Sticker size={20} /></button>}
                <button type="button" className="groups-attach" onClick={() => fileInputRef.current?.click()} disabled={busy || uploading > 0} aria-label="Attach a file" title="Attach a photo, video or file">
                  <Paperclip size={20} />
                </button>
                <button type="button" className="groups-attach" onClick={() => setRichComposer('poll')} disabled={busy} aria-label="Create poll" title="Poll"><BarChart3 size={20} /></button>
                <button type="button" className="groups-attach" onClick={() => setRichComposer('event')} disabled={busy} aria-label="Create event" title="Event"><CalendarDays size={20} /></button>
              </span>
              <button type="submit" className="groups-send" disabled={busy || uploading > 0 || !draft.trim()} aria-label={editing ? 'Save edit' : 'Send'}>{editing ? <Check size={20} /> : <SendHorizontal size={20} />}</button>
            </form>
            </>)}
          </>
        )}
        {joinCode && <JoinGroupSheet code={joinCode} token={token} onClose={() => setJoinCode('')} onJoined={(groupId) => { setJoinCode(''); setSelected(groupId); }} />}
        {group && callPicker && <CallPeoplePicker members={group.members} userId={userId} mode={callPicker} busy={busy} onStart={startCall} onClose={() => setCallPicker('')} />}
        {group && scheduling && <ScheduleCallSheet busy={busy} onSchedule={scheduleCall} onClose={() => setScheduling(false)} />}
        {group && richComposer && (() => {
          const Composer = richComposer === 'poll' ? PollComposer : EventComposer;
          const send = (content) => { setRichComposer(''); perform(() => groupRequest(token, `${groupPath}/messages`, { method: 'POST', body: { content } })); };
          return <Composer onSend={send} onClose={() => setRichComposer('')} />;
        })()}
        {relayCall && group && <GroupRelayCall token={token} groupId={group.id} groupName={group.name} call={relayCall} onClose={() => setRelayCall(null)} />}
      </div>
    </div>
  );
}
