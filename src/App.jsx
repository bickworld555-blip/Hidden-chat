import { apiFetch, apiUrl } from './api.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { activateAccount, addOrActivateAccount, getAccountsState, loadAccounts, removeAccount, updateAccountUser } from './accounts.js';
import { Bell, ChevronRight, MessageSquarePlus, Moon, Sun } from 'lucide-react';
import { notificationPreview, useChatStore } from './store.js';
import { fetchStatuses } from './statusApi.js';
import { clearMediaCache } from './media.js';
import { clearAvatarCache } from './avatar.js';
import { RealtimeClient } from './realtime.js';
import { initialTabFromUrl } from './pwa.js';
import { countUnreadConversations, groupRow } from './groupRows.js';
import { getViewingGroup, readMutedGroups, useMutedGroups } from './groupPrefs.js';
import { classifyIncoming, groupNotificationText, parseConversationOpenParam, shouldAlertGroup } from './notificationChannels.js';
import { nativeClearSession, nativeSetSession, nativeShell, nativeStartBackground, nativeState, nativeStopBackground, nativeTakePendingCall, nativeMoveToBackground, nativeClearShare, nativeSetCallActive, onNative } from './native.js';
import { parseShare } from './shareTarget.js';
import ShareSheet from './components/ShareSheet.jsx';
import CallAccessSheet from './components/CallAccessSheet.jsx';
import { publishShareShortcuts } from './shareShortcuts.js';
import { CALL_ACCESS_ASKED_KEY, shouldAskCallAccess } from './callAccess.js';
import { PERMISSIONS_ASKED_KEY } from './permissionsKey.js';
import Sidebar from './components/Sidebar.jsx';
import ChatWindow from './components/ChatWindow.jsx';
import UsernameGate from './components/UsernameGate.jsx';
import CallOverlay from './components/CallOverlay.jsx';
import { syncMissedMessages } from './messageSync.js';
import { HISTORY_CONCURRENCY, forEachLimited } from './concurrency.js';
import MobileBottomNav from './components/MobileBottomNav.jsx';
import ChatsList from './components/ChatsList.jsx';
import { lazyComponent, preloadLazyScreens } from './lazy.js';
import { handleBack, useBackHandler } from './backStack.js';
import { phoneSoundSession } from './phoneSounds.js';
import { autoSaveIncoming } from './mediaSave.js';
const AccountSwitcher = lazyComponent(() => import('./components/AccountSwitcher.jsx'));
const AvatarStudio = lazyComponent(() => import('./components/AvatarStudio.jsx'));
const PermissionsSheet = lazyComponent(() => import('./components/PermissionsSheet.jsx'));
const PairingModal = lazyComponent(() => import('./components/PairingModal.jsx'));
const NotificationSettings = lazyComponent(() => import('./components/NotificationSettings.jsx'));
const AccountSettings = lazyComponent(() => import('./components/AccountSettings.jsx'));
const CallsView = lazyComponent(() => import('./components/CallsView.jsx'));
const UpdatesView = lazyComponent(() => import('./components/UpdatesView.jsx'));
const ToolsView = lazyComponent(() => import('./components/ToolsView.jsx'));
const GroupsView = lazyComponent(() => import('./components/GroupsView.jsx'));
import { playNotificationTone, stopAllTones } from './sounds.js';
import { applyAppBadge, maybeRemind, showSystemNotification, vibrateFor } from './notify.js';
import { badgeCount, useNotificationSettings } from './notificationSettings.js';
import { hiddenByBlock, isBlocked } from './blocking.js';
import { TERMINAL_STATUSES } from './callEngine.js';
import { isRoomOffer } from './callRoom.js';
import { animationsAttribute, callAnimationsAttribute, useAppearance } from './appearance.js';
import { linkContact } from './contactsApi.js';

function useIsMobile() {
  const query = '(max-width: 768px)';
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return matches;
}

// Confirms a stored account's token still works and refreshes its profile from the server.
async function validateAccount(account) {
  const response = await apiFetch('/api/v1/me', { headers: { Authorization: 'Bearer ' + account.token } });
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new Error('Could not reach the server.');
  const profile = await response.json();
  return { token: account.token, deviceId: profile.device?.id ?? account.deviceId, deviceName: profile.device?.name ?? account.deviceName, user: profile.user, device: profile.device };
}

