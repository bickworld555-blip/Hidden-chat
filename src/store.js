import { nativeShell } from './native.js';
import { acknowledgeSaved } from './deliveryAck.js';
import { pollSummary } from './polls.js';
import { eventSummary } from './calendarEvents.js';
import { create } from 'zustand';
// Everything this device stores about the account is encrypted at rest (src/secureStorage.js).
import { secureDel as del, secureGet as get, secureSet as set, secureStorage } from './secureStorage.js';
import { createMessageDb, diffMessages, MESSAGE_WINDOW, snapshotOf } from './messageDb.js';
import { endBlock, hiddenByBlock, startBlock } from './blocking.js';
import { reconcileBlocks, setBlocked } from './blocksApi.js';
import { mediaPreviewLabel } from './media.js';
import { haversineDistance, isLiveExpired, parseContact, parseLocation, shouldSendLiveUpdate } from './geo.js';
import { mergeMessageStatus } from './messageStatus.js';
import { formatChatListTime } from './time.js';
import { splitLinks } from './contactBook.js';
import { scheduledCallPreview } from './groupChat.js';
import { stickerPreview } from './stickers.js';
import { onCloudStars, toggleStar as toggleCloudStar, uploadLocalStars } from './accountData.js';
import { transmitDirect } from './e2e/messaging.js';
import { isNotice } from './e2e/notices.js';
import { extrasPreview } from './mediaExtras.js';
import { orderPreview } from './orders.js';
import { ACTIVITY_EXPIRES_MS } from './typing.js';

const EMPTY_MESSAGES = Object.freeze([]);
const typingExpiry = new Map();

// A message deleted for everyone keeps its place, sender and time, but nothing of what it said.
function deletedPlaceholder(message) {
  const { replyTo: _replyTo, reactions: _reactions, starred: _starred, forwarded: _forwarded, played: _played, ...rest } = message;
  return { ...rest, content: '', deleted: true };
}

// Starred message ids from the account (null until loaded: then the device's own flags are kept).
let cloudStars = null;
const withCloudStar = (message) => (cloudStars && message?.id && Boolean(cloudStars[message.id]) !== Boolean(message.starred)
  ? { ...message, starred: Boolean(cloudStars[message.id]) } : message);

function mergeMessage(current, incoming) {
  if (!current) return withCloudStar(incoming);
  const merged = { ...current, ...incoming, status: mergeMessageStatus(current.status, incoming.status) };
  // Once played, a voice note stays played (a stale copy of the history must not turn it green again).
  if (current.played || incoming.played) merged.played = true;
  return withCloudStar(merged);
}

const PERSIST_DELAY_MS = 400;
let persistTimer = null;
let pendingPersistUser = null;

// Messages live one row each in IndexedDB (src/messageDb.js), each sealed at rest. A save writes only what changed
// since the last save (`saved` is that copy); chats cleared meanwhile are dropped whole, older rows included.
let messageDb = null;
const indexedMessageStore = () => createMessageDb({ seal: (name, value) => secureStorage().seal(name, value), open: (name, record) => secureStorage().open(name, record) });
const messageStore = () => (messageDb ??= nativeShell() ? localFirstStore(indexedMessageStore()) : indexedMessageStore());

/**
 * The Android app keeps its history in native SQLite encrypted with SQLCipher (src/sqliteMessageDb.js), the source
 * of truth now that the server keeps messages only until delivered. The first time, everything saved in the old
 * IndexedDB store is copied over. Should SQLite be unavailable, the IndexedDB store keeps working.
 */
function localFirstStore(indexed) {
  let sqlite = null;
  let failed = false;
  const migrated = new Map();
  async function pick(owner) {
    if (failed) return indexed;
    try {
      sqlite ??= (await import('./sqliteMessageDb.js')).createSqliteMessageDb();
      if (!migrated.has(owner)) {
        migrated.set(owner, (async () => {
          if ((await sqlite.count(owner)) > 0 || (await indexed.count(owner)) === 0) return;
          const all = await indexed.loadAll(owner);
          const puts = Object.entries(all).flatMap(([chat, list]) => list.map((message) => ({ chat, message })));
          for (let start = 0; start < puts.length; start += 500) await sqlite.apply(owner, { puts: puts.slice(start, start + 500) });
        })());
      }
      await migrated.get(owner);
      storeKind = 'sqlite';
      return sqlite;
    } catch (error) {
      console.error('Local SQLite store unavailable; using IndexedDB:', error);
      failed = true;
      storeKind = 'indexeddb-fallback';
      storeError = String(error?.message ?? error).slice(0, 160);
      return indexed;
    }
  }
  return {
    apply: async (owner, diff) => (await pick(owner)).apply(owner, diff),
    loadRecent: async (owner, limit) => (await pick(owner)).loadRecent(owner, limit),
    loadOlder: async (owner, chat, beforeTs, limit) => (await pick(owner)).loadOlder(owner, chat, beforeTs, limit),
    loadAll: async (owner) => (await pick(owner)).loadAll(owner),
    count: async (owner) => (await pick(owner)).count(owner),
    search: async (owner, query, limit) => {
      const store = await pick(owner);
      return store.search ? store.search(owner, query, limit) : null;
    },
    close() {},
  };
}

let storeKind = null;
let storeError = '';
/**
 * Which local store holds this account's history and how many messages it has: 'sqlite' (the phone's encrypted
 * SQLite), 'indexeddb' (the web app) or 'indexeddb-fallback' (the phone, SQLite unavailable; `error` says why).
 */
export async function localStoreStatus(userId) {
  const messages = await savedMessageCount(userId);
  const kind = nativeShell() ? storeKind ?? 'sqlite' : 'indexeddb';
  // On the phone: whether search uses the full-text index, and attachments kept in the app's private folder
  // (files on disk next to the records that hold their path, checksum and key).
  let facts = null;
  if (kind === 'sqlite') {
    try {
      const [{ localStoreFacts }, { storedMediaFileCount }] = await Promise.all([import('./sqliteMessageDb.js'), import('./mediaVault.js')]);
      facts = { ...(await localStoreFacts()), mediaFiles: await storedMediaFileCount() };
    } catch { facts = null; }
  }
  return { kind, messages, error: storeError, ...facts };
}

/** Saved messages matching a search, newest first, from the device's own store (null where it has no index). */
export async function searchSavedMessages(userId, query, limit = 200) {
  const store = messageStore();
  return store.search ? store.search(userId, query, limit) : null;
}
let saved = { owner: null, chats: new Map() };
const clearedChats = new Set();
let persistChain = Promise.resolve();

/** How many messages this device has saved for the account (0 on a new or reset device). */
export async function savedMessageCount(userId) {
  try {
    return Number(await messageStore().count(userId)) || 0;
  } catch {
    return 0;
  }
}

/**
 * Every message saved on this device for this account (not only the window held in memory), with anything not yet
 * written included: what a full backup contains.
 */
