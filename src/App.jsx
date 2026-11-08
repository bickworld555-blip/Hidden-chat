import { apiFetch } from './api.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { activateAccount, addOrActivateAccount, getAccountsState, loadAccounts, removeAccount, updateAccountUser } from './accounts.js';
import AccountSwitcher from './components/AccountSwitcher.jsx';
import AvatarStudio from './components/AvatarStudio.jsx';
import { Bell, ChevronRight, MessageSquarePlus, Moon, Sun } from 'lucide-react';
import { previewFor, useChatStore } from './store.js';
import { clearMediaCache } from './media.js';
import { clearAvatarCache } from './avatar.js';
import { RealtimeClient } from './realtime.js';
import { initialTabFromUrl } from './pwa.js';
import { countUnreadConversations, groupRow } from './groupRows.js';
import { useMutedGroups } from './groupPrefs.js';
import Sidebar from './components/Sidebar.jsx';
import ChatWindow from './components/ChatWindow.jsx';
import PairingModal from './components/PairingModal.jsx';
import UsernameGate from './components/UsernameGate.jsx';
import CallOverlay from './components/CallOverlay.jsx';
import NotificationSettings from './components/NotificationSettings.jsx';
import MobileBottomNav from './components/MobileBottomNav.jsx';
import CallsView from './components/CallsView.jsx';
import UpdatesView from './components/UpdatesView.jsx';
import ToolsView from './components/ToolsView.jsx';
import ChatsList from './components/ChatsList.jsx';
import GroupsView from './components/GroupsView.jsx';
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
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [avatarStudioOpen, setAvatarStudioOpen] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [groupsCreate, setGroupsCreate] = useState(false);
  const [groupRevision, setGroupRevision] = useState(0);
  const [groupsInitialId, setGroupsInitialId] = useState('');
  const [groupSummaries, setGroupSummaries] = useState([]);
  const [switchingId, setSwitchingId] = useState(null);
  const [callsSeenAt, setCallsSeenAt] = useState(() => Number(localStorage.getItem('relay:calls-seen-at')) || 0);
  const openChatRef = useRef(null);
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
        const contactResponse = await apiFetch('/api/v1/contacts', { headers: { Authorization: `Bearer ${sessionToken}` } });
        if (!contactResponse.ok) throw new Error('Could not load your Hidden Messenger contacts.');
        const contacts = await contactResponse.json();
        if (cancelled) return;
        setContacts(contacts);
        await persistContacts(userId);
        for (const contact of contacts) {
          const response = await apiFetch(`/api/v1/messages?peerId=${contact.id}`, { headers: { Authorization: `Bearer ${sessionToken}` } });
          if (cancelled) return;
          if (response.ok) mergeHistory(contact.id, await response.json());
        }
        if (cancelled) return;
        realtime = new RealtimeClient(sessionToken, (event) => {
          if (event.type === 'connection:ready' || (typeof event.type === 'string' && event.type.startsWith('group:'))) setGroupRevision((current) => current + 1);
          if (event.type === 'connection:ready') event.presence.forEach((item) => setPresence(item.userId, item.status));
          if (event.type === 'presence:update') setPresence(event.userId, event.status);
          if (event.type === 'presence:typing') setTyping(event.userId, event.active);
          if (event.type === 'message:new' || event.type === 'message:ack') {
            const { blockedChats, mutedChatIds } = useChatStore.getState();
            const incoming = event.type === 'message:new' && event.message.senderId !== userId;
            const silenced = mutedChatIds.includes(event.message.senderId)
              || hiddenByBlock(event.message, blockedChats[event.message.senderId], userId);
            addMessage(event.message);
            if (event.type === 'message:ack') acknowledgeMessage(event.message);
            if (incoming && !silenced) {
              playNotificationTone('message');
              vibrateFor('message');
              const sender = useChatStore.getState().chats.find((chat) => chat.id === event.message.senderId);
              showSystemNotification('message', {
                title: sender?.name ?? 'New message',
                body: previewFor(event.message.content),
                tag: `relay-message-${event.message.senderId}`,
                onClick: () => openChatRef.current?.(event.message.senderId),
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
          if (event.type === 'message:deleted') useChatStore.getState().removeMessageById(event.messageId);
          if (event.type === 'message:reaction') {
            const state = useChatStore.getState();
            state.applyReaction(event.messageId, event.userId, event.emoji);
            // A reaction to something I sent, from someone else, is a "like" worth a sound and a notice.
            const mine = event.userId !== userId && Object.values(state.messages).flat().find((message) => message.id === event.messageId && message.senderId === userId);
            if (mine && event.emoji && !state.mutedChatIds.includes(event.userId)) {
              playNotificationTone('reaction');
              vibrateFor('reaction');
              const reactor = state.chats.find((chat) => chat.id === event.userId);
              showSystemNotification('reaction', {
                title: reactor?.name ?? 'Reaction',
                body: `Reacted ${event.emoji} to your message`,
                tag: `relay-reaction-${event.messageId}`,
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
        realtime.onReady = async () => {
          const outbox = await getOutbox(userId);
          for (const message of outbox) realtime.send({ type: 'message:send', message });
        };
        setClient(realtime);
        useChatStore.getState().setClient(realtime);
        realtime.connect();
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
    if (!sessionToken) return;
    const peerId = activeChatId;
    const incoming = useChatStore.getState().messages[peerId] ?? [];
    incoming.filter((message) => message.receiverId === userId && message.status !== 'read')
      .forEach((message) => client?.send({ type: 'message:read', messageId: message.id }));
  }, [activeChatId, client, sessionToken, userId]);

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

  const activeTab = isMobile ? mobileActiveTab : 'chats';
  const showMobileList = isMobile && activeTab === 'chats' && (mobileListOpen || !chat);
  const chatOpenOnMobile = isMobile && activeTab === 'chats' && !showMobileList;
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

  // Motion preference goes on <html> so overlays rendered outside the shell follow it too.
  const appearance = useAppearance();
  useEffect(() => {
    document.documentElement.dataset.animations = animationsAttribute(appearance);
    document.documentElement.dataset.callAnimations = callAnimationsAttribute(appearance);
  }, [appearance]);

  return (
    <main className={`app-shell ${darkMode ? 'dark-theme' : ''} ${isMobile ? 'is-mobile' : ''} ${chatOpenOnMobile ? 'chat-open' : ''}`} data-animations={animationsAttribute(appearance)} data-call-animations={callAnimationsAttribute(appearance)}>
      <Sidebar onPair={() => setPairingOpen(true)} onSounds={() => setNotificationsOpen(true)} onNotifications={() => setNotificationsOpen(true)} onSelectChat={() => setMobileListOpen(false)} onOpenAuth={() => setAuthOpen(true)} onAuthenticated={acceptSession} onLogout={logout} onAccounts={() => setAccountsOpen(true)} onGroups={() => openGroups()} groups={groupRows} onOpenGroup={(id) => openGroups(false, id)} />
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
          <ToolsView darkMode={darkMode} onToggleTheme={toggleTheme} onLogout={() => { logout(); }} onNotifications={() => setNotificationsOpen(true)} onAccounts={() => setAccountsOpen(true)} onAvatarStudio={() => setAvatarStudioOpen(true)} onGroups={() => openGroups()} />
        ) : null}
        {activeTab === 'chats' && !isMobile && <footer className="workspace-footer"><span><i /> Hidden Messenger workspace</span><span className="workspace-footer-right">Demo mode <span>·</span><button onClick={toggleTheme} title={`Switch to ${darkMode ? 'light' : 'dark'} theme`}>{darkMode ? <Sun size={14} /> : <Moon size={14} />}{darkMode ? 'Light' : 'Dark'}</button><ChevronRight size={13} /></span></footer>}
      </div>
      {isMobile && !chatOpenOnMobile && <MobileBottomNav activeTab={mobileActiveTab} onTabChange={setMobileActiveTab} unreadCount={unreadChats} />}
      {fatalError && <div className="status-toast"><Bell size={15} /><span>{fatalError}</span><button onClick={() => setFatalError('')}>Dismiss</button></div>}
      {pairingOpen && user && <PairingModal onClose={() => setPairingOpen(false)} token={sessionToken} userId={userId} />}
      {notificationsOpen && <NotificationSettings onClose={() => setNotificationsOpen(false)} />}
      {accountsOpen && <AccountSwitcher busyId={switchingId} onSwitch={switchAccount} onRemove={removeAccountFromDevice} onAdd={() => { setAccountsOpen(false); setAuthOpen(true); }} onClose={() => setAccountsOpen(false)} />}
      {avatarStudioOpen && <AvatarStudio onClose={() => setAvatarStudioOpen(false)} />}
      {groupsOpen && sessionToken && <GroupsView key={userId} token={sessionToken} userId={userId} revision={groupRevision} initialCreate={groupsCreate} initialGroupId={groupsInitialId} onStartGroupCall={initiateGroupCall} onClose={() => setGroupsOpen(false)} />}
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
      />}
    </main>
  );
}
