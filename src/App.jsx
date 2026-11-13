import { acknowledgeEvents, acknowledgeSaved } from './deliveryAck.js';
import { apiFetch, apiUrl, isNetworkFailure } from './api.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cachedGroups, prefetchGroupDetails, saveGroups } from './groupCache.js';
import { activateAccount, addOrActivateAccount, getAccountsState, loadAccounts, removeAccount, sessionFromAccount, updateAccountUser } from './accounts.js';
import { Bell, ChevronRight, MessageSquarePlus, Moon, Sun } from 'lucide-react';
import { flushPersistedMessages, notificationPreview, savedMessageCount, useChatStore } from './store.js';
import { runScheduledBackup, shouldOfferRestore } from './cloudBackup.js';
import RestoreBackupSheet from './components/RestoreBackupSheet.jsx';
import { fetchStatuses } from './statusApi.js';
import { clearMediaCache } from './media.js';
import { clearAvatarCache } from './avatar.js';
import { RealtimeClient } from './realtime.js';
import { initialTabFromUrl } from './pwa.js';
import { countUnreadConversations, groupRow } from './groupRows.js';
import { getViewingGroup, readMutedGroups, setGroupMuted, useMutedGroups } from './groupPrefs.js';
import { classifyIncoming, groupNotificationText, parseConversationOpenParam, shouldAlertGroup } from './notificationChannels.js';
import { nativeClearSession, nativeRequestStartupPermissions, nativeSetSession, nativeShell, nativeStartBackground, nativeState, nativeStopBackground, nativeTakePendingCall, nativeMoveToBackground, nativeClearShare, nativeSetCallActive, nativeClearMessageNotifications, nativeClearMissedCalls, nativeTakeMessageActions, nativeSetSystemBarsTheme, onNative } from './native.js';
import { parseShare } from './shareTarget.js';
import { onE2eEvent, startE2e, stopE2e } from './e2e/client.js';
import { fetchGroupMessages } from './groupHistory.js';
import { SECURITY_NOTICE } from './e2e/notices.js';
import { LOCKED_NOTIFICATION } from './chatLock.js';
import { handleReactionError, handleRejected, needsOpening, openEvent, openHistory, openRows, transmitDirect } from './e2e/messaging.js';
import { connectAccountSettings } from './settings.js';
import { getPrivacy, setPrivacy } from './accountApi.js';
import ShareSheet from './components/ShareSheet.jsx';
import { publishShareShortcuts } from './shareShortcuts.js';
import { permissionsAskedKey } from './permissionsKey.js';
import Sidebar from './components/Sidebar.jsx';
import ChatWindow from './components/ChatWindow.jsx';
import UsernameGate from './components/UsernameGate.jsx';
import CallOverlay from './components/CallOverlay.jsx';
import { syncMissedMessages } from './messageSync.js';
import { HISTORY_CONCURRENCY, forEachLimited } from './concurrency.js';
import MobileBottomNav from './components/MobileBottomNav.jsx';
import DesktopRail from './components/DesktopRail.jsx';
import { takePendingHistory } from './linking.js';
import { validateBackupData } from './backup.js';
import { SIGNED_IN_HINT } from './site/links.js';
import ChatsList from './components/ChatsList.jsx';
import { lazyComponent, preloadLazyScreens } from './lazy.js';
import { handleBack, useBackHandler } from './backStack.js';
import { phoneSoundSession } from './phoneSounds.js';
import { autoSaveIncoming } from './mediaSave.js';
const AccountSwitcher = lazyComponent(() => import('./components/AccountSwitcher.jsx'));
const AvatarStudio = lazyComponent(() => import('./components/AvatarStudio.jsx'));
const PermissionsSheet = lazyComponent(() => import('./components/PermissionsSheet.jsx'));
const NotificationSettings = lazyComponent(() => import('./components/NotificationSettings.jsx'));
const StatusQuickView = lazyComponent(() => import('./components/UpdatesView.jsx'), (module) => module.StatusQuickView);
const AccountSettings = lazyComponent(() => import('./components/AccountSettings.jsx'));
const CallsView = lazyComponent(() => import('./components/CallsView.jsx'));
const UpdatesView = lazyComponent(() => import('./components/UpdatesView.jsx'));
const ToolsView = lazyComponent(() => import('./components/ToolsView.jsx'));
const GroupsView = lazyComponent(() => import('./components/GroupsView.jsx'));
// WhatsApp (Business) parity screens.
const CommunitiesView = lazyComponent(() => import('./components/parity/CommunitiesView.jsx'));
const BusinessTools = lazyComponent(() => import('./components/parity/BusinessTools.jsx'));
const VerifiedPanel = lazyComponent(() => import('./components/parity/VerifiedPanel.jsx'));
const StarredMessages = lazyComponent(() => import('./components/parity/StarredMessages.jsx'));
const extrasPanels = () => import('./components/extras/ExtrasPanels.jsx');
const BroadcastLists = lazyComponent(extrasPanels, (module) => module.BroadcastLists);
const Channels = lazyComponent(extrasPanels, (module) => module.Channels);
const ScheduledMessages = lazyComponent(extrasPanels, (module) => module.ScheduledMessages);
const CallLinks = lazyComponent(extrasPanels, (module) => module.CallLinks);
const InviteFriend = lazyComponent(() => import('./components/parity/InviteFriend.jsx'));
import { SUPPORT_EVENT } from './supportApi.js';
const HelpCenter = lazyComponent(() => import('./components/HelpCenter.jsx'));
const ListsManager = lazyComponent(() => import('./components/ChatLists.jsx'), (module) => module.ListsManager);
const JoinCallLink = lazyComponent(extrasPanels, (module) => module.JoinCallLink);
const StatusPrivacy = lazyComponent(extrasPanels, (module) => module.StatusPrivacy);
const LanguageSettings = lazyComponent(() => import('./components/extras/LanguageSettings.jsx'));
const BackupView = lazyComponent(() => import('./components/parity/BackupView.jsx'));
const StorageView = lazyComponent(() => import('./components/parity/StorageView.jsx'));
const JoinGroupSheet = lazyComponent(() => import('./components/parity/GroupAdmin.jsx'), (module) => module.JoinGroupSheet);
const TwoStepReminder = lazyComponent(() => import('./components/parity/SecurityViews.jsx'), (module) => module.TwoStepReminder);
import { AppLockGate } from './components/parity/SecurityViews.jsx';
import { connectAccountData, handleAccountEvent } from './accountData.js';
import { applyScreenSecurity, startAppLock } from './appLock.js';
import { mentionsUser } from './mentions.js';