export async function loadAllSavedMessages(userId) {
  await flushPersistedMessages();
  const saved = await messageStore().loadAll(userId);
  const current = useChatStore.getState().messages;
  for (const [chat, list] of Object.entries(current)) {
    const byId = new Map((saved[chat] ?? []).map((message) => [message.id, message]));
    for (const message of list ?? []) if (message?.id) byId.set(message.id, message);
    saved[chat] = [...byId.values()].sort((left, right) => String(left.timestamp).localeCompare(String(right.timestamp)));
  }
  return saved;
}

/** For tests: use another message store (e.g. over fake-indexeddb). */
export function setMessageDbForTesting(db) {
  messageDb = db;
  saved = { owner: null, chats: new Map() };
}

export function flushPersistedMessages() {
  clearTimeout(persistTimer);
  persistTimer = null;
  const userId = pendingPersistUser;
  pendingPersistUser = null;
  persistChain = persistChain.then(async () => {
    const state = useChatStore.getState();
    if (!userId || userId !== state.userId || saved.owner !== userId) return;
    const current = state.messages;
    const cleared = new Set(clearedChats);
    clearedChats.clear();
    try {
      const diff = diffMessages(saved.chats, current, cleared);
      await messageStore().apply(userId, diff);
      if (saved.owner === userId) saved = { owner: userId, chats: snapshotOf(current) };
      // Saved here: the server may now delete them once every device has its copy (src/deliveryAck.js).
      if (diff.puts.length > 0) {
        const latest = useChatStore.getState();
        acknowledgeSaved(diff.puts.map((put) => put.message), { client: latest.client, sessionToken: latest.sessionToken })
          .catch((error) => console.error('Could not acknowledge saved messages:', error));
      }
    } catch (error) {
      for (const chat of cleared) clearedChats.add(chat);
      console.error('Could not save messages:', error);
    }
  });
  return persistChain;
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && persistTimer) flushPersistedMessages(); });
}

export function previewFor(content) {
  if (typeof content !== 'string') return '';
  if (content.startsWith('voice-opened:')) return '① Opened';
  if (content.startsWith('voice:')) return content.endsWith(':once') ? '① Voice message' : '🎤 Voice message';
  // End-to-end encrypted content this device could not open (src/e2e/): never show ciphertext.
  if (content.startsWith('e2e1:') || content.startsWith('e2e2:')) return '🔒 Message';
  if (isNotice(content)) return '🔒 Security code changed';
  const extra = extrasPreview(content) ?? orderPreview(content);
  if (extra) return extra;
  if (content.startsWith('emedia:')) return mediaPreviewLabel(`media:x:${content.split(':').slice(3).join(':')}`);
  if (content.startsWith('poll:')) return pollSummary(content) ?? '📊 Poll';
  if (content.startsWith('relaycall:')) return content.includes('"mode":"video"') ? '📹 Group video call' : '📞 Group voice call';
  if (content.startsWith('event:')) return eventSummary(content) ?? '📅 Event';
  if (content.startsWith('media:')) return mediaPreviewLabel(content);
  if (content.startsWith('file:')) return '📎 Attachment';
  if (content.startsWith('location:')) return `📍 ${parseLocation(content)?.name || 'Location'}`;
  if (content.startsWith('live:')) return '📍 Live location';
  const scheduled = scheduledCallPreview(content);
  if (scheduled) return scheduled;
  if (content.startsWith('contact:')) return `👤 ${parseContact(content)?.name || 'Contact'}`;
  if (content.startsWith('sticker:')) return stickerPreview(content);
  if (content.startsWith('product:')) return '🛍️ Product';
  if (content.startsWith('call:')) {
    try {
      return JSON.parse(content.slice(5))?.mode === 'video' ? '📹 Video call' : '📞 Voice call';
    } catch {
      return '📞 Call';
    }
  }
  return content;
}

// Notification text: like the chat-list preview, with what a notification needs to say on its own (WhatsApp:
// "🎤 Voice message (0:12)", "🎵 Audio", "🎞️ GIF"). Kept in step with MessagePreview.java (background service).
export function notificationPreview(content) {
  if (typeof content !== 'string') return '';
  if (content.startsWith('voice:') && !content.endsWith(':once')) {
    const seconds = Number(content.split(':')[2]);
    if (!Number.isFinite(seconds) || seconds <= 0) return '🎤 Voice message';
    const whole = Math.round(seconds);
    return `🎤 Voice message (${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')})`;
  }
  if (content.startsWith('media:')) {
    const extension = (content.split(':').slice(2).join(':').split('.').pop() || '').toLowerCase();
    if (extension === 'gif') return '🎞️ GIF';
    if (AUDIO_NOTIFICATION_EXTENSIONS.has(extension)) return '🎵 Audio';
  }
  return previewFor(content);
}
const AUDIO_NOTIFICATION_EXTENSIONS = new Set(['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac', 'weba']);

function activityTime(chat) {
  const time = Date.parse(chat?.lastActivityAt ?? '');
  return Number.isFinite(time) ? time : null;
}

// Most recent activity first; chats without known activity keep their relative order after the active ones.
export function orderChatsByActivity(chats) {
  return [...chats].sort((left, right) => {
    const leftTime = activityTime(left);
    const rightTime = activityTime(right);
    if (leftTime === rightTime) return 0;
    if (leftTime === null) return 1;
    if (rightTime === null) return -1;
    return rightTime - leftTime;
  });
}

// The chat-list summary (preview, time, ordering key) is derived from the conversation's newest message.
// "📷 4 photos" when the newest messages are a run of photos (or videos) from the same person, like WhatsApp.
export function chatPreview(messages) {
  const last = messages?.length ? messages[messages.length - 1] : null;
  if (!last) return '';
  const label = previewFor(last.content);
  const plural = label === '📷 Photo' ? 'photos' : label === '🎥 Video' ? 'videos' : null;
  if (!plural) return label;
  let run = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.senderId !== last.senderId || previewFor(message.content) !== label) break;
    run += 1;
  }
  return run > 1 ? `${label.split(' ')[0]} ${run} ${plural}` : label;
}

// Messages from this person that I have not read yet (the server's read state is the source of truth).
export function unreadFrom(messages, peerId, userId) {
  return (messages ?? []).filter((message) => message.senderId === peerId && message.receiverId === userId
    && message.status !== 'read' && !message.deleted && !String(message.content ?? '').startsWith('call:')).length;
}

const pageVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

// Ring around a contact's photo in the chat list: green while they have a status I have not seen, grey once seen.
export function statusRingsFrom(feed) {
  const rings = {};
  for (const entry of feed?.others ?? []) {
    if (entry?.user?.id && entry.statuses?.length) rings[entry.user.id] = entry.allSeen ? 'seen' : 'new';
  }
  return rings;
}