export default function App() {
  const isMobile = useIsMobile();
  const userId = useChatStore((state) => state.userId);
  const user = useChatStore((state) => state.user);
  const sessionToken = useChatStore((state) => state.sessionToken);
  const chats = useChatStore((state) => state.chats);
  const activeChatId = useChatStore((state) => state.activeChatId);
  const setSession = useChatStore((state) => state.setSession);
  const addMessage = useChatStore((state) => state.addMessage);
  const updateMessage = useChatStore((state) => state.updateMessage);
  const setPresence = useChatStore((state) => state.setPresence);
  const setTyping = useChatStore((state) => state.setTyping);
  const acknowledgeMessage = useChatStore((state) => state.acknowledgeMessage);
  const getOutbox = useChatStore((state) => state.getOutbox);
  const setConnection = useChatStore((state) => state.setConnection);
  const hydrateMessages = useChatStore((state) => state.hydrateMessages);
  const hydrateCallLogs = useChatStore((state) => state.hydrateCallLogs);
  const persistMessages = useChatStore((state) => state.persistMessages);
  const mergeHistory = useChatStore((state) => state.mergeHistory);
  const setContacts = useChatStore((state) => state.setContacts);
  const hydrateContacts = useChatStore((state) => state.hydrateContacts);
  const persistContacts = useChatStore((state) => state.persistContacts);
  const hydratePreferences = useChatStore((state) => state.hydratePreferences);
  const logCall = useChatStore((state) => state.logCall);
  const messages = useChatStore((state) => state.messages);
  const [client, setClient] = useState(null);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [avatarStudioOpen, setAvatarStudioOpen] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [groupsCreate, setGroupsCreate] = useState(false);
  const [groupRevision, setGroupRevision] = useState(0);
  const [groupsInitialId, setGroupsInitialId] = useState('');
  const [groupSummaries, setGroupSummaries] = useState([]);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  // Something shared to Hidden Messenger from another app's share sheet, waiting for the user to pick chats.
  const [incomingShare, setIncomingShare] = useState(null);
  // Android blocks lock-screen calls or the floating video window for this app: the native state, to ask once.
  const [callAccess, setCallAccess] = useState(null);
  const [switchingId, setSwitchingId] = useState(null);
  const [callsSeenAt, setCallsSeenAt] = useState(() => Number(localStorage.getItem('relay:calls-seen-at')) || 0);
  const openChatRef = useRef(null);
  const openGroupRef = useRef(null);
  const revokedRef = useRef(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [darkMode, setDarkMode] = useState(() => {
    const stored = localStorage.getItem('relay:theme');
    return stored ? stored === 'dark' : window.matchMedia('(max-width: 768px)').matches;
  });
  const [fatalError, setFatalError] = useState('');
  const [mobileListOpen, setMobileListOpen] = useState(true);
  const [authReady, setAuthReady] = useState(false);
  const [mobileActiveTab, setMobileActiveTab] = useState(initialTabFromUrl);
  const [call, setCall] = useState(null);
  // No call on screen means no call: if Android still shows one (its timer on the lock screen), end it there too.
  useEffect(() => {
    if (!nativeShell() || call) return undefined;
    const sync = () => { if (document.visibilityState === 'visible') nativeSetCallActive(false); };
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, [call]);
  const [callSignals, setCallSignals] = useState([]);
  const callStartTimeRef = useState(() => ({ current: null }))[0];
  const callRef = useRef(null);
  callRef.current = call;

  useEffect(() => {
    let active = true;
    async function restoreSession() {
      try {
        const { accounts, activeId } = await loadAccounts();
        const account = accounts.find((item) => item.id === activeId);
        if (!account) return;
        const session = await validateAccount(account);
        if (!active) return;
        if (!session) {
          await removeAccount(account.id);
          return;
        }
        useChatStore.getState().setUserId(session.user.id);
        setSession(session);
      } catch {
        if (active) setFatalError('Could not restore your saved session. Check your connection.');
      } finally {
        if (active) setAuthReady(true);
      }
    }
    restoreSession();
    return () => { active = false; };
  }, [setSession]);

  useEffect(() => {
    if (!activeChatId) setMobileListOpen(true);
  }, [activeChatId]);

  useEffect(() => {
    let cancelled = false;
    let realtime;
    async function boot() {
      if (!authReady) return;
      if (!userId || !sessionToken) {
        setConnection('offline');
        return;
      }
      setFatalError('');
      setConnection('connecting');
      try {
        await hydrateContacts(userId);
        await hydrateMessages(userId);
        await hydrateCallLogs(userId);
        await hydratePreferences(userId);
        if (cancelled) return;
        if (cancelled) return;
        let connectedBefore = false;
        realtime = new RealtimeClient(sessionToken, (event) => {
          if (event.type === 'connection:ready' || (typeof event.type === 'string' && event.type.startsWith('group:'))) setGroupRevision((current) => current + 1);
          // Reconnected after a drop: catch up on anything that changed meanwhile (the first connect already loaded history).
          if (event.type === 'connection:ready') {
            if (!connectedBefore) {
              // Accept was tapped on a call the background service rang while the app was closed: replay that
              // offer (and the caller's candidates) as if it had just arrived; the retained "accept" then answers.
              nativeTakePendingCall().then((pending) => {
                if (!pending?.event) return;
                realtime?.onEvent(pending.event);
                for (const ice of pending.ice ?? []) realtime?.onEvent(ice);
              }).catch(() => {});
            }
            if (connectedBefore) {
              syncMissedMessages({ sessionToken, userId, acknowledge: (ids) => realtime?.send({ type: 'message:delivered', messageIds: ids }) })
                .catch(() => { /* the next reconnect retries */ });
            }
            connectedBefore = true;
          }
          // Group messages use their own channel: the group tone, vibration and a "<group>" / "<sender>: text" notification.
          if (event.type === 'group:message') {
            const alert = classifyIncoming(event, userId);
            if (event.message?.senderId !== userId) autoSaveIncoming(event.message?.content, sessionToken);
            if (alert && shouldAlertGroup({ groupId: alert.conversation.id, mutedGroupIds: readMutedGroups(userId), viewingGroupId: getViewingGroup(), pageVisible: document.visibilityState === 'visible' })) {
              playNotificationTone('group');
              vibrateFor('group');
              showSystemNotification('group', { ...groupNotificationText(event), messageId: event.message?.id, conversation: alert.conversation, onClick: () => openGroupRef.current?.(alert.conversation.id) });
            }
          }
          if (event.type === 'connection:ready') event.presence.forEach((item) => setPresence(item.userId, item.status, item.lastSeenAt));
          if (event.type === 'presence:update') setPresence(event.userId, event.status, event.lastSeenAt);
          if (event.type === 'presence:typing') setTyping(event.userId, event.active);
          if (event.type === 'message:new' || event.type === 'message:ack') {
            const { blockedChats, mutedChatIds } = useChatStore.getState();
            const incoming = event.type === 'message:new' && event.message.senderId !== userId;
            const silenced = mutedChatIds.includes(event.message.senderId)
              || hiddenByBlock(event.message, blockedChats[event.message.senderId], userId);
            addMessage(event.message);
            if (event.type === 'message:ack') acknowledgeMessage(event.message);
            // This device has it: tell the sender (one tick → two). Reading it is a separate, explicit step.
            if (incoming) autoSaveIncoming(event.message.content, sessionToken);
            if (incoming && event.message.receiverId === userId && event.message.status === 'sent') {
              realtime?.send({ type: 'message:delivered', messageIds: [event.message.id] });
            }
            if (incoming && !silenced) {
              playNotificationTone('message');
              vibrateFor('message');
              const sender = useChatStore.getState().chats.find((chat) => chat.id === event.message.senderId);
              showSystemNotification('message', {
                title: sender?.name ?? 'New message',
                body: notificationPreview(event.message.content),
                messageId: event.message.id,
                tag: `relay-message-${event.message.senderId}`,
                conversation: { kind: 'chat', id: event.message.senderId },
                onClick: () => openChatRef.current?.(event.message.senderId),
                count: sender?.unread ?? 0,
              });
            }
          }
          if (event.type === 'chat:disappearing') useChatStore.getState().setDisappearing(event.peerId, event.seconds);
          if (event.type === 'chat:cleared') useChatStore.getState().clearChat(event.peerId, event.keepIds);
          if (event.type === 'chat:deleted') useChatStore.getState().deleteChat(event.peerId, { kept: event.kept });
          if (event.type === 'user:updated') {
            useChatStore.getState().updateUserProfile(event.user);
            updateAccountUser(event.user).catch(() => {});
          }
          if (event.type === 'location:live') useChatStore.getState().applyLiveEvent(event, (payload) => realtime.send(payload));
          if (event.type === 'message:status') updateMessage(event.messageId, { status: event.status });
          if (event.type === 'message:played') updateMessage(event.messageId, { played: true });
          if (event.type === 'status:changed' || event.type === 'status:viewed') useChatStore.getState().bumpStatusRevision();
          if (event.type === 'message:updated') updateMessage(event.messageId, { content: event.content });
          if (event.type === 'poll:votes') useChatStore.getState().setPollVotes(event.messageId, event.votes);
          if (event.type === 'message:deleted') {
            // Deleted for everyone leaves WhatsApp's placeholder; deleted for me, or disappeared on a timer, goes away.
            if (event.scope === 'everyone' && event.reason !== 'expired') useChatStore.getState().markMessageDeleted(event.messageId);
            else useChatStore.getState().removeMessageById(event.messageId);
          }
          if (event.type === 'message:reaction') {
            const state = useChatStore.getState();
            state.applyReaction(event.messageId, event.userId, event.emoji);
            // A reaction to something I sent, from someone else, is a "like" worth a sound and a notice.
            // The server says whose message it was; older servers did not, so fall back to the messages we have.
            const mine = event.userId !== userId && (event.messageSenderId === userId
              || Object.values(state.messages).flat().some((message) => message.id === event.messageId && message.senderId === userId));
            if (mine && event.emoji && !state.mutedChatIds.includes(event.userId)) {
              playNotificationTone('reaction');
              vibrateFor('reaction');
              const reactor = state.chats.find((chat) => chat.id === event.userId);
              showSystemNotification('reaction', {
                title: reactor?.name ?? event.reactorName ?? 'Reaction',
                body: event.messageContent ? `Reacted ${event.emoji} to: “${notificationPreview(event.messageContent)}”` : `Reacted ${event.emoji} to your message`,
                tag: `relay-reaction-${event.messageId}`,
                messageId: `react:${event.messageId}:${event.emoji}`,
                conversation: { kind: 'chat', id: event.userId },
                onClick: () => openChatRef.current?.(event.userId),
              });
            }
          }
          if (event.type === 'message:delete:error') setFatalError(event.message);
          if (event.type === 'call:signal') {
            const active = callRef.current;
            // A pair offer for the room we are in is a participant joining: hand it to the overlay, no ringing.
            if (isRoomOffer(event, active) && !TERMINAL_STATUSES.includes(active.status)) {
              if (event.fromUser && !useChatStore.getState().chats.some((c) => c.id === event.from)) useChatStore.getState().addContact(event.fromUser);
              setCallSignals((current) => [...current, event]);
              return;
            }
            if (event.signal.type === 'offer' && (!active || active.id !== event.callId)) {
              // A blocked contact's call never rings on this device.
              if (isBlocked(useChatStore.getState().blockedChats[event.from])) return;
              if (active && !TERMINAL_STATUSES.includes(active.status)) {
                // Already on a call: the caller hears busy instead of ringing forever.
                realtime.send({ type: 'call:signal', targetId: event.from, callId: event.callId, mode: event.mode, signalId: crypto.randomUUID(), signal: { type: 'end', reason: 'busy' } });
                return;
              }
              // A call still showing its "ended" screen is finished; log it and let the new one ring.
              if (active) recordCallEnd(active);
              if (event.fromUser && !useChatStore.getState().chats.some((c) => c.id === event.from)) {
                useChatStore.getState().addContact(event.fromUser);
              }
              const incomingCall = { id: event.callId, roomId: event.roomId ?? event.callId, peerId: event.from, mode: event.mode, direction: 'incoming', status: 'idle', offer: event.signal, peerInfo: event.fromUser };
              callRef.current = incomingCall;
              setCall(incomingCall);
              setCallSignals([]);
              return;
            }
            // The active call consumes its own pair signals and those of the room's other pairs.
            if (active && (active.id === event.callId || (event.roomId && event.roomId === active.roomId))) setCallSignals((current) => [...current, event]);
          }
          if (event.type === 'call:invite') {
            const active = callRef.current;
            if (isBlocked(useChatStore.getState().blockedChats[event.from])) return;
            if (active && !TERMINAL_STATUSES.includes(active.status)) {
              if (active.roomId === event.roomId) return;
              realtime.send({ type: 'call:invite-reply', roomId: event.roomId, targetId: event.from, accepted: false, reason: 'busy' });
              return;
            }
            if (active) recordCallEnd(active);
            if (event.fromUser && !useChatStore.getState().chats.some((c) => c.id === event.from)) useChatStore.getState().addContact(event.fromUser);
            // The invitee rings like a normal incoming call; accepting places pair calls to everyone listed.
            const invited = { id: `${event.roomId}:${userId}:${event.from}`, roomId: event.roomId, peerId: event.from, mode: event.mode, direction: 'incoming', status: 'idle', invite: { participants: event.participants ?? [event.from] }, peerInfo: event.fromUser };
            callRef.current = invited;
            setCall(invited);
            setCallSignals([]);
          }
          if (event.type === 'call:invite-reply') {
            const active = callRef.current;
            if (active && active.roomId === event.roomId) setCallSignals((current) => [...current, event]);
          }
          if (event.type === 'error') {
            setFatalError(event.message);
            playNotificationTone('alert');
          }
        }, setConnection);
        realtime.onRevoked = () => revokedRef.current?.();
        realtime.onReady = async () => {
          const outbox = await getOutbox(userId);
          for (const message of outbox) realtime.send({ type: 'message:send', message });
        };
        setClient(realtime);
        useChatStore.getState().setClient(realtime);
        // Connect first: messages, ticks and calls must not wait for history. The cached chats are already on
        // screen; the contact list and every chat's history then load in parallel (they used to load one chat at a
        // time before connecting, which kept a 30-chat account offline for ~8 s on mobile data).
        realtime.connect();
        preloadLazyScreens();
        const contactResponse = await apiFetch('/api/v1/contacts', { headers: { Authorization: `Bearer ${sessionToken}` } });
        if (!contactResponse.ok) throw new Error('Could not load your Hidden Messenger contacts.');
        const contacts = await contactResponse.json();
        if (cancelled) return;
        setContacts(contacts);
        persistContacts(userId).catch(() => {});
        // The open chat first, then the rest, a few at a time.
        const active = useChatStore.getState().activeChatId;
        const ordered = [...contacts].sort((a, b) => Number(b.id === active) - Number(a.id === active));
        await forEachLimited(ordered, HISTORY_CONCURRENCY, async (contact) => {
          const response = await apiFetch(`/api/v1/messages?peerId=${contact.id}`, { headers: { Authorization: `Bearer ${sessionToken}` } });
          if (!cancelled && response.ok) mergeHistory(contact.id, await response.json());
        });
      } catch (error) {
        if (!cancelled) { setFatalError(error.message); setConnection('offline'); }
      }
    }
    boot();
    return () => { cancelled = true; realtime?.close(); setClient(null); useChatStore.getState().setClient(null); };
  }, [authReady, userId, sessionToken]);

  useEffect(() => { if (sessionToken) persistMessages(userId); }, [messages, sessionToken, userId]);
  useEffect(() => {
    if (!sessionToken || !activeChatId) return;
    const controller = new AbortController();
    apiFetch(`/api/v1/messages?peerId=${encodeURIComponent(activeChatId)}`, {
      headers: { Authorization: `Bearer ${sessionToken}` },
      signal: controller.signal,
    }).then(async (response) => {
      if (response.ok) mergeHistory(activeChatId, await response.json());
    }).catch((error) => {
      if (error.name !== 'AbortError') setFatalError('Could not load this conversation.');
    });
    return () => controller.abort();
  }, [activeChatId, mergeHistory, sessionToken]);
  
  useEffect(() => {
    if (call?.status === 'connected' && !callStartTimeRef.current) {
      callStartTimeRef.current = Date.now();
    }
  }, [call?.status, callStartTimeRef]);

  const chat = useMemo(() => chats.find((item) => item.id === activeChatId) ?? chats.find((item) => item.id !== userId), [activeChatId, chats, userId]);
  const callPeer = useMemo(() => {
    if (!call?.peerId) return null;
    const found = chats.find((item) => item.id === call.peerId || item.username === call.peerId);
    if (found) return found;
    if (call.peerInfo) return call.peerInfo;
    return { id: call.peerId, name: `@${call.peerId}`, initials: '??', color: 'blue' };
  }, [chats, call?.peerId, call?.peerInfo]);
  const connection = useChatStore((state) => state.connection);

  // Writes the call-log entry for a finished call and resets the duration clock.
  function recordCallEnd(finished) {
    const startedAt = callStartTimeRef.current;
    const duration = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;
    const status = startedAt ? 'completed' : finished.direction === 'incoming' ? 'missed' : 'no-answer';
    logCall(finished.peerId, { duration, mode: finished.mode, status, direction: finished.direction });
    callStartTimeRef.current = null;
  }

  function handleCallEnd() {
    if (call) recordCallEnd(call);
    callRef.current = null;
    setCall(null);
    setCallSignals([]);
    stopAllTones();
  }

  async function initiateCall(peerId, mode) {
    if (!peerId) return;
    const active = callRef.current;
    if (active && !TERMINAL_STATUSES.includes(active.status)) return;
    const targetChat = chats.find((c) => c.id === peerId || c.username === peerId);
    const resolvedId = targetChat?.id || peerId;
    // Calling links the two of you so signalling is allowed; it does not add them to the contact book.
    if (sessionToken) {
      try {
        await linkContact(sessionToken, resolvedId, { save: false });
      } catch {}
    }
    // An incoming call may have arrived while the contact request was in flight.
    if (callRef.current !== active) return;
    if (active) recordCallEnd(active);
    const callId = crypto.randomUUID();
    const outgoing = { id: callId, roomId: callId, peerId: resolvedId, mode, direction: 'outgoing', status: 'idle', peerInfo: targetChat };
    callRef.current = outgoing;
    setCall(outgoing);
    setCallSignals([]);
  }

  // A group call: the first chosen member is rung directly; the rest are invited into the room once connected.
  function initiateGroupCall({ mode, members, groupName }) {
    const active = callRef.current;
    if (active && !TERMINAL_STATUSES.includes(active.status)) return;
    const [first, ...rest] = members.filter((member) => member.id !== userId);
    if (!first) return;
    if (active) recordCallEnd(active);
    const callId = crypto.randomUUID();
    const outgoing = {
      id: callId, roomId: callId, peerId: first.id, mode, direction: 'outgoing', status: 'idle', peerInfo: first,
      members, groupName, pendingInvites: rest.map((member) => member.id),
    };
    callRef.current = outgoing;
    setCall(outgoing);
    setCallSignals([]);
    setGroupsOpen(false);
  }

  function toggleTheme() {
    const next = !darkMode;
    setDarkMode(next);
    localStorage.setItem('relay:theme', next ? 'dark' : 'light');
  }

  // Activates a session in the store and remembers it in the device's account list.
  function activateSession(session) {
    clearMediaCache();
    clearAvatarCache();
    useChatStore.getState().setUserId(session.user.id);
    setSession(session);
    setPairingOpen(false);
    setAuthOpen(false);
    setMobileListOpen(true);
    setAccountsOpen(false);
  }

  function acceptSession(session) {
    activateSession(session);
    addOrActivateAccount(session).catch(() => {});
  }

  async function switchAccount(id) {
    if (id === userId || switchingId) return;
    setSwitchingId(id);
    try {
      const account = getAccountsState().accounts.find((item) => item.id === id);
      const session = account ? await validateAccount(account) : null;
      if (!session) {
        await removeAccount(id);
        setFatalError('That account’s session has expired. Sign in to it again.');
        return;
      }
      await activateAccount(id);
      activateSession(session);
    } finally {
      setSwitchingId(null);
    }
  }

  function clearActiveSession() {
    clearMediaCache();
    clearAvatarCache();
    useChatStore.getState().setUserId('');
    useChatStore.getState().setSession({ user: null, deviceId: null, deviceName: null, token: null });
    setAuthOpen(false);
    setPairingOpen(false);
    setMobileListOpen(true);
    setGroupsOpen(false);
  }

  // Signs one account out of the server and forgets it here; logging out the active account moves to the next one.
  async function removeAccountFromDevice(id) {
    const account = getAccountsState().accounts.find((item) => item.id === id);
    try {
      if (account?.token) await apiFetch('/api/v1/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + account.token } });
    } catch { /* already invalid server-side */ }
    const next = await removeAccount(id);
    if (id !== userId) return;
    const following = next.accounts.find((item) => item.id === next.activeId);
    if (!following) { clearActiveSession(); setAccountsOpen(false); return; }
    const session = await validateAccount(following);
    if (session) activateSession(session);
    else { await removeAccount(following.id); clearActiveSession(); }
  }

  const logout = () => removeAccountFromDevice(userId);
  // Signed out from another device: drop this account here too (its token no longer works).
  revokedRef.current = () => removeAccountFromDevice(userId);

  const activeTab = isMobile ? mobileActiveTab : 'chats';
  const showMobileList = isMobile && activeTab === 'chats' && (mobileListOpen || !chat);
  const chatOpenOnMobile = isMobile && activeTab === 'chats' && !showMobileList;
  // Android Back: close the top screen (newest registered first); a chat goes back to the list, another tab to
  // Chats; with nothing left the app goes to the background instead of quitting.
  useBackHandler(isMobile && activeTab !== 'chats', () => setMobileActiveTab('chats'));
  useBackHandler(chatOpenOnMobile, () => setMobileListOpen(true));
  useBackHandler(notificationsOpen, () => setNotificationsOpen(false));
  useBackHandler(accountSettingsOpen, () => setAccountSettingsOpen(false));
  useBackHandler(accountsOpen, () => setAccountsOpen(false));
  useBackHandler(avatarStudioOpen, () => setAvatarStudioOpen(false));
  useBackHandler(pairingOpen, () => setPairingOpen(false));
  useEffect(() => onNative('backButton', () => { if (!handleBack()) nativeMoveToBackground(); }), []);
  // Shared from another app (Android share sheet): pick chats to send it to.
  useEffect(() => onNative('shareReceived', (raw) => setIncomingShare(parseShare(raw))), []);
  const closeShare = () => {
    setIncomingShare(null);
    nativeClearShare();
  };
  // Android picture-in-picture during a video call: only the call shows in the small window.
  // Status rings in the chat list: loaded at sign-in and again whenever someone posts, views or deletes a status.
  const statusRevision = useChatStore((state) => state.statusRevision ?? 0);
  useEffect(() => {
    if (!sessionToken) return undefined;
    let cancelled = false;
    fetchStatuses(sessionToken).then((feed) => { if (!cancelled) useChatStore.getState().setStatusRings(feed); }).catch(() => {});
    return () => { cancelled = true; };
  }, [sessionToken, statusRevision]);
  useEffect(() => onNative('pictureInPicture', ({ active }) => document.documentElement.classList.toggle('native-pip', Boolean(active))), []);
  // Group rows in the chat list come from the server listing, refreshed on every group:* socket event and reconnect.
  useEffect(() => {
    if (!sessionToken) { setGroupSummaries([]); return undefined; }
    const controller = new AbortController();
    apiFetch('/api/v1/groups', { headers: { Authorization: `Bearer ${sessionToken}` }, signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((list) => { if (Array.isArray(list)) setGroupSummaries(list); })
      .catch(() => {});
    return () => controller.abort();
  }, [sessionToken, groupRevision]);
  const mutedGroupIds = useMutedGroups(userId);
  const groupRows = useMemo(() => groupSummaries.map((group) => groupRow(group, userId, mutedGroupIds)), [groupSummaries, userId, mutedGroupIds]);
  const unreadChats = countUnreadConversations(chats, groupRows);
  const callLogs = useChatStore((state) => state.callLogs);
  const notificationSettings = useNotificationSettings();

  // Opening the Calls tab counts missed calls as viewed, which is what clears them from the badge.
  useEffect(() => {
    if (activeTab !== 'calls') return;
    const now = Date.now();
    setCallsSeenAt(now);
    localStorage.setItem('relay:calls-seen-at', String(now));
  }, [activeTab, callLogs]);

  useEffect(() => {
    applyAppBadge({ chats: [...chats, ...groupRows.filter((row) => !row.muted)], callLogs, callsSeenAt });
  }, [chats, groupRows, callLogs, callsSeenAt, notificationSettings.appBadge]);

  // Reminder sweep while the app stays open in the background.
  useEffect(() => {
    const unseen = () => badgeCount({ enabled: true, chats: useChatStore.getState().chats, callLogs: useChatStore.getState().callLogs, callsSeenAt });
    const timer = setInterval(() => maybeRemind({ unseenCount: unseen() }), 60_000);
    const onVisibility = () => { if (document.visibilityState === 'hidden') maybeRemind({ unseenCount: unseen() }); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisibility); };
  }, [callsSeenAt]);

  function openChat(contact) {
    useChatStore.getState().setActiveChat(contact.id);
    setMobileListOpen(false);
    setMobileActiveTab('chats');
  }
  function openGroups(create = false, groupId = '') {
    setGroupsCreate(create);
    setGroupsInitialId(typeof groupId === 'string' ? groupId : '');
    setGroupsOpen(true);
  }
  openChatRef.current = (id) => openChat({ id });
  openGroupRef.current = (id) => openGroups(false, id);

  // Notification clicks: the service worker posts the conversation to open; a cold start passes ?open=.
  // A tap that launches the app arrives before the account is restored, and restoring it resets the open chat, so
  // the request waits until someone is signed in and is applied right after (instead of landing on the chat list).
  const pendingOpenRef = useRef(null);
  useEffect(() => {
    const open = (value) => {
      const target = parseConversationOpenParam(value);
      if (!target) return;
      if (!userId) {
        pendingOpenRef.current = target;
        return;
      }
      if (target.kind === 'group') openGroupRef.current?.(target.id);
      else openChatRef.current?.(target.id);
    };
    if (userId && pendingOpenRef.current) {
      const target = pendingOpenRef.current;
      pendingOpenRef.current = null;
      if (target.kind === 'group') openGroupRef.current?.(target.id);
      else openChatRef.current?.(target.id);
    }
    const onMessage = (event) => { if (event.data?.type === 'notification:open') open(event.data.open); };
    navigator.serviceWorker?.addEventListener?.('message', onMessage);
    const stopNative = onNative('notificationOpen', (event) => open(event?.open));
    const url = new URL(window.location.href);
    const pending = url.searchParams.get('open');
    if (pending) {
      url.searchParams.delete('open');
      window.history.replaceState(null, '', url.pathname + url.search + url.hash);
      open(pending);
    }
    return () => {
      navigator.serviceWorker?.removeEventListener?.('message', onMessage);
      stopNative();
    };
  }, [userId]);

  // Android app: hand the account (and current mutes) to the background service, which keeps the phone reachable
  // after the app is swiped away. Refreshed whenever the app goes to the background so mute changes carry over.
  const mutedChatIds = useChatStore((state) => state.mutedChatIds);
  useEffect(() => {
    if (!nativeShell() || !userId || !sessionToken) return undefined;
    const origin = new URL(apiUrl('/api/v1/health'), window.location.href).origin;
    const sync = () => nativeSetSession({ origin, token: sessionToken, userId, mutedChats: useChatStore.getState().mutedChatIds ?? [], mutedGroups: readMutedGroups(userId), ...phoneSoundSession() });
    sync();
    const onHide = () => { if (document.visibilityState === 'hidden') sync(); };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [userId, sessionToken, mutedChatIds, mutedGroupIds, notificationSettings]);

  // Signed in: offer the permission walkthrough once per device; in the Android app keep the
  // background connection running (and stop it on sign-out). Native state is re-read on resume.
  useEffect(() => {
    if (!userId) {
      nativeClearSession();
      nativeStopBackground();
      return undefined;
    }
    let asked = false;
    try { asked = localStorage.getItem(PERMISSIONS_ASKED_KEY) === '1'; } catch { /* private mode */ }
    const needsWebPrompt = !nativeShell() && typeof Notification !== 'undefined' && Notification.permission === 'default';
    if (!asked && (nativeShell() || needsWebPrompt)) setPermissionsOpen(true);
    else if (nativeShell()) {
      nativeStartBackground();
      checkCallAccess();
    }
    nativeState();
    const refresh = () => { if (document.visibilityState === 'visible') nativeState(); };
    document.addEventListener('visibilitychange', refresh);
    return () => document.removeEventListener('visibilitychange', refresh);
  }, [userId]);

  // Android share sheet: keep its top row of recent chats in step with the chat list (debounced).
  useEffect(() => {
    if (!userId || !sessionToken || !nativeShell()) return undefined;
    const timer = setTimeout(() => publishShareShortcuts({ chats, groups: groupRows, userId, sessionToken }), 1500);
    return () => clearTimeout(timer);
  }, [chats, groupRows, userId, sessionToken]);

  // Lock-screen calls and the floating video window need Android switches: asked about once, like a standard app.
  async function checkCallAccess() {
    if (!nativeShell()) return;
    let askedBefore = false;
    try { askedBefore = localStorage.getItem(CALL_ACCESS_ASKED_KEY) === '1'; } catch { /* private mode */ }
    const state = await nativeState();
    if (shouldAskCallAccess(state, askedBefore)) setCallAccess(state);
  }

  // Motion preference goes on <html> so overlays rendered outside the shell follow it too.
  const appearance = useAppearance();
  useEffect(() => {
    document.documentElement.dataset.animations = animationsAttribute(appearance);
    document.documentElement.dataset.callAnimations = callAnimationsAttribute(appearance);
  }, [appearance]);

  return (
    <main className={`app-shell ${darkMode ? 'dark-theme' : ''} ${isMobile ? 'is-mobile' : ''} ${chatOpenOnMobile ? 'chat-open' : ''}`} data-animations={animationsAttribute(appearance)} data-call-animations={callAnimationsAttribute(appearance)}>
      <Sidebar onPair={() => setPairingOpen(true)} onSounds={() => setNotificationsOpen(true)} onNotifications={() => setNotificationsOpen(true)} onAccountSettings={() => setAccountSettingsOpen(true)} onSelectChat={() => setMobileListOpen(false)} onOpenAuth={() => setAuthOpen(true)} onAuthenticated={acceptSession} onLogout={logout} onAccounts={() => setAccountsOpen(true)} onGroups={() => openGroups()} groups={groupRows} onOpenGroup={(id) => openGroups(false, id)} />
      <div className="workspace">
        {activeTab === 'chats' ? (
          showMobileList || !chat
            ? <ChatsList onOpenChat={openChat} onStartCall={initiateCall} onGroups={openGroups} groups={groupRows} onOpenGroup={(id) => openGroups(false, id)} />
            : <ChatWindow key={chat.id} chat={chat} connection={connection} client={client} onPair={() => setPairingOpen(true)} onBack={() => setMobileListOpen(true)} onStartCall={(mode) => initiateCall(chat.id, mode)} onGroups={openGroups} />
        ) : activeTab === 'calls' ? (
          <CallsView onCall={initiateCall} />
        ) : activeTab === 'updates' ? (
          <UpdatesView />
        ) : activeTab === 'tools' ? (
          <ToolsView darkMode={darkMode} onToggleTheme={toggleTheme} onLogout={() => { logout(); }} onNotifications={() => setNotificationsOpen(true)} onAccountSettings={() => setAccountSettingsOpen(true)} onAccounts={() => setAccountsOpen(true)} onAvatarStudio={() => setAvatarStudioOpen(true)} onGroups={() => openGroups()} />
        ) : null}
        {activeTab === 'chats' && !isMobile && <footer className="workspace-footer"><span /><span className="workspace-footer-right"><button onClick={toggleTheme} title={`Switch to ${darkMode ? 'light' : 'dark'} theme`}>{darkMode ? <Sun size={14} /> : <Moon size={14} />}{darkMode ? 'Light' : 'Dark'}</button><ChevronRight size={13} /></span></footer>}
      </div>
      {isMobile && !chatOpenOnMobile && <MobileBottomNav activeTab={mobileActiveTab} onTabChange={setMobileActiveTab} unreadCount={unreadChats} />}
      {fatalError && <div className="status-toast"><Bell size={15} /><span>{fatalError}</span><button onClick={() => setFatalError('')}>Dismiss</button></div>}
      {pairingOpen && user && <PairingModal onClose={() => setPairingOpen(false)} token={sessionToken} userId={userId} />}
      {notificationsOpen && <NotificationSettings onClose={() => setNotificationsOpen(false)} />}
      {accountSettingsOpen && <AccountSettings onClose={() => setAccountSettingsOpen(false)} />}
      {accountsOpen && <AccountSwitcher busyId={switchingId} onSwitch={switchAccount} onRemove={removeAccountFromDevice} onAdd={() => { setAccountsOpen(false); setAuthOpen(true); }} onClose={() => setAccountsOpen(false)} />}
      {avatarStudioOpen && <AvatarStudio onClose={() => setAvatarStudioOpen(false)} />}
      {groupsOpen && sessionToken && <GroupsView key={userId} token={sessionToken} userId={userId} revision={groupRevision} initialCreate={groupsCreate} initialGroupId={groupsInitialId} onStartGroupCall={initiateGroupCall} onClose={() => setGroupsOpen(false)} />}
      {incomingShare && userId && sessionToken && (
        <ShareSheet
          share={incomingShare}
          groups={groupRows}
          userId={userId}
          sessionToken={sessionToken}
          onClose={closeShare}
          onDone={(targets) => {
            closeShare();
            // Like WhatsApp, sharing to one chat opens it.
            if (targets.length !== 1) return;
            if (targets[0].kind === 'group') openGroups(false, targets[0].id);
            else openChatRef.current?.(targets[0].id);
          }}
        />
      )}
      {permissionsOpen && userId && <PermissionsSheet onDone={() => { setPermissionsOpen(false); checkCallAccess(); }} />}
      {callAccess && !permissionsOpen && userId && <CallAccessSheet initial={callAccess} onDone={() => setCallAccess(null)} />}
      {authReady && (!userId || authOpen) && <UsernameGate onAuthenticated={acceptSession} onClose={userId ? () => setAuthOpen(false) : undefined} />}
      {call && callPeer && <CallOverlay
        key={call.id}
        call={call}
        peer={callPeer}
        client={client}
        sessionToken={sessionToken}
        signals={callSignals}
        onSignalHandled={(signalId) => setCallSignals((current) => current.filter((event) => event.signalId !== signalId))}
        onCallChange={setCall}
        onClose={handleCallEnd}
        onOpenChat={(id) => openChatRef.current?.(id)}
      />}
    </main>
  );
}