// A call link opened in the app: /call/<code>.
function callLinkFromLocation(location = globalThis.location) {
  const match = /^\/call\/([A-Za-z0-9_-]{16})\/?$/.exec(location?.pathname ?? '');
  return match ? match[1] : '';
}

// A business short link opened in the app: /u/<username>[?text=...] (Business tools › Short link).
export function shortLinkFromLocation(location = globalThis.location) {
  const match = /^\/u\/([A-Za-z0-9_]{3,24})\/?$/.exec(location?.pathname ?? '');
  if (!match) return null;
  const text = new URLSearchParams(location?.search ?? '').get('text') ?? '';
  return { username: match[1].toLowerCase(), text: text.slice(0, 1000) };
}

// A group invite link opened in the app: /join/<code>.
function inviteCodeFromLocation(location = globalThis.location) {
  const match = /^\/join\/([A-Za-z0-9_-]{16,64})\/?$/.exec(location?.pathname ?? '');
  return match ? match[1] : '';
}
import { playNotificationTone, stopAllTones } from './sounds.js';
import { applyAppBadge, maybeRemind, showSystemNotification, vibrateFor } from './notify.js';
import { badgeCount, unseenMissedCalls, useNotificationSettings } from './notificationSettings.js';
import { hiddenByBlock, isBlocked } from './blocking.js';
import { fetchBlocks } from './blocksApi.js';
import { activityFromEvent } from './typing.js';
import { TERMINAL_STATUSES } from './callEngine.js';
import { isRoomOffer } from './callRoom.js';
import { animationsAttribute, callAnimationsAttribute, startsDark, THEME_KEY, useAppearance } from './appearance.js';
import { useFontSize, useHighContrast } from './displayPrefs.js';
import { linkContact, searchPeople } from './contactsApi.js';
import { deviceStorage } from './deviceStorage.js';
import { storageProblemText, useStorageProblem } from './storageHealth.js';

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
  const fontSize = useFontSize();
  const highContrast = useHighContrast();
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
  const waitingTimerRef = useRef(null);
  useEffect(() => () => clearInterval(waitingTimerRef.current), []);
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
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [avatarStudioOpen, setAvatarStudioOpen] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [groupsCreate, setGroupsCreate] = useState(false);
  const [groupRevision, setGroupRevision] = useState(0);
  const [groupsInitialId, setGroupsInitialId] = useState('');
  // Business tools, communities, starred messages, backup and storage open as full-screen panels.
  const [paritySheet, setParitySheet] = useState(null);
  const [inviteCode, setInviteCode] = useState(() => inviteCodeFromLocation());
  const [shortLink, setShortLink] = useState(() => shortLinkFromLocation());
  const [callLinkCode, setCallLinkCode] = useState(() => callLinkFromLocation());
  useEffect(() => {
    if (callLinkCode && globalThis.history?.replaceState) globalThis.history.replaceState(null, '', '/');
  }, [callLinkCode]);
  const [groupSummaries, setGroupSummaries] = useState([]);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  // Something shared to Hidden Messenger from another app's share sheet, waiting for the user to pick chats.
  const [incomingShare, setIncomingShare] = useState(null);
  // Android blocks lock-screen calls or the floating video window for this app: the native state, to ask once.
  const [switchingId, setSwitchingId] = useState(null);
  const [callsSeenAt, setCallsSeenAt] = useState(() => Number(deviceStorage.getItem('relay:calls-seen-at')) || 0);
  const openChatRef = useRef(null);
  const openGroupRef = useRef(null);
  const revokedRef = useRef(null);
  const removingRef = useRef(new Set());
  const [authOpen, setAuthOpen] = useState(false);
  // Light unless this device chose dark (src/appearance.js).
  const [darkMode, setDarkMode] = useState(() => startsDark(deviceStorage));
  const [fatalError, setFatalError] = useState('');
  const [mobileListOpen, setMobileListOpen] = useState(true);
  const [authReady, setAuthReady] = useState(false);
  const [mobileActiveTab, setMobileActiveTab] = useState(initialTabFromUrl);
  const [call, setCall] = useState(null);
  // End-to-end encryption (src/e2e/): this device's keys are created and published once signed in; every message
  // to and from it is sealed per device. A contact's security code change shows as a notice.
  const deviceId = useChatStore((state) => state.device?.id ?? null);
  useEffect(() => {
    if (!sessionToken || !userId || !deviceId) {
      stopE2e();
      return;
    }
    startE2e({ token: sessionToken, userId, deviceId }).catch(() => { /* retried on the next refresh */ });
  }, [sessionToken, userId, deviceId]);
  useEffect(() => onE2eEvent((event) => {
    if (event.type !== 'identity-changed') return;
    const state = useChatStore.getState();
    if (!state.userId || !state.chats.some((chat) => chat.id === event.userId)) return;
    // A notice in the conversation, kept on this device only (never sent).
    state.addMessage({ id: crypto.randomUUID(), senderId: state.userId, receiverId: event.userId, timestamp: new Date().toISOString(), content: SECURITY_NOTICE, status: 'read' });
  }), []);
  // Starred messages, archived chats, labels, quick replies and two-step status follow the account (accountData.js).
  useEffect(() => {
    connectAccountData(sessionToken && userId ? sessionToken : null).catch(() => {});
  }, [sessionToken, userId]);
  // App lock (after the chosen time away) and screen security apply to this device whoever is signed in.
  useEffect(() => {
    applyScreenSecurity();
    return startAppLock();
  }, []);
  // An invite link was opened: forget the path once the sheet is shown, so a reload doesn't reopen it.
  useEffect(() => {
    if (inviteCode && globalThis.history?.replaceState) globalThis.history.replaceState(null, '', '/');
  }, [inviteCode]);
  // Account settings (privacy) live on the server and follow the signed-in account (src/settings.js).
  useEffect(() => {
    if (!sessionToken || !userId) {
      connectAccountSettings(null);
      return;
    }
    connectAccountSettings({ load: () => getPrivacy(sessionToken), save: (patch) => setPrivacy(sessionToken, patch) });
  }, [sessionToken, userId]);
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
        let session;
        try {
          session = await validateAccount(account);
        } catch {
          // Offline (or the server is unreachable): local-first, so the saved account opens with its chats from this
          // device; the token is checked again once the connection is back.
          session = account.user?.id ? sessionFromAccount(account) : undefined;
          if (!session) throw new Error('offline without a saved profile');
        }
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
        const handleEvent = (event) => {
          if (event.type === 'connection:ready' || event.type === 'community:changed' || (typeof event.type === 'string' && event.type.startsWith('group:'))) setGroupRevision((current) => current + 1);
          handleAccountEvent(event);
          // Blocked or unblocked on another of this account's devices; a contact deleted their account.
          if (event.type === 'block:changed' && typeof event.userId === 'string') {
            const store = useChatStore.getState();
            const others = Object.entries(store.blockedChats).filter(([id, periods]) => id !== event.userId && isBlocked(periods)).map(([id]) => id);
            store.applyServerBlocks(event.blocked ? [...others, event.userId] : others);
          }
          if (event.type === 'account:deleted' && typeof event.userId === 'string') useChatStore.getState().markAccountDeleted(event.userId);
          // Hidden Messenger Support answered (or this account wrote from another device): the open support chat shows it.
          if (event.type === 'support:message' && event.message?.id) window.dispatchEvent(new CustomEvent(SUPPORT_EVENT, { detail: event.message }));
          if (event.type === 'message:edited') updateMessage(event.messageId, { content: event.content, editedAt: event.editedAt, ...(event.e2eError ? { e2eError: event.e2eError } : {}) });
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
              syncMissedMessages({ sessionToken, userId, open: openRows, acknowledge: (ids) => realtime?.send({ type: 'message:delivered', messageIds: ids }) })
                .catch(() => { /* the next reconnect retries */ });
            }
            connectedBefore = true;
          }
          // Group messages use their own channel: the group tone, vibration and a "<group>" / "<sender>: text" notification.
          if (event.type === 'group:message') {
            // Kept on this device as it arrives (opened above), like a one-to-one message; saving acknowledges it.
            if (typeof event.message?.groupId === 'string') useChatStore.getState().mergeGroupMessages(event.message.groupId, [event.message]);
            const alert = classifyIncoming(event, userId);
            if (event.message?.senderId !== userId) autoSaveIncoming(event.message?.content, sessionToken);
            const mentioned = mentionsUser(event.message?.content, useChatStore.getState().user?.username);
            const mutedGroupIds = readMutedGroups(userId).filter((id) => !(mentioned && id === alert?.conversation.id));
            if (alert && shouldAlertGroup({ groupId: alert.conversation.id, mutedGroupIds, viewingGroupId: getViewingGroup(), pageVisible: document.visibilityState === 'visible' })) {
              playNotificationTone('group');
              vibrateFor('group');
              showSystemNotification('group', { ...groupNotificationText(event), messageId: event.message?.id, conversation: alert.conversation, onClick: () => openGroupRef.current?.(alert.conversation.id) });
            }
          }
          if (event.type === 'connection:ready') event.presence.forEach((item) => setPresence(item.userId, item.status, item.lastSeenAt));
          if (event.type === 'presence:update') setPresence(event.userId, event.status, event.lastSeenAt);
          if (event.type === 'presence:typing' && typeof event.groupId === 'string') useChatStore.getState().setGroupTyping(event.groupId, event.userId, activityFromEvent(event), event.name);
          else if (event.type === 'presence:typing') setTyping(event.userId, activityFromEvent(event));
          if (event.type === 'group:message' && event.message?.senderId !== userId) useChatStore.getState().setGroupTyping(event.message?.groupId, event.message?.senderId, null);
          // Their message arrived: they stopped typing (or recording) it.
          if (event.type === 'message:new' && event.message?.senderId !== userId && !event.message?.groupId) setTyping(event.message?.senderId, null);
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
              // A locked chat's notification names no one and shows no text (src/chatLock.js).
              const locked = (useChatStore.getState().lockedChatIds ?? []).includes(event.message.senderId);
              showSystemNotification('message', {
                title: locked ? LOCKED_NOTIFICATION.title : sender?.name ?? 'New message',
                body: locked ? LOCKED_NOTIFICATION.body : notificationPreview(event.message.content),
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
          if (event.type === 'poll:votes') useChatStore.getState().setPollVotes(event.messageId, { votes: event.votes ?? {}, sealedVotes: event.sealedVotes ?? [] });
          if (event.type === 'message:deleted') {
            // Deleted for everyone leaves WhatsApp's placeholder; deleted for me, or disappeared on a timer, goes away.
            if (event.scope === 'everyone' && event.reason !== 'expired') useChatStore.getState().markMessageDeleted(event.messageId);
            else useChatStore.getState().removeMessageById(event.messageId);
          }
          if (event.type === 'message:reaction') {
            // An encrypted reaction this device could not open changes nothing.
            if (event.emoji === null && event.sealed) return;
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
        };
        // Events that may carry ciphertext are opened in arrival order before they are handled (src/e2e/messaging.js).
        let openChain = Promise.resolve();
        realtime = new RealtimeClient(sessionToken, (event) => {
          if (event?.type === 'message:reaction:error' && handleReactionError(event, realtime)) return;
          if (event?.type === 'message:rejected') {
            handleRejected(event, realtime).catch(() => {});
            return;
          }
          if (!needsOpening(event)) {
            handleEvent(event);
            return;
          }
          openChain = openChain.then(() => openEvent(event)).then(handleEvent).catch((error) => console.error('Could not handle a message:', error));
        }, setConnection);
        realtime.onRevoked = () => revokedRef.current?.();
        let contactsLoaded = false;
        const loadContacts = async () => {
          const contactResponse = await apiFetch('/api/v1/contacts', { headers: { Authorization: `Bearer ${sessionToken}` } });
          if (!contactResponse.ok) throw new Error('Could not load your Hidden Messenger contacts.');
          const contacts = await contactResponse.json();
          if (cancelled) return [];
          setContacts(contacts);
          // The block list follows the account (server/blocks.mjs): blocks made or lifted on another device apply here.
          fetchBlocks(sessionToken).then((list) => { if (!cancelled) useChatStore.getState().applyServerBlocks(list.map((user) => user.id)); }).catch(() => {});
          persistContacts(userId).catch(() => {});
          contactsLoaded = true;
          return contacts;
        };
        realtime.onReady = async () => {
          const outbox = await getOutbox(userId);
          for (const message of outbox) await transmitDirect(realtime, message);
          // What waited on the server for this device while it was away (src/deliveryAck.js): messages are opened
          // and saved like history (then acknowledged once saved); receipts and other changes are applied.
          try {
            const response = await apiFetch('/api/v1/queue', { headers: { Authorization: `Bearer ${sessionToken}` } });
            if (!response.ok || cancelled) return;
            const queued = await response.json();
            const byChat = new Map();
            for (const message of queued.messages ?? []) {
              const chatId = message.senderId === userId ? message.receiverId : message.senderId;
              if (!byChat.has(chatId)) byChat.set(chatId, []);
              byChat.get(chatId).push(message);
            }
            // Started offline (the contact list never loaded), or someone new wrote meanwhile: their chat row comes
            // from the contact list, so it is loaded first; otherwise the message is saved but has no row to show in.
            const known = new Set(useChatStore.getState().chats.map((chat) => chat.id));
            if (!contactsLoaded || [...byChat.keys()].some((chatId) => !known.has(chatId))) await loadContacts().catch(() => {});
            const waiting = [];
            for (const [chatId, rows] of byChat) {
              const opened = await openHistory(chatId, rows);
              mergeHistory(chatId, opened);
              waiting.push(...opened);
            }
            // Saved before but never acknowledged (a big attachment waiting for Wi-Fi, a save that failed): saved now if
            // they are not on disk yet, then acknowledged, each attachment fetched first. Only after a successful save.
            if (waiting.length) {
              useChatStore.getState().persistMessages(userId);
              if (await flushPersistedMessages()) acknowledgeSaved(waiting, { client: realtime, sessionToken }).catch(() => {});
            }
            // Group messages that waited for this device: each group's history is fetched, opened and saved here (then
            // acknowledged once saved), whether or not the group is opened; the server keeps them until then.
            const waitingGroups = [...new Set((queued.groupMessages ?? []).map((row) => row?.groupId).filter((id) => typeof id === 'string'))];
            for (const groupId of waitingGroups) {
              if (cancelled) return;
              try {
                useChatStore.getState().mergeGroupMessages(groupId, await fetchGroupMessages(sessionToken, groupId));
              } catch (error) {
                console.error('Could not save a group’s waiting messages:', error);
              }
            }
            const events = (queued.events ?? []).filter((event) => event?.id && event.type);
            for (const event of events) handleEvent(needsOpening(event) ? await openEvent(event) : event);
            if (events.length) await acknowledgeEvents(events.map((event) => event.id), { client: realtime, sessionToken });
          } catch (error) {
            console.error('Could not read the delivery queue:', error);
          }
        };
        // Messages waiting for a contact's keys (strict end-to-end encryption) are retried every 30 s.
        clearInterval(waitingTimerRef.current);
        waitingTimerRef.current = setInterval(async () => {
          const state = useChatStore.getState();
          if (state.connection !== 'online') return;
          const outbox = await state.getOutbox(userId);
          const waiting = new Set(Object.values(state.messages).flat().filter((message) => message.awaitingKeys).map((message) => message.id));
          for (const message of outbox) if (waiting.has(message.id)) await transmitDirect(realtime, { ...message, awaitingKeys: true });
        }, 30_000);
        setClient(realtime);
        useChatStore.getState().setClient(realtime);
        // Connect first: messages, ticks and calls must not wait for history. The cached chats are already on
        // screen; the contact list and every chat's history then load in parallel (they used to load one chat at a
        // time before connecting, which kept a 30-chat account offline for ~8 s on mobile data).
        realtime.connect();
        preloadLazyScreens();
        const contacts = await loadContacts();
        if (cancelled) return;
        // The open chat first, then the rest, a few at a time.
        const active = useChatStore.getState().activeChatId;
        const ordered = [...contacts].sort((a, b) => Number(b.id === active) - Number(a.id === active));
        await forEachLimited(ordered, HISTORY_CONCURRENCY, async (contact) => {
          const response = await apiFetch(`/api/v1/messages?peerId=${contact.id}`, { headers: { Authorization: `Bearer ${sessionToken}` } });
          if (!cancelled && response.ok) mergeHistory(contact.id, await openHistory(contact.id, await response.json()));
        });
      } catch (error) {
        if (cancelled) return;
        setConnection('offline');
        // No network: everything shown comes from this device, and the connection status already says offline, so a
        // raw "Failed to fetch" adds nothing. Other failures (a refused request) are still reported.
        if (!isNetworkFailure(error)) setFatalError(error.message);
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
      if (response.ok) mergeHistory(activeChatId, await openHistory(activeChatId, await response.json()));
    }).catch((error) => {
      // Offline the conversation shows from this device; only a refused request is worth a notice.
      if (error.name !== 'AbortError' && !isNetworkFailure(error)) setFatalError('Could not load this conversation.');
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

  // "Call back" on Android's missed-call notification.
  const initiateCallRef = useRef(null);
  useEffect(() => onNative('callBack', ({ peerId, mode } = {}) => {
    if (typeof peerId === 'string' && peerId) initiateCallRef.current?.(peerId, mode === 'video' ? 'video' : 'audio');
  }), []);

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
  function initiateGroupCall({ mode, members, groupName, groupId = '' }) {
    const active = callRef.current;
    if (active && !TERMINAL_STATUSES.includes(active.status)) return;
    const [first, ...rest] = members.filter((member) => member.id !== userId);
    if (!first) return;
    if (active) recordCallEnd(active);
    const callId = crypto.randomUUID();
    const outgoing = {
      id: callId, roomId: callId, peerId: first.id, mode, direction: 'outgoing', status: 'idle', peerInfo: first,
      members, groupName, groupId, pendingInvites: rest.map((member) => member.id),
    };
    callRef.current = outgoing;
    setCall(outgoing);
    setCallSignals([]);
    setGroupsOpen(false);
  }

  // The phone's status and navigation bar icons follow the theme (white icons vanish on the light theme).
  useEffect(() => { nativeSetSystemBarsTheme(darkMode ? 'dark' : 'light'); }, [darkMode]);

  function toggleTheme() {
    const next = !darkMode;
    setDarkMode(next);
    deviceStorage.setItem(THEME_KEY, next ? 'dark' : 'light');
  }

  // Activates a session in the store and remembers it in the device's account list.
  function activateSession(session) {
    clearMediaCache();
    clearAvatarCache();
    useChatStore.getState().setUserId(session.user.id);
    setSession(session);
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
    setMobileListOpen(true);
    setGroupsOpen(false);
  }

  // Signs one account out of the server and forgets it here; logging out the active account moves to the next one.
  // Signing out closes that session's socket (code 4001), which reports "signed out" for the same account again;
  // `removingRef` makes that echo a no-op instead of a second switch that would empty the next account's chats.
  async function removeAccountFromDevice(id) {
    if (removingRef.current.has(id)) return;
    removingRef.current.add(id);
    try {
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
    } finally {
      removingRef.current.delete(id);
    }
  }

  const logout = () => removeAccountFromDevice(userId);
  // Signed out from another device: drop this account here too (its token no longer works).
  revokedRef.current = () => removeAccountFromDevice(userId);

  // The web app's left rail picks a section too (Chats, Updates, Communities, Calls, Settings).
  const [desktopTab, setDesktopTab] = useState('chats');
  // The public site sends signed-in visitors straight here (src/main.jsx reads this hint).
  useEffect(() => {
    try {
      if (sessionToken) deviceStorage.setItem(SIGNED_IN_HINT, '1');
      else deviceStorage.removeItem(SIGNED_IN_HINT);
    } catch { /* the hint is a convenience only */ }
  }, [sessionToken]);
  // A browser linked by QR code: the phone sent recent chats end to end; merge them once (src/linking.js).
  useEffect(() => {
    if (!sessionToken || !userId) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      // Parts arrive newest first; each is merged as it comes (a damaged or foreign part is skipped).
      takePendingHistory(async (data) => {
        if (cancelled) return;
        try {
          validateBackupData(data, userId);
          useChatStore.getState().restoreBackup(data);
        } catch { /* skip this part */ }
      }).catch(() => { /* the chats still arrive as new messages come in */ });
    }, 1500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [sessionToken, userId]);
  // The admin console is its own page at /admin (admin.html, src/admin/), not part of the chat app.
  // Approximate country for aggregate statistics: the device's time zone, at most once a day (server/regions.mjs).
  useEffect(() => {
    if (!sessionToken || !userId) return;
    const key = `hm:region-sent:${userId}`;
    const today = new Date().toISOString().slice(0, 10);
    try { if (deviceStorage.getItem(key) === today) return; } catch { /* send anyway */ }
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!timeZone) return;
    apiFetch('/api/v1/me/region', { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ timeZone }) })
      .then((response) => { if (response.ok) try { deviceStorage.setItem(key, today); } catch { /* next time */ } })
      .catch(() => {});
  }, [sessionToken, userId]);
  const activeTab = isMobile ? mobileActiveTab : desktopTab;
  const setActiveTab = isMobile ? setMobileActiveTab : setDesktopTab;
  const [channelToOpen, setChannelToOpen] = useState('');
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
  // A ring goes when its last status expires (24 hours), even with no other change: reload the rings at that moment.
  const statusRingsUntil = useChatStore((state) => state.statusRingsUntil ?? null);
  useEffect(() => {
    if (!sessionToken || !statusRingsUntil) return undefined;
    const timer = setTimeout(() => useChatStore.getState().bumpStatusRevision(), Math.min(Math.max(0, statusRingsUntil - Date.now()) + 1000, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [sessionToken, statusRingsUntil]);
  const statusViewerFor = useChatStore((state) => state.statusViewerFor);
  // Phone storage full (or failing): said at the top until saving works again (src/storageHealth.js).
  const storageProblem = useStorageProblem();
  const closeStatusViewer = useCallback(() => useChatStore.getState().openStatusOf(null), []);
  useEffect(() => onNative('pictureInPicture', ({ active }) => document.documentElement.classList.toggle('native-pip', Boolean(active))), []);
  // Group rows in the chat list come from the server listing, refreshed on every group:* socket event and reconnect.
  // The last listing is kept on this device (src/groupCache.js), so groups show at once and stay when offline.
  useEffect(() => {
    if (!sessionToken || !userId) { setGroupSummaries([]); return undefined; }
    const controller = new AbortController();
    let fresh = false;
    cachedGroups(userId).then((list) => { if (list && !fresh && !controller.signal.aborted) setGroupSummaries(list); }).catch(() => {});
    apiFetch('/api/v1/groups', { headers: { Authorization: `Bearer ${sessionToken}` }, signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((list) => {
        if (!Array.isArray(list) || controller.signal.aborted) return;
        fresh = true;
        setGroupSummaries(list);
        saveGroups(userId, list).catch(() => {});
        // Each group's members and settings too (once per session), so any group opens offline.
        const headers = { Authorization: `Bearer ${sessionToken}` };
        prefetchGroupDetails(userId, list, async (groupId) => {
          const response = await apiFetch(`/api/v1/groups/${encodeURIComponent(groupId)}`, { headers });
          if (!response.ok) return null;
          const details = await response.json();
          // And its history: messages from before the delivery queue are not queued for this device, and the server
          // drops them at 30 days, so they are saved here even if the group is never opened.
          useChatStore.getState().mergeGroupMessages(groupId, await fetchGroupMessages(sessionToken, groupId));
          return details;
        }).catch(() => {});
      })
      .catch(() => {});
    return () => controller.abort();
  }, [sessionToken, userId, groupRevision]);
  const mutedGroupIds = useMutedGroups(userId);
  const groupRows = useMemo(() => groupSummaries.map((group) => groupRow(group, userId, mutedGroupIds)), [groupSummaries, userId, mutedGroupIds]);
  const unreadChats = countUnreadConversations(chats, groupRows);
  const callLogs = useChatStore((state) => state.callLogs);
  const notificationSettings = useNotificationSettings();

  // Opening the Calls tab counts missed calls as viewed: the tab badge and the missed-call notifications clear, and
  // the next missed call counts from 1 again.
  const missedCallsUnseen = unseenMissedCalls(callLogs, callsSeenAt);
  useEffect(() => {
    if (activeTab !== 'calls') return;
    const now = Date.now();
    setCallsSeenAt(now);
    deviceStorage.setItem('relay:calls-seen-at', String(now));
    if (nativeShell()) nativeClearMissedCalls();
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

  // A short link: find that person, open the chat with them and put the suggested message in the box (not sent).
  useEffect(() => {
    if (!sessionToken || !shortLink) return undefined;
    let cancelled = false;
    (async () => {
      const people = await searchPeople(sessionToken, shortLink.username);
      const person = people.find((entry) => entry.username?.toLowerCase() === shortLink.username);
      if (cancelled) return;
      if (!person) { setShortLink(null); return; }
      const existing = useChatStore.getState().chats.find((chat) => chat.id === person.id);
      const contact = existing ?? await linkContact(sessionToken, person.id, { save: false });
      if (!existing) await useChatStore.getState().addContact(contact);
      if (shortLink.text) useChatStore.getState().setComposerDraft(contact.id, shortLink.text);
      openChat(contact);
      setShortLink(null);
      globalThis.history?.replaceState?.(null, '', '/app');
    })().catch(() => setShortLink(null));
    return () => { cancelled = true; };
  }, [sessionToken, shortLink]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // "Reply", "Mark as read" and "Mute" on an Android message notification: the reply is sent (encrypted) like any message
  // and the chat counts as read; actions taken while the app was closed waited in a queue.
  useEffect(() => {
    if (!nativeShell() || !userId) return undefined;
    const handle = (event) => {
      const target = parseConversationOpenParam(event?.open);
      if (!target) return;
      if (event.action === 'mute') {
        // "Mute" on a notification: the same as muting from the chat (the background connection is already quiet).
        if (target.kind === 'group') setGroupMuted(userId, target.id, true);
        else useChatStore.getState().setPreference('mutedChatIds', (ids = []) => (ids.includes(target.id) ? ids : [...ids, target.id]));
        return;
      }
      if (target.kind !== 'chat') return;
      const store = useChatStore.getState();
      const text = typeof event.text === 'string' ? event.text.trim().slice(0, 4000) : '';
      if (event.action === 'reply' && text) store.sendMessage(target.id, text);
      store.readChat(target.id);
      nativeClearMessageNotifications(`chat:${target.id}`);
    };
    let live = true;
    nativeTakeMessageActions().then((queued) => { if (live) queued.forEach(handle); }).catch(() => {});
    const stop = onNative('messageAction', handle);
    return () => { live = false; stop(); };
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

  // Signed in: like WhatsApp, the Android app asks only for notifications on first launch (Android's own prompt,
  // no list of its own); microphone, camera, location and contacts are asked by Android when a feature first needs
  // them. Browsers get a one-line notifications prompt. The background connection keeps running until sign-out.
  useEffect(() => {
    if (!userId) {
      nativeClearSession();
      nativeStopBackground();
      return undefined;
    }
    let asked = false;
    try { asked = deviceStorage.getItem(permissionsAskedKey()) === '1'; } catch { /* private mode */ }
    const needsWebPrompt = !nativeShell() && typeof Notification !== 'undefined' && Notification.permission === 'default';
    if (nativeShell()) {
      if (asked) nativeStartBackground();
      else {
        try { deviceStorage.setItem(permissionsAskedKey(), '1'); } catch { /* private mode */ }
        nativeRequestStartupPermissions().catch(() => null).finally(() => nativeStartBackground());
      }
    } else if (!asked && needsWebPrompt) setPermissionsOpen(true);
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

  initiateCallRef.current = initiateCall;

  // A new or reset device with no chats of its own, on an account that has a backup: offer to restore first. Then
  // the account backup runs when it is due (daily or weekly), checked at sign-in and every hour.
  const [restoreOffer, setRestoreOffer] = useState(null);
  useEffect(() => {
    if (!userId || !sessionToken) return undefined;
    let live = true;
    (async () => {
      const offer = await shouldOfferRestore(sessionToken, userId, await savedMessageCount(userId));
      if (live && offer) setRestoreOffer(offer);
    })().catch(() => {});
    const tick = () => { if (document.visibilityState === 'visible') runScheduledBackup(sessionToken).catch(() => {}); };
    const first = setTimeout(tick, 60_000);
    const hourly = setInterval(tick, 60 * 60 * 1000);
    return () => { live = false; clearTimeout(first); clearInterval(hourly); };
  }, [userId, sessionToken]);

  // Motion preference goes on <html> so overlays rendered outside the shell follow it too.
  const appearance = useAppearance();
  useEffect(() => {
    document.documentElement.dataset.animations = animationsAttribute(appearance);
    document.documentElement.dataset.callAnimations = callAnimationsAttribute(appearance);
  }, [appearance]);

  return (
    <main className={`app-shell ${darkMode ? 'dark-theme' : ''} ${isMobile ? 'is-mobile' : ''} ${chatOpenOnMobile ? 'chat-open' : ''}`} data-animations={animationsAttribute(appearance)} data-call-animations={callAnimationsAttribute(appearance)} data-font-size={fontSize} data-contrast={highContrast ? 'high' : undefined}>
      {storageProblem && <p className="storage-banner" role="alert">{storageProblemText(storageProblem)}</p>}
      {!isMobile && <DesktopRail activeTab={desktopTab} onTab={setDesktopTab} onSheet={setParitySheet} unreadCount={unreadChats} darkMode={darkMode} onToggleTheme={toggleTheme} />}
      <Sidebar onPair={() => setAccountSettingsOpen('devices')} onSounds={() => setNotificationsOpen(true)} onNotifications={() => setNotificationsOpen(true)} onAccountSettings={() => setAccountSettingsOpen('account')} onSelectChat={() => setMobileListOpen(false)} onOpenAuth={() => setAuthOpen(true)} onAuthenticated={acceptSession} onLogout={logout} onAccounts={() => setAccountsOpen(true)} onGroups={() => openGroups()} groups={groupRows} onOpenGroup={(id) => openGroups(false, id)} />
      <div className="workspace">
        {activeTab === 'chats' ? (
          showMobileList || !chat
            ? <ChatsList onOpenChat={openChat} onStartCall={initiateCall} onGroups={openGroups} groups={groupRows} onOpenGroup={(id) => openGroups(false, id)} onSettings={() => setActiveTab('tools')}
              onSheet={(id) => (id === 'linked' ? setAccountSettingsOpen('devices') : setParitySheet(id))} />
            : <ChatWindow key={chat.id} chat={chat} connection={connection} client={client} onPair={() => setAccountSettingsOpen('devices')} onBack={() => setMobileListOpen(true)} onStartCall={(mode) => initiateCall(chat.id, mode)} onGroups={openGroups} />
        ) : activeTab === 'calls' ? (
          <CallsView onCall={initiateCall} onSheet={setParitySheet} onSettings={() => setActiveTab('tools')} />
        ) : activeTab === 'updates' ? (
          <UpdatesView onOpenChannels={(id) => { setChannelToOpen(id ?? ''); setParitySheet('channels'); }} onSheet={setParitySheet} onSettings={() => setActiveTab('tools')} />
        ) : activeTab === 'business' && sessionToken ? (
          <BusinessTools inline token={sessionToken} userId={userId} onSheet={setParitySheet} onSettings={() => setActiveTab('tools')} onClose={() => setActiveTab('chats')} />
        ) : activeTab === 'communities' && sessionToken ? (
          <CommunitiesView inline token={sessionToken} revision={groupRevision} onClose={() => setActiveTab('chats')} onOpenGroup={(id) => openGroups(false, id)} />
        ) : activeTab === 'tools' ? (
          <ToolsView darkMode={darkMode} onToggleTheme={toggleTheme} onLogout={() => { logout(); }} onNotifications={() => setNotificationsOpen(true)} onAccountSettings={(section) => setAccountSettingsOpen(section === 'privacy' || section === 'devices' ? section : 'account')} onAccounts={() => setAccountsOpen(true)} onAvatarStudio={() => setAvatarStudioOpen(true)} onGroups={() => openGroups()}
            onCommunities={() => setParitySheet('communities')} onBusinessTools={() => setParitySheet('business')} onStarred={() => setParitySheet('starred')}
            onBackup={() => setParitySheet('backup')} onStorage={() => setParitySheet('storage')} onSheet={setParitySheet} onBack={isMobile ? () => setActiveTab('chats') : undefined} />
        ) : null}
        {activeTab === 'chats' && !isMobile && <footer className="workspace-footer"><span /><span className="workspace-footer-right"><button onClick={toggleTheme} title={`Switch to ${darkMode ? 'light' : 'dark'} theme`}>{darkMode ? <Sun size={14} /> : <Moon size={14} />}{darkMode ? 'Light' : 'Dark'}</button><ChevronRight size={13} /></span></footer>}
      </div>
      {/* Settings is its own full screen on the phone (back arrow, no tab bar), like the business messenger. */}
      {isMobile && !chatOpenOnMobile && activeTab !== 'tools' && <MobileBottomNav activeTab={mobileActiveTab} onTabChange={setMobileActiveTab} unreadCount={unreadChats} missedCalls={activeTab === 'calls' ? 0 : missedCallsUnseen} />}
      {fatalError && <div className="status-toast"><Bell size={15} /><span>{fatalError}</span><button onClick={() => setFatalError('')}>Dismiss</button></div>}
      {notificationsOpen && <NotificationSettings onClose={() => setNotificationsOpen(false)} />}
      {accountSettingsOpen && <AccountSettings section={accountSettingsOpen === 'privacy' ? 'privacy' : 'account'} initialView={accountSettingsOpen === 'devices' ? 'devices' : null} onClose={() => setAccountSettingsOpen(false)}
        onOpenSheet={(id) => { setAccountSettingsOpen(false); setParitySheet(id); }} onAccountDeleted={() => { setAccountSettingsOpen(false); logout(); }} />}
      {accountsOpen && <AccountSwitcher busyId={switchingId} onSwitch={switchAccount} onRemove={removeAccountFromDevice} onAdd={() => { setAccountsOpen(false); setAuthOpen(true); }} onClose={() => setAccountsOpen(false)} />}
      {avatarStudioOpen && <AvatarStudio onClose={() => setAvatarStudioOpen(false)} />}
      {sessionToken && paritySheet === 'communities' && <CommunitiesView token={sessionToken} revision={groupRevision} onClose={() => setParitySheet(null)} onOpenGroup={(id) => { setParitySheet(null); openGroups(false, id); }} />}
      {sessionToken && paritySheet === 'verified' && <VerifiedPanel token={sessionToken} onClose={() => setParitySheet(null)} onOpenBusinessProfile={() => setParitySheet('businessprofile')} />}
      {sessionToken && paritySheet === 'businessprofile' && <BusinessTools token={sessionToken} userId={userId} initialSection="profile" onClose={() => setParitySheet(null)} />}
      {sessionToken && paritySheet === 'shortlink' && <BusinessTools token={sessionToken} userId={userId} initialSection="link" onClose={() => setParitySheet(null)} />}
      {sessionToken && paritySheet === 'business' && <BusinessTools token={sessionToken} userId={userId} onSheet={setParitySheet} onClose={() => setParitySheet(null)} />}
      {sessionToken && paritySheet === 'starred' && <StarredMessages token={sessionToken} userId={userId} onClose={() => setParitySheet(null)}
        onOpenChat={(id) => { setParitySheet(null); openChat({ id }); }} onOpenGroup={(id) => { setParitySheet(null); openGroups(false, id); }} />}
      {sessionToken && paritySheet === 'backup' && <BackupView token={sessionToken} onClose={() => setParitySheet(null)} />}
      {sessionToken && paritySheet === 'storage' && <StorageView onClose={() => setParitySheet(null)} />}
      {sessionToken && paritySheet === 'broadcasts' && <BroadcastLists token={sessionToken} onClose={() => setParitySheet(null)} />}
      {sessionToken && paritySheet === 'channels' && <Channels token={sessionToken} initialChannelId={channelToOpen} onClose={() => { setParitySheet(null); setChannelToOpen(''); }} />}
      {sessionToken && paritySheet === 'scheduled' && <ScheduledMessages token={sessionToken} userId={userId} onClose={() => setParitySheet(null)} />}
      {sessionToken && paritySheet === 'lists' && <ListsManager groups={groupRows} onClose={() => setParitySheet(null)} />}
      {sessionToken && (paritySheet === 'help' || paritySheet === 'support') && <HelpCenter token={sessionToken} initialView={paritySheet} onClose={() => setParitySheet(null)} />}
      {sessionToken && paritySheet === 'invite' && <InviteFriend username={useChatStore.getState().user?.username} onClose={() => setParitySheet(null)} />}
      {sessionToken && paritySheet === 'calllinks' && <CallLinks token={sessionToken} onClose={() => setParitySheet(null)} />}
      {sessionToken && paritySheet === 'statusprivacy' && <StatusPrivacy token={sessionToken} onClose={() => setParitySheet(null)} />}
      {paritySheet === 'language' && <LanguageSettings onClose={() => setParitySheet(null)} />}
      {sessionToken && callLinkCode && <JoinCallLink token={sessionToken} code={callLinkCode} onClose={() => setCallLinkCode('')}
        onCall={(owner, mode) => { setCallLinkCode(''); initiateCall(owner.id, mode === 'video' ? 'video' : 'audio'); }} />}
      {sessionToken && inviteCode && <JoinGroupSheet code={inviteCode} token={sessionToken} onClose={() => setInviteCode('')} onJoined={(groupId) => { setInviteCode(''); openGroups(false, groupId); }} />}
      {sessionToken && <TwoStepReminder token={sessionToken} />}
      <AppLockGate />
      {groupsOpen && sessionToken && <GroupsView key={userId} token={sessionToken} userId={userId} client={client} revision={groupRevision} initialCreate={groupsCreate} initialGroupId={groupsInitialId} onStartGroupCall={initiateGroupCall} onClose={() => setGroupsOpen(false)} />}
      {statusViewerFor && sessionToken && <StatusQuickView key={statusViewerFor} token={sessionToken} userId={userId} ownerId={statusViewerFor} onClose={closeStatusViewer} />}
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
      {permissionsOpen && userId && <PermissionsSheet onDone={() => setPermissionsOpen(false)} />}
      {restoreOffer && userId && !permissionsOpen && <RestoreBackupSheet token={sessionToken} userId={userId} info={restoreOffer} onDone={() => setRestoreOffer(null)} />}
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
        onOpenGroup={(id) => openGroupRef.current?.(id)}
      />}
    </main>
  );
}