// What a message deleted for everyone reads as, in the chat and in the chat list (WhatsApp's wording).
export function deletedLabel(mine) {
  return mine ? 'You deleted this message' : 'This message was deleted';
}

function summarizeChat(chat, messages) {
  const last = messages?.length ? messages[messages.length - 1] : null;
  if (!last) return chat;
  const preview = last.deleted ? `🚫 ${deletedLabel(last.senderId !== chat.id)}` : chatPreview(messages);
  return { ...chat, preview, time: formatChatListTime(last.timestamp), lastActivityAt: last.timestamp };
}

// Re-derives a chat's summary after messages were removed; an emptied chat keeps its place in the list.
function resummarizeChat(chat, messages) {
  return messages.length ? summarizeChat(chat, messages) : { ...chat, preview: 'No messages yet', time: '' };
}

// Per-user chat preferences that stay on this device.
const PREFERENCES = {
  pinnedChatIds: 'pinned',
  mutedChatIds: 'muted',
  favouriteChatIds: 'favourites',
  blockedChats: 'blocked',
  chatThemes: 'themes',
  // Locked chats (src/chatLock.js): row keys (peer id or "group:<id>"), kept on this device.
  lockedChatIds: 'locked',
  // Custom chat lists ("Customers", "VIP"…): { [listId]: { name, keys: [peer id or "group:<id>"], createdAt } }.
  chatLists: 'lists',
};

function toggleId(ids, id) {
  return ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];
}

// One geolocation watch serves every active live session; it starts with the first and stops with the last.
let liveWatchId = null;

function stopLiveTracking() {
  if (liveWatchId !== null && typeof navigator !== 'undefined') navigator.geolocation?.clearWatch(liveWatchId);
  liveWatchId = null;
}

function ensureLiveTracking(send) {
  const active = Object.values(useChatStore.getState().liveSessions).some((session) => session.status === 'active');
  if (!active) return stopLiveTracking();
  if (liveWatchId !== null || typeof navigator === 'undefined' || !navigator.geolocation?.watchPosition) return;
  liveWatchId = navigator.geolocation.watchPosition(
    (position) => useChatStore.getState().recordOwnPosition({ lat: position.coords.latitude, lon: position.coords.longitude, accuracy: position.coords.accuracy }, send),
    () => { /* keep the session; the peer still sees our last fix */ },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 20_000 },
  );
}

// Chats read on screen before the connection was up (see setClient).
const readsWithoutConnection = new Set();

