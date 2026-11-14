import { apiFetch, isNetworkFailure } from '../api.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, MessageCircle, ShieldCheck, UserMinus, Bell, BellOff, CalendarClock, Check, ChevronDown, Clock, Copy, Download, Flag, Link2, LockKeyhole, LogOut, Megaphone, MinusCircle, Paperclip,
  Camera, ListPlus, Mic, Smile, Pencil, Phone, Pin, PinOff, QrCode, Search, SendHorizontal, Share2, Star, Timer, Trash2, UserPlus, Users, Video, X,
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { inviteUrl } from '../invites.js';
import { LIST_NAME_MAX, listEntries } from './ChatLists.jsx';
import { editGroupMessage, removeMember as removeMemberApi, resetInvite, setMemberRole as setMemberRoleApi } from '../parityApi.js';
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
import { handleFrom, lookupUsername } from '../contactsApi.js';
import { uploadFile } from '../upload.js';
import { attachmentContent, sealForUpload } from '../mediaCrypto.js';
import { groupEncryption, sendGroupContent } from '../e2e/client.js';
import { fetchGroupMessages } from '../groupHistory.js';
import { dropPending, enqueuePending, flushPending, pendingFor, usePending } from '../groupPending.js';
import FormattedText from './FormattedText.jsx';
import { useChatStore } from '../store.js';
import { formatMessageTime } from '../time.js';
import { createActivitySender, groupActivityLabel, groupActivityPeople } from '../typing.js';
import { cachedGroupDetails, cachedGroups, offlineGroupDetails, saveGroupDetails, saveGroups } from '../groupCache.js';
import { isMediaContent, primeMediaBlob } from '../media.js';
import { MAX_CALL_PARTICIPANTS } from '../callRoom.js';
import { fetchCallTopology, newCallKey, parseRelayCall, relayCallContent, relayCallJoinable } from '../groupRelayCall.js';
import { lazyComponent } from '../lazy.js';
const GroupRelayCall = lazyComponent(() => import('./call/GroupRelayCall.jsx'));
import { groupPreviewText, unreadBadge } from '../groupRows.js';
import { exportGroupChat, parseScheduledCall, scheduledCallContent, senderColor, withDaySeparators } from '../groupChat.js';
import { setGroupMuted, setViewingGroup, useMutedGroups } from '../groupPrefs.js';
import Avatar from './Avatar.jsx';
import MediaRenderer from './MediaRenderer.jsx';
import VoiceMessage from './VoiceMessage.jsx';
import VoiceRecorderBar from './VoiceRecorderBar.jsx';
import AttachmentMenu from './AttachmentMenu.jsx';
import CameraCapture from './CameraCapture.jsx';
import { parseVoiceContent, voiceContent, voiceExtension } from '../voice.js';
import { resolveVoiceLanguage } from '../voiceLanguage.js';
import MediaComposer from './MediaComposer.jsx';
import { makeThumb, videoPreview } from '../mediaThumb.js';
import { useBackHandler } from '../backStack.js';
import { nativeClearMessageNotifications, nativeShell } from '../native.js';
import { EventBubble, EventComposer, PollBubble, PollComposer } from './RichMessages.jsx';
import { parsePollContent } from '../polls.js';
import { parseEventContent } from '../calendarEvents.js';
import { keepKeyboard } from '../keyboard.js';

const DELETE_WINDOW_MS = 24 * 60 * 60 * 1000;
// What the group share sheet offers (the one-to-one sheet minus what is per contact: location, contact, catalog…).
const GROUP_ATTACH_OPTIONS = ['document', 'camera', 'gallery', 'audio', 'poll', 'event', 'sticker'];

