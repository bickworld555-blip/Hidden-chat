import { pollSummary } from './polls.js';
import { eventSummary } from './calendarEvents.js';
import { create } from 'zustand';
import { del, get, set } from 'idb-keyval';
import { endBlock, hiddenByBlock, startBlock } from './blocking.js';
import { mediaPreviewLabel } from './media.js';
import { haversineDistance, isLiveExpired, parseContact, parseLocation, shouldSendLiveUpdate } from './geo.js';
import { mergeMessageStatus } from './messageStatus.js';
import { formatChatListTime } from './time.js';
import { splitLinks } from './contactBook.js';
import { scheduledCallPreview } from './groupChat.js';

const EMPTY_MESSAGES = Object.freeze([]);

function mergeMessage(current, incoming) {
  if (!current) return incoming;
  const merged = { ...current, ...incoming, status: mergeMessageStatus(current.status, incoming.status) };
  // Once played, a voice note stays played (a stale copy of the history must not turn it green again).
  if (current.played || incoming.played) merged.played = true;
  return merged;
}

const PERSIST_DELAY_MS = 400;
let persistTimer = null;
let pendingPersistUser = null;

export async function flushPersistedMessages() {
  clearTimeout(persistTimer);
  persistTimer = null;
  const userId = pendingPersistUser;
  pendingPersistUser = null;
  const state = useChatStore.getState();
  if (userId && userId === state.userId) await set(`relay:messages:${userId}`, state.messages);
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && persistTimer) flushPersistedMessages(); });
}

export function previewFor(content) {
  if (typeof content !== 'string') return '';
  if (content.startsWith('voice-opened:')) return '① Opened';
  if (content.startsWith('voice:')) return content.endsWith(':once') ? '① Voice message' : '🎤 Voice message';
  if (content.startsWith('poll:')) return pollSummary(content) ?? '📊 Poll';
  if (content.startsWith('event:')) return eventSummary(content) ?? '📅 Event';
  if (content.startsWith('media:')) return mediaPreviewLabel(content);
  if (content.startsWith('file:')) return '📎 Attachment';
  if (content.startsWith('location:')) return `📍 ${parseLocation(content)?.name || 'Location'}`;
  if (content.startsWith('live:')) return '📍 Live location';
  const scheduled = scheduledCallPreview(content);
  if (scheduled) return scheduled;
  if (content.startsWith('contact:')) return `👤 ${parseContact(content)?.name || 'Contact'}`;
  if (content.startsWith('call:')) {
    try {
      return JSON.parse(content.slice(5))?.mode === 'video' ? '📹 Video call' : '📞 Voice call';
    } catch {
      return '📞 Call';
    }
  }
  return content;
}

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

function summarizeChat(chat, messages) {
  const last = messages?.length ? messages[messages.length - 1] : null;
  if (!last) return chat;
  return { ...chat, preview: chatPreview(messages), time: formatChatListTime(last.timestamp), lastActivityAt: last.timestamp };
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

export const useChatStore = create((setState, getState) => ({
  userId: '',
  user: null,
  device: null,
  sessionToken: null,
  activeChatId: null,
  chats: [],
  // Saved contacts whose thread was deleted from the chat list; they stay available in the contact picker.
  hiddenContacts: [],
  messages: {},
  callLogs: [],
  pinnedChatIds: [],
  mutedChatIds: [],
  favouriteChatIds: [],
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
    stopLiveTracking();
    setState((state) => ({
      userId,
      activeChatId: null,
      messages: {},
      callLogs: [],
      liveSessions: {},
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
  setClient(client) { setState({ client }); },
  sendMessage(receiverId, content, extras = {}) {
    const { userId, client } = getState();
    if (!receiverId || !userId || !content) return null;
    const message = { id: crypto.randomUUID(), senderId: userId, receiverId, timestamp: new Date().toISOString(), content, status: 'sent', ...extras };
    getState().addMessage(message);
    const accepted = client?.send?.({ type: 'message:send', message: { id: message.id, receiverId, content, ...extras } });
    if (!accepted) getState().updateMessage(message.id, { status: 'failed' });
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
  setTyping(userId, active) { setState((state) => ({ typing: { ...state.typing, [userId]: active } })); },
  markRead(chatId) {
    setState((state) => ({
      chats: state.chats.map((chat) => chat.id === chatId ? { ...chat, unread: 0 } : chat),
    }));
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
  mergeHistory(chatId, history) {
    setState((state) => {
      const current = state.messages[chatId] ?? [];
      const deletedIds = new Set(history.filter((message) => message.deleted).map((message) => message.id));
      const merged = new Map(current.filter((message) => !deletedIds.has(message.id)).map((message) => [message.id, message]));
      for (const message of history) {
        if (!message.deleted && !hiddenByBlock(message, state.blockedChats[chatId], state.userId)) {
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
  toggleStar(chatId, messageId) {
    setState((state) => ({
      messages: {
        ...state.messages,
        [chatId]: (state.messages[chatId] ?? []).map((message) => (
          message.id === messageId ? { ...message, starred: !message.starred } : message
        )),
      },
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
  toggleFavouriteChat(chatId) {
    getState().setPreference('favouriteChatIds', (ids) => toggleId(ids, chatId));
  },
  blockChat(chatId) {
    const at = new Date().toISOString();
    getState().setPreference('blockedChats', (blocked) => ({ ...blocked, [chatId]: startBlock(blocked[chatId], at) }));
  },
  unblockChat(chatId) {
    const at = new Date().toISOString();
    getState().setPreference('blockedChats', (blocked) => ({ ...blocked, [chatId]: endBlock(blocked[chatId], at) }));
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
    const saved = await get(`relay:messages:${userId}`);
    if (saved && userId === getState().userId) {
      setState((state) => {
        const messages = { ...state.messages, ...saved };
        return { messages, chats: orderChatsByActivity(state.chats.map((chat) => summarizeChat(chat, messages[chat.id]))) };
      });
    }
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