export const useChatStore = create((setState, getState) => ({
  userId: '',
  user: null,
  // Bumped on every status:* event so the Updates tab re-reads the feed.
  statusRevision: 0,
  bumpStatusRevision() { setState((state) => ({ statusRevision: (state.statusRevision ?? 0) + 1 })); },
  // userId → 'new' (a status I have not seen: green ring) or 'seen' (grey ring), from the statuses feed.
  statusRings: {},
  setStatusRings(feed) { setState({ statusRings: statusRingsFrom(feed) }); },
  device: null,
  sessionToken: null,
  activeChatId: null,
  chats: [],
  // Saved contacts whose thread was deleted from the chat list; they stay available in the contact picker.
  hiddenContacts: [],
  messages: {},
  messageJump: null,
  chatLists: {},
  callLogs: [],
  pinnedChatIds: [],
  mutedChatIds: [],
  favouriteChatIds: [],
  lockedChatIds: [],
  blockedChats: {},
  chatThemes: {},
  presence: {},
  // userId → when they were last online (ms), for "last seen …"; null while online or when their privacy hides it.
  lastSeen: {},
  // Poll message id → { [optionIndex]: [userId, …] }, filled on first view and kept live by poll:votes events.
  pollVotes: {},
  typing: {},
  connection: 'connecting',
  // Live location sessions (ephemeral, keyed by session id). `me`/`peer` hold the latest fixes.
  liveSessions: {},
  setUserId(userId) {
    // Activating the account that is already active (a new session for it) keeps what is loaded: clearing it would
    // leave chats empty, since loading from this device runs only when the account changes.
    if (userId && userId === getState().userId) return;
    stopLiveTracking();
    saved = { owner: null, chats: new Map() };
    clearedChats.clear();
    setState((state) => ({
      userId,
      activeChatId: null,
      messages: {},
      callLogs: [],
      liveSessions: {},
      statusRings: {},
      user: userId ? state.user : null,
      sessionToken: userId ? state.sessionToken : null,
      chats: [],
      hiddenContacts: [],
      ...Object.fromEntries(Object.keys(PREFERENCES).map((name) => [name, Array.isArray(state[name]) ? [] : {}])),
    }));
  },
  setSession(session) {
    setState({ user: session.user, device: { id: session.deviceId, name: session.deviceName }, sessionToken: session.token });
  },
  // A profile change (photo, name) from the server: refresh ourselves and the chat row for that person.
  updateUserProfile(user) {
    if (!user?.id) return;
    const fields = { name: user.name, username: user.username, initials: user.initials, color: user.color, avatar: user.avatar ?? null };
    setState((state) => ({
      user: state.user?.id === user.id ? { ...state.user, ...fields } : state.user,
      chats: state.chats.map((chat) => (chat.id === user.id ? { ...chat, ...fields } : chat)),
      hiddenContacts: state.hiddenContacts.map((chat) => (chat.id === user.id ? { ...chat, ...fields } : chat)),
    }));
    if (getState().userId && getState().chats.some((chat) => chat.id === user.id)) getState().persistContacts(getState().userId);
  },
  setActiveChat(activeChatId) {
    setState((state) => ({
      activeChatId,
      chats: state.chats.map((chat) => chat.id === activeChatId ? { ...chat, unread: 0 } : chat),
    }));
  },
  setContacts(links) {
    const { chats: contacts, hiddenContacts } = splitLinks(links);
    setState((state) => {
      const current = new Map(state.chats.map((chat) => [chat.id, chat]));
      const chats = orderChatsByActivity(contacts.map((contact) => summarizeChat({
        ...contact,
        preview: current.get(contact.id)?.preview ?? contact.preview ?? 'Start a conversation',
        time: current.get(contact.id)?.time ?? contact.time ?? '',
        lastActivityAt: current.get(contact.id)?.lastActivityAt ?? contact.lastActivityAt,
        unread: current.get(contact.id)?.unread ?? 0,
        online: state.presence[contact.id] === 'online',
      }, state.messages[contact.id])));
      return {
        chats,
        hiddenContacts,
        activeChatId: chats.some((chat) => chat.id === state.activeChatId)
          ? state.activeChatId
          : chats[0]?.id ?? null,
      };
    });
  },
  // Opens a thread with someone: a server link (with its `saved` flag) or a peer learned from a message/call.
  addContact(contact) {
    setState((state) => {
      const messages = state.messages[contact.id] ? state.messages : { ...state.messages, [contact.id]: EMPTY_MESSAGES };
      const { hidden, ...link } = contact;
      const hiddenContacts = state.hiddenContacts.filter((item) => item.id !== link.id);
      if (state.chats.some((chat) => chat.id === link.id)) {
        return {
          activeChatId: link.id,
          messages,
          hiddenContacts,
          chats: state.chats.map((chat) => chat.id === link.id ? { ...chat, saved: chat.saved === true || link.saved === true } : chat),
        };
      }
      return {
        chats: [{ ...link, preview: 'Start a conversation', time: '', lastActivityAt: new Date().toISOString(), unread: 0, online: state.presence[link.id] === 'online' }, ...state.chats],
        activeChatId: link.id,
        messages,
        hiddenContacts,
      };
    });
    return getState().persistContacts(getState().userId);
  },
  setConnection(connection) { setState({ connection }); },
  // The realtime client, so views without a prop (e.g. the home camera shortcut) can send a message.
  client: null,
  setClient(client) {
    setState({ client });
    // Chats read while there was no connection: their blue ticks go now, so the server's unread state (which the
    // badge is rebuilt from on the next history load) matches what was seen.
    if (client?.send && readsWithoutConnection.size > 0) {
      const chatIds = [...readsWithoutConnection];
      readsWithoutConnection.clear();
      for (const chatId of chatIds) getState().readChat(chatId);
    }
  },
  sendMessage(receiverId, content, extras = {}) {
    const { userId, client } = getState();
    if (!receiverId || !userId || !content) return null;
    const message = { id: crypto.randomUUID(), senderId: userId, receiverId, timestamp: new Date().toISOString(), content, status: 'sent', ...extras };
    getState().addMessage(message);
    getState().queueMessage(message);
    // Sealed per device before it leaves (src/e2e/messaging.js); the outbox resends it after a failure.
    transmitDirect(client, { id: message.id, receiverId, content, ...extras })
      .then((accepted) => { if (accepted === false) getState().updateMessage(message.id, { status: 'failed' }); });
    return message;
  },

  // --- Live location -------------------------------------------------------------------------------

  // Records a session we started (status 'requested' until the peer accepts).
  startLiveSession({ sessionId, peerId, durationMs, startedAt }) {
    setState((state) => ({
      liveSessions: { ...state.liveSessions, [sessionId]: { sessionId, peerId, initiator: true, status: 'requested', startedAt, durationMs, me: null, peer: null, endReason: null } },
    }));
  },

  // Applies a relayed `location:live` event from the server. `send` posts our own actions back.
  applyLiveEvent(event, send) {
    const { action, sessionId } = event;
    const state = getState();
    const existing = state.liveSessions[sessionId];
    if (action === 'request') {
      if (existing) return;
      setState({ liveSessions: { ...state.liveSessions, [sessionId]: { sessionId, peerId: event.from, initiator: false, status: 'requested', startedAt: event.startedAt, durationMs: event.durationMs, me: null, peer: null, endReason: null } } });
      return;
    }
    if (!existing) return;
    if (action === 'accept') {
      setState({ liveSessions: { ...state.liveSessions, [sessionId]: { ...existing, status: 'active' } } });
      ensureLiveTracking(send);
      return;
    }
    if (action === 'update') {
      const fix = { lat: event.lat, lon: event.lon, accuracy: event.accuracy ?? null, at: event.at ?? Date.now() };
      setState({ liveSessions: { ...state.liveSessions, [sessionId]: { ...existing, peer: fix } } });
      return;
    }
    if (action === 'stop') {
      setState({ liveSessions: { ...state.liveSessions, [sessionId]: { ...existing, status: event.reason === 'declined' ? 'declined' : 'ended', endReason: event.reason ?? 'stopped' } } });
      ensureLiveTracking(send);
    }
  },

  acceptLiveSession(sessionId, send) {
    const session = getState().liveSessions[sessionId];
    if (!session || session.status !== 'requested' || session.initiator) return;
    send({ type: 'location:live', action: 'accept', sessionId, peerId: session.peerId });
    setState((state) => ({ liveSessions: { ...state.liveSessions, [sessionId]: { ...session, status: 'active' } } }));
    ensureLiveTracking(send);
  },

  declineLiveSession(sessionId, send) {
    const session = getState().liveSessions[sessionId];
    if (!session) return;
    send({ type: 'location:live', action: 'decline', sessionId, peerId: session.peerId });
    setState((state) => ({ liveSessions: { ...state.liveSessions, [sessionId]: { ...session, status: 'declined', endReason: 'declined' } } }));
  },

  stopLiveSession(sessionId, send) {
    const session = getState().liveSessions[sessionId];
    if (!session || session.status === 'ended' || session.status === 'declined') return;
    send({ type: 'location:live', action: 'stop', sessionId, peerId: session.peerId });
    setState((state) => ({ liveSessions: { ...state.liveSessions, [sessionId]: { ...session, status: 'ended', endReason: 'stopped' } } }));
    ensureLiveTracking(send);
  },

  // Our own fix: remembered per active session and relayed when it is worth sending.
  recordOwnPosition(fix, send) {
    const now = Date.now();
    const sessions = getState().liveSessions;
    const next = {};
    let changed = false;
    for (const [sessionId, session] of Object.entries(sessions)) {
      if (session.status !== 'active') continue;
      if (isLiveExpired(session, now)) {
        next[sessionId] = { ...session, status: 'ended', endReason: 'expired' };
        changed = true;
        continue;
      }
      if (!shouldSendLiveUpdate(session.me, fix, now)) continue;
      send({ type: 'location:live', action: 'update', sessionId, peerId: session.peerId, lat: fix.lat, lon: fix.lon, accuracy: fix.accuracy });
      next[sessionId] = { ...session, me: { ...fix, at: now } };
      changed = true;
    }
    if (changed) setState((state) => ({ liveSessions: { ...state.liveSessions, ...next } }));
  },

  liveDistance(sessionId) {
    const session = getState().liveSessions[sessionId];
    return session?.me && session?.peer ? haversineDistance(session.me, session.peer) : null;
  },
  setPresence(userId, status, lastSeenAt = null) {
    setState((state) => ({ presence: { ...state.presence, [userId]: status }, lastSeen: { ...state.lastSeen, [userId]: lastSeenAt ?? null } }));
  },
  setPollVotes(messageId, votes) { setState((state) => ({ pollVotes: { ...state.pollVotes, [messageId]: votes ?? {} } })); },
  // What a contact is doing now ('typing' | 'recording' | null). Never persisted; it lapses ACTIVITY_EXPIRES_MS after
  // the last refresh so a lost "stopped" can't leave it on.
  setTyping(userId, kind) {
    clearTimeout(typingExpiry.get(userId));
    typingExpiry.delete(userId);
    if (kind) {
      const timer = setTimeout(() => { typingExpiry.delete(userId); getState().setTyping(userId, null); }, ACTIVITY_EXPIRES_MS);
      timer?.unref?.();
      typingExpiry.set(userId, timer);
    }
    setState((state) => {
      if ((state.typing[userId] ?? null) === (kind || null)) return {};
      const typing = { ...state.typing };
      if (kind) typing[userId] = kind; else delete typing[userId];
      return { typing };
    });
  },
  markRead(chatId) {
    setState((state) => ({
      chats: state.chats.map((chat) => chat.id === chatId ? { ...chat, unread: 0 } : chat),
    }));
  },
  // The person has read this chat (on screen, or "Mark as read" on its notification): blue ticks for the sender's
  // unread messages and the unread count cleared at once.
  readChat(chatId) {
    const { client, messages } = getState();
    if (!chatId) return;
    // Not connected yet (an app just opened from a notification): the receipts go as soon as it connects.
    if (!client?.send) readsWithoutConnection.add(chatId);
    for (const message of client?.send ? messages[chatId] ?? [] : []) {
      // Marking it read locally (statuses only move forward, see mergeMessageStatus) is what stops a second receipt.
      if (message?.senderId === chatId && message.status !== 'read') {
        client.send({ type: 'message:read', messageId: message.id });
        getState().updateMessage(message.id, { status: 'read' });
      }
    }
    getState().markRead(chatId);
  },
  addMessage(message) {
    let addedContact = false;
    setState((state) => {
      const chatId = message.senderId === state.userId ? message.receiverId : message.senderId;
      if (hiddenByBlock(message, state.blockedChats[chatId], state.userId)) return {};
      const current = state.messages[chatId] ?? [];
      const existing = current.findIndex((item) => item.id === message.id);
      const nextMessages = existing < 0
        ? [...current, message]
        : current.map((item, index) => index === existing ? mergeMessage(item, message) : item);
      nextMessages.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
      const peer = message.senderId === state.userId
        ? { id: message.receiverId, username: message.receiverUsername, name: message.receiverName, initials: message.receiverInitials, color: message.receiverColor }
        : { id: message.senderId, username: message.senderUsername, name: message.senderName, initials: message.senderInitials, color: message.senderColor };
      const existingChat = state.chats.some((chat) => chat.id === chatId);
      addedContact = !existingChat && Boolean(peer.id && peer.name);
      // A message to or from a saved contact whose thread was deleted brings the thread back, still saved.
      const restored = existingChat ? null : state.hiddenContacts.find((item) => item.id === chatId);
      const chats = existingChat
        ? state.chats.map((chat) => chat.id === chatId ? summarizeChat({
          ...chat,
          // An open chat only stays at 0 while it is actually on screen; in the background it counts like any other.
          unread: message.senderId === state.userId || (state.activeChatId === chatId && pageVisible()) ? chat.unread : chat.unread + 1,
        }, nextMessages) : chat)
        : [summarizeChat({ ...peer, ...restored, unread: 1, online: true }, nextMessages), ...state.chats];
      return {
        messages: { ...state.messages, [chatId]: nextMessages },
        chats: orderChatsByActivity(chats),
        hiddenContacts: restored ? state.hiddenContacts.filter((item) => item.id !== chatId) : state.hiddenContacts,
      };
    });
    if (addedContact) getState().persistContacts(getState().userId);
  },
  async queueMessage(message) {
    const key = `relay:outbox:${getState().userId}`;
    const queued = await get(key) ?? [];
    await set(key, [...queued.filter((item) => item.id !== message.id), message]);
  },
  async acknowledgeMessage(message) {
    const key = `relay:outbox:${getState().userId}`;
    const queued = await get(key) ?? [];
    await set(key, queued.filter((item) => item.id !== message.id));
  },
  async getOutbox(userId) {
    return await get(`relay:outbox:${userId}`) ?? [];
  },
  /**
   * A group's messages kept on this device (local-first: the server deletes each one once every member's device
   * has it). Rows from the server are added to what is saved here, never replacing a readable copy with one this
   * device cannot open; returns the group's whole list, oldest first.
   */
  mergeGroupMessages(groupId, rows) {
    const key = groupChatKey(groupId);
    let merged = [];
    setState((state) => {
      const byId = new Map((state.messages[key] ?? []).map((message) => [message.id, message]));
      for (const row of rows ?? []) {
        if (!row?.id || row.pending) continue;
        const known = byId.get(row.id);
        if (known && !known.e2eError && row.e2eError) continue;
        const createdAt = Number(row.createdAt ?? known?.createdAt ?? Date.now());
        byId.set(row.id, { ...known, ...row, createdAt, timestamp: new Date(createdAt).toISOString() });
      }
      merged = [...byId.values()].sort((left, right) => Number(left.createdAt) - Number(right.createdAt));
      return { messages: { ...state.messages, [key]: merged } };
    });
    const userId = getState().userId;
    if (userId) getState().persistMessages(userId);
    return merged;
  },
  savedGroupMessages(groupId) {
    return getState().messages[groupChatKey(groupId)] ?? [];
  },
  mergeHistory(chatId, history) {
    setState((state) => {
      const current = state.messages[chatId] ?? [];
      // Messages that disappeared (timer) are gone; ones deleted for everyone stay as a "deleted" placeholder.
      const expiredIds = new Set(history.filter((message) => message.deleted && message.expired).map((message) => message.id));
      const merged = new Map(current.filter((message) => !expiredIds.has(message.id)).map((message) => [message.id, message]));
      for (const message of history) {
        if (expiredIds.has(message.id) || hiddenByBlock(message, state.blockedChats[chatId], state.userId)) continue;
        if (message.deleted) {
          const { expired: _expired, ...placeholder } = message;
          merged.set(message.id, deletedPlaceholder({ ...merged.get(message.id), ...placeholder }));
        } else {
          merged.set(message.id, mergeMessage(merged.get(message.id), message));
        }
      }
      const messages = [...merged.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
      return {
        messages: { ...state.messages, [chatId]: messages },
        // History carries each message's read state, so the badge is right after the app was closed (messages that
        // arrived meanwhile were never counted live) and after reading on another device.
        chats: orderChatsByActivity(state.chats.map((chat) => (chat.id === chatId
          ? { ...summarizeChat(chat, messages), unread: state.activeChatId === chatId && pageVisible() ? 0 : unreadFrom(messages, chatId, state.userId) }
          : chat))),
      };
    });
  },
  updateMessage(messageId, updates) {
    setState((state) => ({
      messages: Object.fromEntries(Object.entries(state.messages).map(([chatId, messages]) => [
        chatId,
        messages.map((message) => {
          if (message.id !== messageId) return message;
          const next = { ...message, ...updates };
          if (updates.status) {
            next.status = mergeMessageStatus(message.status, updates.status);
          }
          return next;
        }),
      ])),
    }));
  },
  // Calls › Clear call log: this device's history (call logs live on the device).
  clearCallLogs() {
    setState({ callLogs: [] });
    getState().persistCallLogs(getState().userId);
  },
  logCall(peerId, { duration = 0, mode = 'audio', status = 'completed', direction = 'outgoing' } = {}) {
    const state = getState();
    const timestamp = new Date().toISOString();
    const incoming = direction === 'incoming';
    const entry = { id: crypto.randomUUID(), peerId, mode, direction, status, duration, timestamp };
    setState((current) => ({ callLogs: [entry, ...current.callLogs] }));
    getState().persistCallLogs(state.userId);
    if (!state.chats.some((chat) => chat.id === peerId)) return;
    const unreadBefore = state.chats.find((chat) => chat.id === peerId)?.unread ?? 0;
    getState().addMessage({
      id: entry.id,
      senderId: incoming ? peerId : state.userId,
      receiverId: incoming ? state.userId : peerId,
      timestamp,
      content: `call:${JSON.stringify({ duration, mode, status, direction })}`,
      status: 'read',
    });
    if (!incoming || status !== 'missed') {
      setState((current) => ({
        chats: current.chats.map((chat) => chat.id === peerId ? { ...chat, unread: unreadBefore } : chat),
      }));
    }
  },
  deleteMessage(chatId, messageId) {
    setState((state) => {
      const chatMessages = (state.messages[chatId] ?? []).filter((m) => m.id !== messageId);
      return {
        messages: { ...state.messages, [chatId]: chatMessages },
        chats: orderChatsByActivity(state.chats.map((c) => c.id === chatId ? resummarizeChat(c, chatMessages) : c)),
      };
    });
    const userId = getState().userId;
    if (userId) getState().persistMessages(userId);
  },
  // Clear chat keeps the conversation in the list and removes its messages, except the ids the user kept.
  clearChat(chatId, keepIds = []) {
    const keep = new Set(keepIds);
    // On this device too: the chat's stored rows go (older ones not in memory included); kept ones are rewritten.
    clearedChats.add(chatId);
    setState((state) => {
      const chatMessages = (state.messages[chatId] ?? []).filter((message) => keep.has(message.id));
      return {
        messages: { ...state.messages, [chatId]: chatMessages },
        chats: orderChatsByActivity(state.chats.map((c) => c.id === chatId ? { ...resummarizeChat(c, chatMessages), unread: 0 } : c)),
      };
    });
    const userId = getState().userId;
    if (userId) getState().persistMessages(userId);
  },
  setDisappearing(chatId, seconds) {
    setState((state) => ({ chats: state.chats.map((chat) => chat.id === chatId ? { ...chat, disappearSeconds: seconds } : chat) }));
    const userId = getState().userId;
    if (userId) getState().persistContacts(userId);
  },
  // Deleted for everyone: the bubble turns into "You deleted this message" / "This message was deleted".
  markMessageDeleted(messageId) {
    setState((state) => {
      const chatId = Object.keys(state.messages).find((id) => state.messages[id].some((m) => m.id === messageId));
      if (!chatId) return {};
      const chatMessages = state.messages[chatId].map((m) => (m.id === messageId ? deletedPlaceholder(m) : m));
      return {
        messages: { ...state.messages, [chatId]: chatMessages },
        chats: state.chats.map((c) => (c.id === chatId ? { ...summarizeChat(c, chatMessages), unread: Math.min(c.unread ?? 0, unreadFrom(chatMessages, chatId, state.userId)) } : c)),
      };
    });
    const { userId } = getState();
    if (userId) getState().persistMessages(userId);
  },
  removeMessageById(messageId) {
    const chatId = Object.keys(getState().messages).find((id) => getState().messages[id].some((m) => m.id === messageId));
    if (chatId) getState().deleteMessage(chatId, messageId);
  },
  toggleReaction(chatId, messageId, emoji) {
    const userId = getState().userId;
    let next = emoji;
    setState((state) => {
      const chatMessages = (state.messages[chatId] ?? []).map((message) => {
        if (message.id !== messageId) return message;
        const currentReactions = Array.isArray(message.reactions) ? [...message.reactions] : [];
        const existingIdx = currentReactions.findIndex((r) => r.userId === userId);
        if (existingIdx >= 0) {
          if (currentReactions[existingIdx].emoji === emoji) {
            currentReactions.splice(existingIdx, 1);
            next = null;
          } else {
            currentReactions[existingIdx] = { ...currentReactions[existingIdx], emoji };
          }
        } else {
          currentReactions.push({ userId, emoji });
        }
        return { ...message, reactions: currentReactions };
      });
      return {
        messages: { ...state.messages, [chatId]: chatMessages },
      };
    });
    if (userId) getState().persistMessages(userId);
    return next;
  },
  // Stars are personal and stay on this device, like WhatsApp; server history merges keep the flag.
  // Starring is saved to the account (every device sees it); the flag shows at once and reverts if refused.
  toggleStar(chatId, messageId) {
    const message = (getState().messages[chatId] ?? []).find((item) => item.id === messageId);
    if (!message) return Promise.resolve();
    return toggleCloudStar(messageId, chatId, !message.starred).catch(() => {});
  },
  // Applies the account's starred list to every message on this device.
  applyCloudStars(starred) {
    cloudStars = starred;
    setState((state) => ({
      messages: Object.fromEntries(Object.entries(state.messages).map(([chatId, messages]) => [chatId, messages.map(withCloudStar)])),
    }));
    const userId = getState().userId;
    if (userId) getState().persistMessages(userId);
  },
  applyReaction(messageId, reactorId, emoji) {
    setState((state) => ({
      messages: Object.fromEntries(Object.entries(state.messages).map(([chatId, messages]) => [
        chatId,
        messages.map((message) => {
          if (message.id !== messageId) return message;
          const others = (message.reactions ?? []).filter((reaction) => reaction.userId !== reactorId);
          return { ...message, reactions: emoji ? [...others, { userId: reactorId, emoji }] : others };
        }),
      ])),
    }));
    const userId = getState().userId;
    if (userId) getState().persistMessages(userId);
  },
  setPreference(name, update) {
    const value = update(getState()[name]);
    setState({ [name]: value });
    const userId = getState().userId;
    if (userId) set(`relay:${PREFERENCES[name]}:${userId}`, value);
  },
  togglePinChat(chatId) {
    getState().setPreference('pinnedChatIds', (ids) => toggleId(ids, chatId));
  },
  toggleMuteChat(chatId) {
    getState().setPreference('mutedChatIds', (ids) => toggleId(ids, chatId));
  },
  toggleLockedChat(key) {
    getState().setPreference('lockedChatIds', (ids) => toggleId(ids ?? [], key));
  },
  // Opening a search result: the chat window scrolls to this message once it is showing that chat.
  // A message to put in a chat's box when it opens (short links with ?text=); the chat window takes it once.
  composerDraft: null,
  setComposerDraft(chatId, text) { setState({ composerDraft: { chatId, text } }); },
  takeComposerDraft(chatId) { const draft = getState().composerDraft; if (draft?.chatId !== chatId) return ''; setState({ composerDraft: null }); return draft.text; },
  requestMessageJump(chatId, messageId) { setState({ messageJump: { chatId, messageId, at: Date.now() } }); },
  clearMessageJump() { setState({ messageJump: null }); },
  saveChatList(listId, { name, keys }) {
    const id = listId || `list-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    getState().setPreference('chatLists', (lists) => ({ ...(lists ?? {}), [id]: { name: String(name).trim().slice(0, 40), keys: [...new Set(keys)], createdAt: lists?.[id]?.createdAt ?? Date.now() } }));
    return id;
  },
  deleteChatList(listId) {
    getState().setPreference('chatLists', (lists) => Object.fromEntries(Object.entries(lists ?? {}).filter(([id]) => id !== listId)));
  },
  toggleChatInList(listId, key) {
    getState().setPreference('chatLists', (lists) => {
      const list = lists?.[listId];
      if (!list) return lists;
      return { ...lists, [listId]: { ...list, keys: list.keys.includes(key) ? list.keys.filter((item) => item !== key) : [...list.keys, key] } };
    });
  },
  toggleFavouriteChat(chatId) {
    getState().setPreference('favouriteChatIds', (ids) => toggleId(ids, chatId));
  },
  // The server keeps and enforces the block list (src/blocksApi.js); this device keeps when each block started and
  // ended, to hide what arrived while blocked. A change that the server did not take is undone here and rejects.
  async blockChat(chatId) {
    const at = new Date().toISOString();
    const before = getState().blockedChats[chatId];
    getState().setPreference('blockedChats', (blocked) => ({ ...blocked, [chatId]: startBlock(blocked[chatId], at) }));
    const token = getState().sessionToken;
    if (!token) return;
    try {
      await setBlocked(token, chatId, true);
    } catch (error) {
      getState().setPreference('blockedChats', (blocked) => ({ ...blocked, [chatId]: before ?? [] }));
      throw error;
    }
  },
  async unblockChat(chatId) {
    const at = new Date().toISOString();
    const before = getState().blockedChats[chatId];
    getState().setPreference('blockedChats', (blocked) => ({ ...blocked, [chatId]: endBlock(blocked[chatId], at) }));
    const token = getState().sessionToken;
    if (!token) return;
    try {
      await setBlocked(token, chatId, false);
    } catch (error) {
      getState().setPreference('blockedChats', (blocked) => ({ ...blocked, [chatId]: before ?? [] }));
      throw error;
    }
  },
  /** The server's block list (another device changed it, or this device starts): adopted here. */
  applyServerBlocks(serverIds) {
    getState().setPreference('blockedChats', (blocked) => reconcileBlocks(blocked, serverIds));
  },
  /** A contact deleted their account: the chat stays, read-only, as "Deleted account". */
  markAccountDeleted(userId) {
    setState((state) => ({
      chats: state.chats.map((chat) => (chat.id === userId ? { ...chat, deleted: true, name: 'Deleted account', initials: '?', avatar: null } : chat)),
    }));
    getState().persistContacts(getState().userId);
  },
  setChatTheme(chatId, themeId) {
    getState().setPreference('chatThemes', (themes) => {
      const next = { ...themes };
      if (themeId && themeId !== 'default') next[chatId] = themeId;
      else delete next[chatId];
      return next;
    });
  },
  // Removes a thread from the chat list. A saved contact stays in the contact book (`kept`), ready to chat again.
  deleteChat(chatId, { kept } = {}) {
    setState((state) => {
      const removed = state.chats.find((c) => c.id === chatId);
      const nextChats = state.chats.filter((c) => c.id !== chatId);
      const nextMessages = { ...state.messages };
      delete nextMessages[chatId];
      const nextActive = state.activeChatId === chatId ? (nextChats[0]?.id ?? null) : state.activeChatId;
      const keep = removed && (kept ?? removed.saved === true);
      return {
        chats: nextChats,
        messages: nextMessages,
        activeChatId: nextActive,
        hiddenContacts: keep
          ? [...state.hiddenContacts.filter((item) => item.id !== chatId), { ...removed, saved: true, preview: 'Start a conversation', time: '', unread: 0 }]
          : state.hiddenContacts,
      };
    });
    getState().setPreference('pinnedChatIds', (ids) => ids.filter((id) => id !== chatId));
    getState().setPreference('mutedChatIds', (ids) => ids.filter((id) => id !== chatId));
    getState().setPreference('favouriteChatIds', (ids) => ids.filter((id) => id !== chatId));
    const userId = getState().userId;
    if (userId) {
      getState().persistContacts(userId);
      getState().persistMessages(userId);
    }
  },
  /**
   * Restores a decrypted backup (src/backup.js) into this device without losing anything newer: chats the device
   * doesn't have are added, messages are merged by id (current copies win), call history is merged, and
   * preferences are combined. Returns counts for the confirmation.
   */
  restoreBackup(data) {
    const state = getState();
    let addedChats = 0;
    let addedMessages = 0;
    const chats = [...state.chats];
    const messages = { ...state.messages };
    for (const peer of data.chats) {
      if (!peer?.id || peer.id === state.userId) continue;
      if (!chats.some((chat) => chat.id === peer.id)) {
        chats.push({ ...peer, preview: '', time: '', unread: 0, online: false });
        addedChats += 1;
      }
    }
    // Group history is saved under "group:<id>" like any chat. Older backup files kept it apart (data.groups).
    const incoming = { ...data.messages };
    for (const group of Array.isArray(data.groups) ? data.groups : []) {
      if (typeof group?.id !== 'string' || !Array.isArray(group.messages)) continue;
      const key = groupChatKey(group.id);
      const rows = group.messages.filter((message) => typeof message?.id === 'string')
        .map((message) => ({ ...message, timestamp: typeof message.timestamp === 'string' ? message.timestamp : new Date(Number(message.createdAt) || 0).toISOString() }));
      incoming[key] = [...(incoming[key] ?? []), ...rows];
    }
    for (const [chatId, list] of Object.entries(incoming)) {
      if (!chatId.startsWith('group:') && !chats.some((chat) => chat.id === chatId)) continue;
      const current = new Map((messages[chatId] ?? []).map((message) => [message.id, message]));
      for (const message of list) {
        if (current.has(message.id)) continue;
        current.set(message.id, message);
        addedMessages += 1;
      }
      messages[chatId] = [...current.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    }
    const knownCalls = new Set(state.callLogs.map((entry) => entry.id));
    const callLogs = [...state.callLogs, ...(data.callLogs ?? []).filter((entry) => entry?.id && !knownCalls.has(entry.id))]
      .sort((left, right) => String(right.timestamp).localeCompare(String(left.timestamp)));
    const preferences = {};
    for (const name of Object.keys(PREFERENCES)) {
      const saved = data.preferences?.[name];
      if (Array.isArray(state[name]) && Array.isArray(saved)) preferences[name] = [...new Set([...state[name], ...saved])];
      else if (state[name] && typeof state[name] === 'object' && saved && typeof saved === 'object' && !Array.isArray(saved)) preferences[name] = { ...saved, ...state[name] };
    }
    setState({
      ...preferences,
      callLogs,
      messages,
      chats: orderChatsByActivity(chats.map((chat) => (messages[chat.id]?.length ? summarizeChat(chat, messages[chat.id]) : chat))),
    });
    const userId = state.userId;
    if (userId) {
      getState().persistMessages(userId);
      getState().persistContacts(userId);
      getState().persistCallLogs(userId);
      for (const name of Object.keys(preferences)) set(`relay:${PREFERENCES[name]}:${userId}`, preferences[name]);
    }
    return { addedChats, addedMessages };
  },
  async hydratePreferences(userId) {
    if (!userId) return;
    const names = Object.keys(PREFERENCES);
    const values = await Promise.all(names.map((name) => get(`relay:${PREFERENCES[name]}:${userId}`)));
    if (userId !== getState().userId) return;
    const loaded = {};
    names.forEach((name, index) => {
      const value = values[index];
      const expectsList = Array.isArray(getState()[name]);
      if (expectsList ? Array.isArray(value) : value && typeof value === 'object' && !Array.isArray(value)) loaded[name] = value;
    });
    setState(loaded);
  },
  async hydrateCallLogs(userId) {
    const saved = await get(`relay:calls:${userId}`);
    if (Array.isArray(saved) && userId === getState().userId) setState({ callLogs: saved });
  },
  async persistCallLogs(userId) {
    if (userId && userId === getState().userId) await set(`relay:calls:${userId}`, getState().callLogs);
  },
  async hydrateMessages(userId) {
    const db = messageStore();
    // Once: the old single record ("relay:messages:<user>") becomes one row per message, then it is deleted.
    const legacy = await get(`relay:messages:${userId}`).catch(() => null);
    if (legacy && typeof legacy === 'object') {
      const puts = Object.entries(legacy).flatMap(([chat, list]) => (Array.isArray(list) ? list : []).map((message) => ({ chat, message })));
      await db.apply(userId, { puts });
      await del(`relay:messages:${userId}`);
    }
    const { messages: loaded, more } = await db.loadRecent(userId, MESSAGE_WINDOW).catch((error) => {
      console.error('Could not read saved messages:', error);
      return { messages: {}, more: new Set() };
    });
    if (userId !== getState().userId) return;
    saved = { owner: userId, chats: snapshotOf(loaded) };
    setState((state) => {
      // Cloud stars are applied after hydration (markMessagesHydrated), once device-only stars are uploaded.
      const messages = { ...state.messages };
      for (const [chat, list] of Object.entries(loaded)) {
        const byId = new Map(list.map((message) => [message.id, message]));
        for (const message of messages[chat] ?? []) byId.set(message.id, message);
        messages[chat] = [...byId.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
      }
      return {
        messages,
        olderOnDevice: Object.fromEntries([...more].map((chat) => [chat, true])),
        chats: orderChatsByActivity(state.chats.map((chat) => summarizeChat(chat, messages[chat.id]))),
      };
    });
    markMessagesHydrated(userId);
  },
  // Chats keep their newest messages in memory; scrolling back reads older ones from this device's store.
  olderOnDevice: {},
  async loadOlderMessages(chatId) {
    const { userId, messages } = getState();
    const list = messages[chatId] ?? [];
    if (!userId || !list.length || !getState().olderOnDevice[chatId]) return 0;
    const before = Date.parse(list[0].timestamp);
    const { messages: older, more } = await messageStore().loadOlder(userId, chatId, before, MESSAGE_WINDOW);
    if (userId !== getState().userId) return 0;
    const known = new Set(list.map((message) => message.id));
    const added = older.filter((message) => !known.has(message.id));
    const chatSaved = saved.chats.get(chatId) ?? new Map();
    for (const message of added) chatSaved.set(message.id, message);
    saved.chats.set(chatId, chatSaved);
    setState((state) => ({
      messages: { ...state.messages, [chatId]: [...added, ...(state.messages[chatId] ?? [])] },
      olderOnDevice: { ...state.olderOnDevice, [chatId]: more },
    }));
    return added.length;
  },
  // Saving copies every message on the main thread, so bursts (history loading, a busy group) are coalesced into
  // one write per PERSIST_DELAY_MS; leaving the app flushes at once (flushPersistedMessages).
  persistMessages(userId) {
    if (!userId || userId !== getState().userId) return Promise.resolve();
    pendingPersistUser = userId;
    if (!persistTimer) persistTimer = setTimeout(flushPersistedMessages, PERSIST_DELAY_MS);
    return Promise.resolve();
  },
  async hydrateContacts(userId) {
    const saved = await get(`relay:contacts:${userId}`);
    if (saved && userId === getState().userId) getState().setContacts(saved);
  },
  async persistContacts(userId) {
    if (userId && userId === getState().userId) await set(`relay:contacts:${userId}`, getState().chats);
  },
  async persistSession(session) { await set('relay:session', session); },
  async clearSession() { await del('relay:session'); },
}));

export { EMPTY_MESSAGES };
/** Where a group's messages are kept in the message store (one-to-one chats use the contact's id). */
export const groupChatKey = (groupId) => `group:${groupId}`;
// Stars that were kept only on this device (before they followed the account) are uploaded once per account,
// as soon as both the saved messages and the account's list are here; until then the device's flags stay.
const hydratedAccounts = new Set();
const migratedStarAccounts = new Set();
function migrateLocalStars() {
  const state = useChatStore.getState();
  if (!state.userId || cloudStars === null || !hydratedAccounts.has(state.userId) || migratedStarAccounts.has(state.userId)) return false;
  migratedStarAccounts.add(state.userId);
  const localOnly = Object.values(state.messages).flat().filter((message) => message.starred && !cloudStars[message.id]).map((message) => message.id);
  if (!localOnly.length) return false;
  uploadLocalStars(localOnly).catch(() => {});
  return true;
}
export function markMessagesHydrated(userId) {
  hydratedAccounts.add(userId);
  if (!migrateLocalStars() && cloudStars !== null) useChatStore.getState().applyCloudStars(cloudStars);
}
onCloudStars((starred) => {
  if (starred === null) {
    cloudStars = null;
    return;
  }
  const first = cloudStars === null;
  cloudStars = starred;
  if (first && migrateLocalStars()) return;
  useChatStore.getState().applyCloudStars(starred);
});