// Group messages are end-to-end encrypted on the way out (Sender Keys, src/e2e/client.js) and opened on the way in.
const GROUP_MESSAGES = /^\/([^/]+)\/messages$/;
async function groupRequest(token, path, options = {}) {
  const groupId = GROUP_MESSAGES.exec(path)?.[1];
  if (groupId && options.method === 'POST' && typeof options.body?.content === 'string') {
    const id = decodeURIComponent(groupId);
    const plain = options.body.content;
    // extras (caption, thumbnail…) travel inside the encryption only, never in the request body.
    const extras = options.extras ?? {};
    try {
      const row = await sendGroupContent(id, plain, (content) => rawGroupRequest(token, path, { ...options, extras: undefined, body: { ...options.body, content } }), extras);
      return row ? { ...row, content: plain, ...extras } : row;
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
  return formatMessageTime(timestamp); // the same clock as one-to-one chats
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

// Member tags: a short label each member sets for themselves in a group (server/parity.mjs MEMBER_TAG_MAX).
const MEMBER_TAG_MAX = 30;

// "Add to lists" from group info: tick the chat lists this group belongs to, or start a new one with it.
function GroupListsSheet({ groupKey, onClose }) {
  const lists = useChatStore((state) => state.chatLists);
  const saveChatList = useChatStore((state) => state.saveChatList);
  const [name, setName] = useState('');
  const entries = listEntries(lists);
  const toggle = (id, list) => {
    const keys = new Set(list.keys ?? []);
    if (keys.has(groupKey)) keys.delete(groupKey); else keys.add(groupKey);
    saveChatList(id, { name: list.name, keys: [...keys] });
  };
  const taken = entries.some(([, list]) => list.name.trim().toLowerCase() === name.trim().toLowerCase());
  return (
    <div className="groups-sheet" role="dialog" aria-modal="true" aria-label="Add to lists">
      <header>
        <strong>Add to lists</strong>
        <button type="button" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </header>
      {entries.length === 0 && <p>No lists yet. Lists sort your chats into tabs on the chat list.</p>}
      {entries.map(([id, list]) => (
        <label className="groups-list-pick" key={id}>
          <input type="checkbox" checked={(list.keys ?? []).includes(groupKey)} onChange={() => toggle(id, list)} />
          <span>{list.name}</span>
        </label>
      ))}
      <form className="groups-list-new" onSubmit={(event) => { event.preventDefault(); if (name.trim() && !taken) { saveChatList('', { name, keys: [groupKey] }); setName(''); } }}>
        <input value={name} maxLength={LIST_NAME_MAX} onChange={(event) => setName(event.target.value)} placeholder="New list name" aria-label="New list name" />
        <button type="submit" className="groups-primary" disabled={!name.trim() || taken}>Create</button>
      </form>
      {taken && <p className="groups-field-error">A list with that name already exists.</p>}
    </div>
  );
}

// The group's QR code (its invite link, admins only), as on WhatsApp's group info header.
// WhatsApp: tap a member (in the member list, or their name or photo on a message) → message or call them one to one,
// even when they are not a saved contact.
function MemberSheet({ member, group, userId, token, onMessage, onCall, onChanged, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState(false);
  // WhatsApp: an admin also sees Make group admin / Dismiss as admin and Remove from group here.
  const canManage = group?.role === 'admin' && member.id !== userId && member.id !== group?.createdBy;
  async function manage(action, notice) {
    setBusy(true);
    setError('');
    try {
      await action();
      onChanged?.(notice);
      onClose();
    } catch (caught) {
      setError(caught.message);
      setBusy(false);
    }
  }
  async function message() {
    setBusy(true);
    setError('');
    try { await onMessage(member); } catch (caught) { setError(caught.message || 'Could not open this chat.'); setBusy(false); }
  }
  return (
    <>
      <div className="groups-sheet-scrim" onClick={onClose} aria-hidden="true" />
      <div className="groups-sheet groups-member-sheet" role="dialog" aria-modal="true" aria-label={`${member.name || member.username}`}>
        <header>
          <span className="groups-member-sheet-who">
            <Avatar {...member} />
            <span><strong>{member.name || `@${member.username}`}</strong>{member.username && member.name !== `@${member.username}` && <small>@{member.username}</small>}</span>
          </span>
          <button type="button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>
        <div className="groups-member-sheet-tiles">
          <button type="button" disabled={busy} onClick={message}><MessageCircle size={22} /><span>Message</span></button>
          {onCall && <button type="button" disabled={busy} onClick={() => onCall(member, 'audio')}><Phone size={22} /><span>Voice</span></button>}
          {onCall && <button type="button" disabled={busy} onClick={() => onCall(member, 'video')}><Video size={22} /><span>Video</span></button>}
        </div>
        {canManage && (
          <>
            <button type="button" className="groups-member-sheet-row" disabled={busy}
              onClick={() => manage(() => setMemberRoleApi(token, group.id, member.id, member.role === 'admin' ? 'member' : 'admin'), member.role === 'admin' ? `${member.name} is no longer an admin.` : `${member.name} is now an admin.`)}>
              <ShieldCheck size={20} /> {member.role === 'admin' ? 'Dismiss as admin' : 'Make group admin'}
            </button>
            {removing ? (
              <div className="groups-confirm" role="group" aria-label="Confirm removing member">
                <p>Remove {member.name} from “{group.name}”?</p>
                <button type="button" disabled={busy} onClick={() => setRemoving(false)}>Cancel</button>
                <button type="button" className="groups-danger" disabled={busy} onClick={() => manage(() => removeMemberApi(token, group.id, member.id), `${member.name} was removed.`)}>Remove</button>
              </div>
            ) : (
              <button type="button" className="groups-member-sheet-row is-danger" disabled={busy} onClick={() => setRemoving(true)}><UserMinus size={20} /> Remove from group</button>
            )}
          </>
        )}
        {error && <p role="alert">{error}</p>}
      </div>
    </>
  );
}

function GroupQrSheet({ group, onShare, onClose }) {
  const link = inviteUrl(group.inviteCode);
  return (
    <div className="groups-sheet groups-qr-sheet" role="dialog" aria-modal="true" aria-label="Group QR code">
      <header>
        <strong>Group QR code</strong>
        <button type="button" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </header>
      <div className="groups-qr-card">
        <GroupAvatar size="small" />
        <strong>{group.name}</strong>
        <small>Group · {group.members.length} {group.members.length === 1 ? 'member' : 'members'}</small>
        <span className="groups-qr-code"><QRCodeSVG value={link} size={196} level="M" bgColor="#ffffff" fgColor="#0b1628" includeMargin aria-label="QR code to join this group" /></span>
      </div>
      <p>Anyone with Hidden Messenger can scan this code to join this group. Only share it with people you trust.</p>
      <button type="button" className="groups-primary" onClick={onShare}><Share2 size={16} /> Share link</button>
    </div>
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

// A message waiting on this phone until every member can receive it end to end: shown as the bubble it will become
// (voice note, photo, sticker, poll…), never as its raw wire content.
function PendingGroupBody({ content, token, self }) {
  if (parseRelayCall(content)) return <p className="groups-message-text">Group call</p>;
  if (isMediaContent(content)) return <MediaRenderer mediaRef={content} sessionToken={token} />;
  const voice = parseVoiceContent(content);
  if (voice?.id) return <VoiceMessage id={voice.id} seconds={voice.seconds} lang={voice.lang} sessionToken={token} sender={self} played />;
  if (isStickerContent(content)) return <StickerMessage content={content} />;
  const poll = parsePollContent(content);
  if (poll) return <p className="groups-message-text">📊 {poll.question}</p>;
  const event = parseEventContent(content);
  if (event) return <p className="groups-message-text">🗓️ {event.title}</p>;
  const scheduled = parseScheduledCall(content);
  if (scheduled) return <p className="groups-message-text">📅 {scheduled.title}</p>;
  return <p className="groups-message-text"><FormattedText text={content} /></p>;
}

export default function GroupsView({ token, userId, client, revision, onClose, onStartGroupCall, onMessagePerson, onCallPerson, initialCreate = false, initialGroupId = '' }) {
  // The member whose Message / Voice call / Video call sheet is open.
  const [personSheet, setPersonSheet] = useState(null);
  const openPerson = (member) => { if (member && member.id !== userId && (onMessagePerson || group?.role === 'admin')) setPersonSheet(member); };
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
  const [infoCallMenu, setInfoCallMenu] = useState(false);
  const [memberSearchOpen, setMemberSearchOpen] = useState(false);
  const [addingMember, setAddingMember] = useState(false);
  const [tagDraft, setTagDraft] = useState(null);
  const [infoSheet, setInfoSheet] = useState('');
  const [recordingVoice, setRecordingVoice] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const sendQueueRef = useRef(Promise.resolve());
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
  const activityRef = useRef(null);
  const [caret, setCaret] = useState(0);
  const [activeMessageId, setActiveMessageId] = useState('');
  const [editing, setEditing] = useState(null);
  const [stickersOpen, setStickersOpen] = useState(false);
  const [joinInput, setJoinInput] = useState(null);
  const [joinCode, setJoinCode] = useState('');
  const draftRef = useRef(null);
  const [uploading, setUploading] = useState(0);
  // The send preview (MediaComposer) for picked photos, videos and documents.
  const [groupComposer, setGroupComposer] = useState(null);
  const [groupComposerAdded, setGroupComposerAdded] = useState(null);
  const pickKindRef = useRef('media');
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
    shownFromServer.current = true;
    saveGroups(userId, list).catch(() => {});
    if (selected && details) saveGroupDetails(userId, selected, details).catch(() => {});
    // Local-first: what the server still holds is added to the group's history saved on this device.
    setMessages(selected ? useChatStore.getState().mergeGroupMessages(selected, history) : history);
    const security = selected ? await groupEncryption(selected, { fresh: pendingFor(userId, selected).length > 0 }) : null;
    setGroupSecurity(security);
    // Waiting messages go out (sealed) as soon as every member has keys.
    if (selected && security?.encrypted && pendingFor(userId, selected).length) {
      const sent = await flushPending(userId, selected, (content) => sendGroupContent(selected, content, (sealed) => rawGroupRequest(token, `${groupPath}/messages`, { method: 'POST', body: { content: sealed } })));
      if (sent) setMessages(useChatStore.getState().mergeGroupMessages(selected, await groupRequest(token, `${groupPath}/messages`, { signal })));
    }
  }, [token, selected, groupPath]);

  // Opening a group shows its history saved on this device at once; the server's part follows. Its name, members
  // and the group list come from this device too (src/groupCache.js), so they still show offline.
  const shownFromServer = useRef(false);
  useEffect(() => {
    let cancelled = false;
    shownFromServer.current = false;
    if (selected) setMessages(useChatStore.getState().savedGroupMessages(selected));
    Promise.all([cachedGroups(userId), selected ? cachedGroupDetails(userId, selected) : null]).then(([list, details]) => {
      if (cancelled || shownFromServer.current) return;
      if (list) setGroups((current) => (current.length ? current : list));
      // Never opened online since details were kept: its name and settings from the saved list.
      const shown = details ?? (selected ? offlineGroupDetails(list?.find((item) => item.id === selected), userId) : null);
      if (shown) setGroup((current) => current ?? shown);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [selected, userId]);

  useEffect(() => {
    const controller = new AbortController();
    refresh(controller.signal).catch((caught) => {
      if (caught.name === 'AbortError') return;
      // Offline: what this device kept stays on screen; there is nothing to report until the network is back.
      if (isNetworkFailure(caught)) return;
      setError(caught.message);
    });
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
    if (!handleFrom(query) || (!creating && !settings)) { setResults([]); return undefined; }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      lookupUsername(token, query, { signal: controller.signal })
        .then((person) => setResults(person && person.id !== userId ? [person] : []))
        .catch((caught) => { if (caught.name !== 'AbortError') setError(caught.message); });
    }, 600);
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

  // { caption, quality ('standard' | 'hd'), document (send exactly as picked) } from the send preview.
  async function sendAttachment(file, { caption = '', quality = appSettings().get('media.uploadQuality'), document = false } = {}) {
    if (!file || !selected) return;
    setError('');
    setUploading(1);
    try {
      const prepared = document ? { blob: file, filename: file.name || 'attachment' } : await prepareForSend(file, file.name || 'attachment', quality);
      // A video carries its poster frame and length too (src/mediaThumb.js), from one decode of the picked file.
      const video = !document && (file.type || '').startsWith('video/') ? await videoPreview(file) : null;
      const thumb = document ? '' : prepared.thumb || video?.thumb || (video ? '' : await makeThumb(prepared.blob));
      const plain = prepared.blob instanceof File ? prepared.blob : new File([prepared.blob], prepared.filename, { type: prepared.blob.type });
      // Encrypted on this device before upload; the key travels in the end-to-end encrypted group message.
      const { upload, descriptor } = await sealForUpload(plain);
      const data = await uploadFile(upload, { groupId: selected, sessionToken: token, onProgress: (done, total) => setUploading(Math.max(1, Math.round((done / total) * 100))) });
      primeMediaBlob(data.id, token, plain); // our own bubble shows it from memory, not a re-download
      await groupRequest(token, `${groupPath}/messages`, { method: 'POST', body: { content: attachmentContent(data.id, descriptor ? prepared.filename || 'attachment' : data.filename || prepared.filename || 'attachment', descriptor) },
        extras: { ...(caption ? { caption } : {}), ...(thumb ? { thumb } : {}), ...(video?.poster ? { poster: video.poster } : {}), ...(video?.seconds ? { duration: video.seconds } : {}) } });
      await refresh(new AbortController().signal);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setUploading(0);
    }
  }

  // A voice note, as in a one-to-one chat: sealed on this device, uploaded to the group, its key inside the end-to-end
  // encrypted group message. Members see "recording audio…" while it is being recorded.
  async function sendVoiceNote(blob, seconds, type) {
    setRecordingVoice(false);
    activityRef.current?.recording(false);
    if (!blob || !selected) return;
    setError('');
    setUploading(1);
    try {
      const plain = new File([blob], `voice-note.${voiceExtension(type)}`, { type: blob.type || type });
      const { upload, descriptor } = await sealForUpload(plain);
      const data = await uploadFile(upload, { groupId: selected, sessionToken: token, kind: 'voice', onProgress: (done, total) => setUploading(Math.max(1, Math.round((done / total) * 100))) });
      primeMediaBlob(data.id, token, plain);
      await groupRequest(token, `${groupPath}/messages`, { method: 'POST', body: { content: voiceContent(data.id, seconds, { descriptor, lang: resolveVoiceLanguage(appSettings().get('chats.voiceLanguage')) }) } });
      await refresh(new AbortController().signal);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setUploading(0);
    }
  }
  // What the send preview hands back: each item with its own caption, one after another.
  async function sendPickedItems(items, { hd = false } = {}, documents = false) {
    for (const item of items) await sendAttachment(item.file, { caption: item.caption, quality: hd ? 'hd' : 'standard', document: documents });
  }
  function pickFiles(accept, capture) {
    const input = fileInputRef.current;
    if (!input) return;
    if (accept) input.accept = accept; else input.removeAttribute('accept');
    if (capture) input.setAttribute('capture', capture); else input.removeAttribute('capture');
    input.multiple = !capture;
    input.click();
  }
  // The same share sheet as a one-to-one chat, with what a group supports.
  function attachFrom(option) {
    setError('');
    if (option === 'document') { pickKindRef.current = 'document'; pickFiles(''); }
    else if (option === 'camera') setCameraOpen(true);
    else if (option === 'gallery') { pickKindRef.current = 'media'; pickFiles('image/*,video/*'); }
    else if (option === 'audio') pickFiles('audio/*');
    else if (option === 'poll' || option === 'event') setRichComposer(option);
    else if (option === 'sticker') setStickersOpen(true);
  }
  const startVoiceNote = () => {
    setError('');
    setStickersOpen(false);
    setRecordingVoice(true);
    activityRef.current?.recording(true);
  };

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
    onStartGroupCall?.({ mode, members: chosen, groupName: group.name, groupId: group.id });
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
    activityRef.current?.stop();
    // The box empties at once and stays focused, so the next message can be typed straight away (WhatsApp). Sends
    // are queued, so quick successive messages keep their order; a failed one comes back into an empty box.
    setDraft('');
    setCaret(0);
    setError('');
    const target = groupPath;
    sendQueueRef.current = sendQueueRef.current
      .then(() => groupRequest(token, `${target}/messages`, { method: 'POST', body: { content } }))
      .then(() => refresh(new AbortController().signal))
      .catch((caught) => { setError(caught.message); setDraft((current) => current || content); });
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
    setMemberSearchOpen(true);
    setTimeout(() => memberSearchRef.current?.focus(), 0);
  };

  // Share and QR use the group's invite link (admins only); the first use creates it.
  const ensureInvite = async () => group.inviteCode || (await resetInvite(token, group.id)).inviteCode;
  const shareGroup = () => perform(async () => {
    const link = inviteUrl(await ensureInvite());
    if (navigator.share) {
      try { await navigator.share({ title: group.name, text: `Join "${group.name}" on Hidden Messenger`, url: link }); } catch (caught) { if (caught?.name !== 'AbortError') throw caught; }
    } else {
      await navigator.clipboard.writeText(link);
      setNotice('Invite link copied.');
    }
  });
  const openGroupQr = () => perform(async () => { await ensureInvite(); setInfoSheet('qr'); });
  const saveMemberTag = () => perform(async () => {
    await groupRequest(token, `${groupPath}/members/me/tag`, { method: 'PUT', body: { tag: tagDraft ?? '' } });
    setTagDraft(null);
  });

  const inConversation = Boolean(group && !settings && !creating);
  const creator = group?.members.find((member) => member.id === group.createdBy);
  const sortedMembers = group ? [...group.members].sort((left, right) => (left.id === userId ? -1 : right.id === userId ? 1 : 0)) : [];
  const visibleMembers = sortedMembers.filter((member) => `${member.name} ${member.username}`.toLowerCase().includes(memberFilter.trim().toLowerCase()));

  // "Ava is typing…" in this group: my typing goes to the other members while the conversation is open (stopped when
  // it closes, the box empties or the message goes); theirs replaces the member list under the group name.
  const typingGroupId = inConversation && canSend ? selected : '';
  useEffect(() => {
    if (!typingGroupId) return undefined;
    const sender = createActivitySender((event) => client?.send?.(event), { groupId: typingGroupId });
    activityRef.current = sender;
    return () => {
      sender.stop();
      if (activityRef.current === sender) activityRef.current = null;
    };
  }, [typingGroupId, client]);
  const busyInGroup = useChatStore((state) => (selected ? state.groupTyping[selected] : undefined));
  const contactChats = useChatStore((state) => state.chats);
  const groupActivity = busyInGroup ? groupActivityLabel(groupActivityPeople(busyInGroup, (id) => contactChats.find((chat) => chat.id === id && !chat.deleted)?.name
    || group?.members.find((member) => member.id === id)?.name)) : '';
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
                {groupActivity
                  ? <small className="groups-activity" role="status">{groupActivity}</small>
                  : <small>{group.members.map((member) => (member.id === userId ? 'You' : member.name)).join(', ')}</small>}
              </span>
            </button>
          ) : settings && group && !creating ? (
            <span className="groups-info-header-tools">
              <button type="button" onClick={() => setInfoSheet('lists')} aria-label="Add to lists" title="Add to lists"><ListPlus size={22} /></button>
              {group.role === 'admin' && <button type="button" onClick={openGroupQr} disabled={busy} aria-label="Group QR code" title="Group QR code"><QrCode size={22} /></button>}
            </span>
          ) : <h2>{creating ? 'New group' : 'Groups'}</h2>}
          {inConversation && onStartGroupCall && (
            <span className="groups-call-menu-wrap">
              <button type="button" className="groups-call-trigger" onClick={() => setCallMenu((open) => !open)} aria-label="Call options" aria-expanded={callMenu}>
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
            <label>Add members by username<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Type the full @username" /></label>
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
              {group.description && <p className="groups-info-description">{group.description}</p>}
              <div className="groups-info-actions">
                {onStartGroupCall && (
                  <span className="groups-info-call">
                    <button type="button" onClick={() => setInfoCallMenu((open) => !open)} aria-expanded={infoCallMenu} aria-label="Call">
                      <span className="groups-info-action-icon"><Video size={22} /><ChevronDown size={13} /></span><span>Call</span>
                    </button>
                    {infoCallMenu && (
                      <ul className="groups-call-menu" role="menu" aria-label="Call options">
                        <li><button type="button" role="menuitem" onClick={() => { setInfoCallMenu(false); setCallPicker('audio'); }}><Phone size={18} /> Voice call</button></li>
                        <li><button type="button" role="menuitem" onClick={() => { setInfoCallMenu(false); setCallPicker('video'); }}><Video size={18} /> Video call</button></li>
                      </ul>
                    )}
                  </span>
                )}
                {group.role === 'admin' && <button type="button" onClick={shareGroup} disabled={busy}><span className="groups-info-action-icon"><Share2 size={22} /></span><span>Share</span></button>}
                <button type="button" onClick={openMemberSearch}><span className="groups-info-action-icon"><Search size={22} /></span><span>Search</span></button>
              </div>
            </div>
            <button type="button" className="groups-info-row" onClick={() => setInfoSheet('lists')}><ListPlus size={22} /><span>Add to lists</span></button>
            <div className="groups-tabs" role="tablist" aria-label="Group information">
              <button type="button" role="tab" aria-selected={infoTab === 'members'} onClick={() => { setInfoTab('members'); setQuery(''); }}>Members</button>
              <button type="button" role="tab" aria-selected={infoTab === 'media'} onClick={() => { setInfoTab('media'); setQuery(''); }}>Media</button>
              <button type="button" role="tab" aria-selected={infoTab === 'settings'} onClick={() => { setInfoTab('settings'); setQuery(''); }}>Settings</button>
            </div>

            {infoTab === 'members' && <div className="groups-tab-body">
              <div className="groups-members-head">
                <span>{group.members.length} {group.members.length === 1 ? 'member' : 'members'}</span>
                {memberSearchOpen || memberFilter ? (
                  <label className="groups-member-search">
                    <Search size={18} />
                    <input ref={memberSearchRef} value={memberFilter} onChange={(event) => setMemberFilter(event.target.value)} placeholder="Search members" aria-label="Search members" />
                    <button type="button" className="groups-icon-button" onClick={() => { setMemberFilter(''); setMemberSearchOpen(false); }} aria-label="Close member search"><X size={16} /></button>
                  </label>
                ) : <button type="button" className="groups-icon-button groups-members-search" onClick={openMemberSearch} aria-label="Search members"><Search size={21} /></button>}
              </div>
              {(group.role === 'admin' || group.membersCanAdd) && <>
                <button type="button" className="groups-add-row" onClick={() => setAddingMember((open) => !open)} aria-expanded={addingMember}>
                  <span className="groups-add-icon"><UserPlus size={22} /></span><strong>Add members</strong>
                </button>
                {addingMember && <label className="groups-add-member"><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Add member by username" aria-label="Add a member" autoFocus /></label>}
                {results.filter((person) => !group.members.some((item) => item.id === person.id)).map((person) => (
                  <button type="button" className="groups-row" key={person.id} disabled={busy} onClick={() => perform(async () => { await groupRequest(token, `${groupPath}/members`, { method: 'POST', body: { userId: person.id } }); setQuery(''); })}>
                    <Avatar {...person} size="small" /><span><strong>Add {person.name}</strong><small>@{person.username}</small></span>
                  </button>
                ))}
              </>}
              {visibleMembers.map((member) => (
                <div className="groups-member" key={member.id}>
                  {member.id === userId ? <Avatar {...member} /> : <button type="button" className="groups-member-photo" onClick={() => openPerson(member)} aria-label={`Message or call ${member.name}`}><Avatar {...member} /></button>}
                  <span>
                    {member.id === userId ? <strong>You</strong> : <button type="button" className="groups-member-name" onClick={() => openPerson(member)}><strong>{member.name}</strong></button>}
                    {member.id === userId ? (
                      tagDraft !== null ? (
                        <form className="groups-tag-form" onSubmit={(event) => { event.preventDefault(); saveMemberTag(); }}>
                          <input value={tagDraft} maxLength={MEMBER_TAG_MAX} onChange={(event) => setTagDraft(event.target.value)} placeholder="Member tag" aria-label="Your member tag in this group" autoFocus />
                          <button type="submit" disabled={busy} aria-label="Save member tag"><Check size={16} /></button>
                          <button type="button" onClick={() => setTagDraft(null)} aria-label="Cancel"><X size={16} /></button>
                        </form>
                      ) : (
                        <button type="button" className={`groups-member-tag ${member.tag ? 'has-tag' : ''}`} onClick={() => setTagDraft(member.tag ?? '')}>
                          {member.tag || 'Add member tag'}
                        </button>
                      )
                    ) : <small className={member.tag ? 'groups-member-tag-text' : ''}>{member.tag || `@${member.username}`}</small>}
                  </span>
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
              <SettingsRow icon={LockKeyhole} title="Encryption" detail="Messages and attachments are end-to-end encrypted with group sender keys; the server stores only ciphertext. Calls are end-to-end encrypted too: up to 4 people connect directly, larger calls go through a media server that cannot see or hear them." />
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
              {/* WhatsApp's "Exit group": a dialog naming the group, then out (the last admin hands over first). */}
              <SettingsRow icon={LogOut} title="Exit group" danger onClick={() => setConfirming('leave')} />
              {confirming === 'leave' && (
                <>
                  <div className="groups-sheet-scrim" onClick={() => setConfirming('')} aria-hidden="true" />
                  <div className="groups-exit-dialog" role="alertdialog" aria-modal="true" aria-labelledby="groups-exit-title">
                    <h3 id="groups-exit-title">Exit “{group.name}”?</h3>
                    <p>{group.role === 'admin' && !group.members.some((member) => member.role === 'admin' && member.id !== userId)
                      ? 'You are the only admin, so the longest-standing member becomes admin. You will stop getting this group’s messages.'
                      : 'You will stop getting this group’s messages. The group and its members stay.'}</p>
                    <div className="groups-exit-actions">
                      <button type="button" disabled={busy} onClick={() => setConfirming('')}>Cancel</button>
                      <button type="button" className="groups-danger" disabled={busy} onClick={() => perform(() => groupRequest(token, `${groupPath}/membership`, { method: 'DELETE' }))}>Exit group</button>
                    </div>
                  </div>
                </>
              )}
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
              {messages.length === 0 && !pendingMessages.length && <p className="groups-day">No messages yet. Say hi 👋</p>}
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
                const voice = !isMedia ? parseVoiceContent(message.content) : null;
                const active = activeMessageId === message.id;
                const mediaShown = isMedia && !relayCard && !scheduled && !message.e2eError;
                // The time (and pin, star, Edited, delete): on a photo or video it sits on the media's corner, as on WhatsApp.
                const meta = (
                  <span className="groups-message-meta">
                    {canDelete && <button type="button" disabled={busy} aria-label="Delete message" title="Delete message" onClick={() => perform(() => groupRequest(token, `${groupPath}/messages/${encodeURIComponent(message.id)}`, { method: 'DELETE' }))}><Trash2 size={13} /></button>}
                    {message.expiresAt && <Timer size={12} aria-label="Disappears after 24 hours" />}
                    {pinnedIds.has(message.id) && <Pin size={12} aria-label="Pinned" />}
                    {starred[message.id] && <Star size={12} fill="currentColor" aria-label="Starred" />}
                    {message.editedAt && <span className="message-edited">Edited</span>}
                    <time dateTime={new Date(message.createdAt).toISOString()}>{formatTime(message.createdAt)}</time>
                  </span>
                );
                return (
                  <div className={`groups-message-row ${mine ? 'mine' : 'theirs'}${active ? ' is-active' : ''}`} key={item.key} data-group-message-id={message.id}>
                    {!mine && (sender ? <button type="button" className="groups-sender-photo" onClick={() => openPerson(sender)} aria-label={`Message or call ${sender.name}`}><Avatar {...sender} size="small" /></button> : <span className="groups-avatar groups-avatar-small" aria-hidden="true" />)}
                    <article tabIndex={0} className={`groups-message ${mine ? 'mine' : 'theirs'} ${isMedia ? 'has-media' : ''} ${scheduled ? 'is-scheduled' : ''} ${sticker ? 'is-sticker' : ''}`}
                      onClick={(clickEvent) => { if (!clickEvent.target.closest('button, a, input, audio, video')) setActiveMessageId(active ? '' : message.id); }}
                      onKeyDown={(keyEvent) => { if (keyEvent.key === 'Enter' && keyEvent.target === keyEvent.currentTarget) setActiveMessageId(active ? '' : message.id); }}>
                      {!mine && (sender
                        ? <button type="button" className="groups-sender" style={{ color: senderColor(message.senderId) }} onClick={() => openPerson(sender)}>{sender.name}</button>
                        : <strong className="groups-sender" style={{ color: senderColor(message.senderId) }}>{group.offline ? 'Member' : 'Former member'}</strong>)}
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
                        : voice?.id ? <VoiceMessage id={voice.id} seconds={voice.seconds} lang={voice.lang} sessionToken={token} sender={sender ?? group.members.find((member) => member.id === message.senderId)} played />
                        : isMedia ? <MediaRenderer mediaRef={message.content} sessionToken={token} meta={meta} caption={message.caption} thumb={message.thumb} poster={message.poster} duration={message.duration} />
                        : poll ? <PollBubble messageId={message.id} poll={poll} sessionToken={token} userId={userId} nameFor={(id) => group.members.find((member) => member.id === id)?.name} context={{ groupId: selected }} />
                        : event ? <EventBubble messageId={message.id} event={event} />
                        : sticker ? <StickerMessage content={message.content} />
                        : productId ? <ProductCard itemId={productId} sessionToken={token} />
                        : <p><MentionText text={message.content} usernames={usernames} ownUsername={ownUsername} /></p>}
                      {!mediaShown && meta}
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
                  <article className={`groups-message mine is-waiting${isMediaContent(entry.content) ? ' has-media' : ''}`}>
                    <PendingGroupBody content={entry.content} token={token} self={group.members.find((member) => member.id === userId)} />
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
            {stickersOpen && !editing && <StickerPalette token={token} onPick={(key) => { setStickersOpen(false); sendText(stickerContent(key)); }}
              onGif={async (file) => { setStickersOpen(false); await sendAttachment(file); }} />}
            {groupSecurity && !groupSecurity.encrypted && (
              <p className="e2e-warning is-waiting" role="status">🔒 {groupSecurity.missing.length === 1 ? '1 member hasn’t' : `${groupSecurity.missing.length} members haven’t`} opened an updated Hidden Messenger yet. Messages to this group <strong>wait on your phone</strong> and go out end-to-end encrypted as soon as they do.</p>
            )}
            {recordingVoice ? (
              <div className="groups-recorder"><VoiceRecorderBar onSend={sendVoiceNote} onCancel={() => { setRecordingVoice(false); activityRef.current?.recording(false); }} onError={(message) => { setRecordingVoice(false); activityRef.current?.recording(false); setError(message); }} /></div>
            ) : (
            <form className="groups-compose" onSubmit={(event) => { event.preventDefault(); submitDraft(); }}>
              <input ref={fileInputRef} type="file" hidden onChange={(event) => {
                const files = [...(event.target.files ?? [])];
                event.target.value = '';
                if (!files.length) return;
                // The send preview, as in a one-to-one chat; "+" there adds to it.
                if (groupComposer) setGroupComposerAdded((current) => ({ version: (current?.version ?? 0) + 1, files }));
                else setGroupComposer({ files, documents: pickKindRef.current === 'document' });
              }} />
              <span className="groups-compose-field">
                {!editing && <button type="button" className="groups-attach groups-emoji" onClick={() => setStickersOpen((open) => !open)} disabled={busy} aria-label="Stickers" aria-expanded={stickersOpen} title="Stickers"><Smile size={20} /></button>}
                <input ref={draftRef} aria-label="Group message" value={draft} maxLength={10000}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    setCaret(event.target.selectionStart ?? event.target.value.length);
                    if (editing) return;
                    if (event.target.value) activityRef.current?.typed(); else activityRef.current?.stop();
                  }}
                  onSelect={(event) => setCaret(event.target.selectionStart ?? 0)}
                  placeholder={uploading ? `Uploading… ${uploading}%` : editing ? 'Edit message' : 'Message'} />
                <button type="button" className="groups-attach" onClick={() => { setStickersOpen(false); setAttachOpen(true); }} disabled={busy || uploading > 0} aria-label="Attach" title="Document, camera, gallery, audio, poll, event">
                  <Paperclip size={20} />
                </button>
                {!draft.trim() && <button type="button" className="groups-attach" onClick={() => setCameraOpen(true)} disabled={busy || uploading > 0} aria-label="Camera" title="Camera"><Camera size={20} /></button>}
              </span>
              {!editing && !draft.trim()
                ? <button type="button" className="groups-send groups-mic" onClick={startVoiceNote} disabled={busy || uploading > 0} aria-label="Record voice note" title="Record a voice note"><Mic size={20} /></button>
                : <button type="submit" className="groups-send" onMouseDown={keepKeyboard} disabled={!draft.trim()} aria-label={editing ? 'Save edit' : 'Send'}>{editing ? <Check size={20} /> : <SendHorizontal size={20} />}</button>}
            </form>
            )}
            </>)}
          </>
        )}
        {cameraOpen && selected && (
          <CameraCapture onClose={() => setCameraOpen(false)}
            onGallery={() => { setCameraOpen(false); pickFiles('image/*,video/*'); }}
            onUnavailable={() => { setCameraOpen(false); setError('The camera isn’t available. Allow camera access for Hidden Messenger, or pick from the gallery.'); }}
            onSend={async (file, caption) => { setCameraOpen(false); await sendAttachment(file, { caption }); }} />
        )}
        {groupComposer && selected && (
          <MediaComposer files={groupComposer.files} added={groupComposerAdded} recipient={group?.name ?? 'this group'}
            quality={appSettings().get('media.uploadQuality')} asDocuments={groupComposer.documents} allowViewOnce={false}
            onAddMore={() => pickFiles(groupComposer.documents ? '' : 'image/*,video/*')}
            onClose={() => { setGroupComposer(null); setGroupComposerAdded(null); }}
            onSend={(items, options) => { const documents = groupComposer.documents; setGroupComposer(null); setGroupComposerAdded(null); sendPickedItems(items, options, documents); }} />
        )}
        <AttachmentMenu isOpen={attachOpen} options={GROUP_ATTACH_OPTIONS} onSelect={attachFrom} onClose={() => setAttachOpen(false)} />
        {joinCode && <JoinGroupSheet code={joinCode} token={token} onClose={() => setJoinCode('')} onJoined={(groupId) => { setJoinCode(''); setSelected(groupId); }} />}
        {group && callPicker && <CallPeoplePicker members={group.members} userId={userId} mode={callPicker} busy={busy} onStart={startCall} onClose={() => setCallPicker('')} />}
        {infoSheet === 'lists' && group && <GroupListsSheet groupKey={`group:${group.id}`} onClose={() => setInfoSheet('')} />}
        {personSheet && <MemberSheet member={personSheet} group={group} userId={userId} token={token} onMessage={onMessagePerson} onCall={onCallPerson}
          onChanged={(notice) => { setNotice(notice); refresh(new AbortController().signal); }} onClose={() => setPersonSheet(null)} />}
        {infoSheet === 'qr' && group?.inviteCode && <GroupQrSheet group={group} onShare={shareGroup} onClose={() => setInfoSheet('')} />}
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
