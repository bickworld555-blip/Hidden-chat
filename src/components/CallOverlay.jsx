import { apiFetch } from '../api.js';
import { endCallOverHttp, ownedCallIds } from '../callEnd.js';
import { nativeCallHeartbeat, nativeCancelIncomingCall, nativeEndCall, nativeEndCallWindow, nativeSetCallActive, nativeSetCallRinging, nativeSetCallVideoShown, nativeSetSpeaker, nativeShell, nativeShowIncomingCall, onNative } from '../native.js';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  AudioLines,
  Flashlight,
  FlashlightOff,
  Lock,
  Maximize2,
  MessageSquareText,
  Search,
  Mic,
  MicOff,
  Minimize2,
  MonitorUp,
  MoreHorizontal,
  Phone,
  PhoneOff,
  PictureInPicture2,
  ScanFace,
  SwitchCamera,
  UserPlus,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
  Wand2,
  X,
} from 'lucide-react';
import Avatar from './Avatar.jsx';
import { useChatStore } from '../store.js';
import { playStoredTone, stopTone } from '../sounds.js';
import { stopVibration, vibrateFor } from '../notify.js';
import { CALL_REACTIONS, createCallEngine, TERMINAL_STATUSES } from '../callEngine.js';
import { MAX_CALL_PARTICIPANTS, PeerRegistry, canInvite, matchesContact, peersToConnect, rankCallContacts } from '../callRoom.js';
import { DEFAULT_ICE_SERVERS, normalizeIceServers } from '../rtc.js';
import { setAvatarCallsEnabled, useAvatarCallsEnabled } from '../appearance.js';
import { personaCharacter, usePersona } from '../avatar/persona.js';
import { createAvatarFilter } from '../avatar/avatarStream.js';
import { loadFaceTracker } from '../avatar/faceTracker.js';
import { lazyComponent } from '../lazy.js';
import { useBackHandler } from '../backStack.js';
import { phoneSoundFor } from '../phoneSounds.js';
import { useCallStore } from '../callStore.js';
import { appSettings, useSetting } from '../settings.js';
import { NOTICE_PRIORITY } from '../noticeQueue.js';
import CallHeader from './call/CallHeader.jsx';
import ControlCard from './call/ControlCard.jsx';
import IncomingCallSheet from './call/IncomingCallSheet.jsx';
import CallNotices from './call/CallNotices.jsx';
import CallGrid from './call/CallGrid.jsx';
import ParticipantTile from './call/ParticipantTile.jsx';
import SpeakingIndicator from './call/SpeakingIndicator.jsx';
import { CallStatusLabel } from './call/CallTimer.jsx';
import { useMediaElement } from './call/useMediaElement.js';
const AvatarStudio = lazyComponent(() => import('./AvatarStudio.jsx'));
// Rare panels load on first use, so the call screen opens without them (WhatsApp's ViewStub pattern).
const AddParticipantPicker = lazyComponent(() => import('./call/AddParticipantPicker.jsx'));
const CallMoreSheet = lazyComponent(() => import('./call/CallMoreSheet.jsx'));

// Android WebView draws a grey "play" poster on a <video> until its first frame; calls show nothing instead.
const NO_POSTER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const ICE_CONFIG_TIMEOUT_MS = 3000;
const CLOSE_DELAY_MS = { failed: 5000, busy: 4000, default: 2500 };

// Fetches the server's ICE policy with a short deadline so a slow API never delays the call.
async function loadIceServers(sessionToken) {
  try {
    const response = await apiFetch('/api/v1/rtc-config', {
      headers: { Authorization: 'Bearer ' + sessionToken },
      signal: AbortSignal.timeout(ICE_CONFIG_TIMEOUT_MS),
    });
    if (response.ok) {
      const servers = normalizeIceServers((await response.json()).iceServers);
      if (servers.length > 0) return servers;
    }
  } catch {
    /* fall through to defaults */
  }
  return normalizeIceServers(DEFAULT_ICE_SERVERS);
}


// One extra participant of a group call: their video (or avatar) plus a hidden audio element.

const SCREEN_SHARE_TIMEOUT_MS = 60_000;
const isVideoMode = (mode) => mode === 'video';

// Reactions float up from the bottom and fade; mine and everyone else's.
function FloatingReactions({ items }) {
  return (
    <div className="wa-call-floating-reactions" aria-live="polite">
      {items.map((item) => <span key={item.id} className={`wa-call-floating-reaction${item.mine ? ' is-mine' : ''}`} style={{ left: `${item.x}%` }} aria-label={item.label}>{item.emoji}</span>)}
    </div>
  );
}

const CALL_HEARTBEAT_MS = 10_000;

export default function CallOverlay({
  call,
  peer,
  client,
  sessionToken,
  signals = [],
  onSignalHandled,
  onCallChange,
  onClose,
  onOpenChat,
  onOpenGroup,
}) {
  const [snapshot, setSnapshot] = useState(() => ({
    status: 'idle', mode: call.mode, error: '', localStream: null, remoteStream: null,
    muted: false, cameraOff: false, facing: 'user', answered: false, connectedAt: 0,
    remoteVideoOff: false, remoteMuted: false, remoteHasVideo: false, videoRequest: null, remoteScreen: false, screenSharing: false,
  }));
  // In the Android app the speaker button routes audio (loudspeaker vs earpiece/headset) and voice calls start on
  // the earpiece like a phone call; in a browser it can only mute playback, so it starts on.
  const nativeRouting = nativeShell();
  const [speakerOn, setSpeakerOn] = useState(() => !nativeRouting || call.mode === 'video');
  const audioMuted = nativeRouting ? false : !speakerOn;
  const toggleSpeaker = () => {
    const next = !speakerOn;
    setSpeakerOn(next);
    if (nativeRouting) nativeSetSpeaker(next).then((result) => { if (typeof result?.speaker === 'boolean') setSpeakerOn(result.speaker); });
  };
  const speakerLabel = nativeRouting ? (speakerOn ? 'Turn off speaker' : 'Turn on speaker') : (speakerOn ? 'Mute speaker' : 'Turn speaker on');
  const [swapped, setSwapped] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [canFlip, setCanFlip] = useState(false);
  const [filterEffect, setFilterEffect] = useState(0);
  const [remoteRinging, setRemoteRinging] = useState(false);

  useLayoutEffect(() => {
    useCallStore.getState().reset();
    return () => useCallStore.getState().reset();
  }, []);
  const peerPresence = useChatStore((state) => state.presence?.[call.peerId]);
  const isOnline = remoteRinging || peerPresence === 'online';

  const engineRef = useRef(null);
  const disposeTimerRef = useRef(null);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const latest = useRef({ client, sessionToken, onCallChange, onClose, onSignalHandled, call });
  latest.current = { client, sessionToken, onCallChange, onClose, onSignalHandled, call };

  const { status, mode: callMode, error, localStream, remoteStream, muted, cameraOff, facing, answered, remoteVideoOff, remoteMuted, remoteHasVideo, videoRequest, remoteScreen, screenSharing, videoFilter, remoteAvatar } = snapshot;
  const isVideo = callMode === 'video';
  const terminal = TERMINAL_STATUSES.includes(status);
  // Android: from the moment we place or answer a call until it ends, the background service holds the microphone
  // (and camera for video) so switching apps or locking the screen does not freeze or silence the call.
  const callLive = !terminal && !(call.direction === 'incoming' && status === 'idle');
  // Name on the ongoing-call notification.
  const callTitle = call.groupName || peer?.name || '';
  useEffect(() => {
    if (!nativeShell()) return undefined;
    // Starting (or switching to video) picks the default route; the button shows what Android actually chose.
    // The call id lets Android's Hang up (notification, headset, car) end it on the server even while this screen is paused.
    nativeSetCallActive(callLive, isVideo, callTitle, call.id).then((result) => { if (callLive && typeof result?.speaker === 'boolean') setSpeakerOn(result.speaker); });
    return () => { if (callLive) nativeSetCallActive(false); };
  }, [callLive, isVideo, callTitle, call.id]);
  // While live, tell Android every few seconds that the call goes on; if the confirmations stop, it ends the call
  // there by itself, so a timer can never keep running on the lock screen for a call that is gone.
  useEffect(() => {
    if (!nativeShell() || !callLive) return undefined;
    nativeCallHeartbeat();
    const timer = setInterval(() => nativeCallHeartbeat(), CALL_HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [callLive]);
  // The moment the call ends (either side, any way), and when this screen closes: hard reset on the native side.
  useEffect(() => { if (nativeShell() && terminal) nativeEndCall(); }, [terminal]);
  useEffect(() => () => { if (nativeShell()) nativeEndCall(); }, []);

  // Shared across the room: one screen capture feeds every pair (each engine gets its own clone).
  const displayShareRef = useRef(null);
  function sharedDisplayMedia(constraints) {
    if (!displayShareRef.current) {
      // A picker that never answers (seen in some WebViews) must not leave the call stuck waiting.
      const timeout = new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('Screen sharing did not start.'), { name: 'TimeoutError' })), SCREEN_SHARE_TIMEOUT_MS));
      displayShareRef.current = Promise.race([navigator.mediaDevices.getDisplayMedia(constraints), timeout]).finally(() => { setTimeout(() => { displayShareRef.current = null; }, 1500); });
    }
    return displayShareRef.current.then((stream) => new MediaStream(stream.getVideoTracks().map((track) => track.clone())));
  }

  // Builds one pair engine. The primary peer uses the call's own id; room peers get their own pair ids.
  function buildEngine({ peerId, callId, direction, mode, offer, onSnapshot }) {
    const engine = createCallEngine({
      callId,
      direction,
      mode,
      offer: offer ?? null,
      rtc: { RTCPeerConnection, RTCIceCandidate, RTCRtpSender: globalThis.RTCRtpSender, MediaStream },
      getUserMedia: (constraints) => {
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
          return Promise.reject(new Error('Microphone and camera access requires HTTPS or localhost.'));
        }
        return navigator.mediaDevices.getUserMedia(constraints);
      },
      enumerateDevices: () => navigator.mediaDevices?.enumerateDevices?.() ?? Promise.resolve([]),
      getDisplayMedia: navigator.mediaDevices?.getDisplayMedia ? sharedDisplayMedia : null,
      fetchIceServers: () => loadIceServers(latest.current.sessionToken),
      send: (payload) => latest.current.client?.send({ ...payload, targetId: peerId, roomId: latest.current.call.roomId ?? latest.current.call.id, signalId: crypto.randomUUID() }),
      onSnapshot,
      log: (...args) => { if (import.meta.env?.DEV) console.debug('[call]', peerId.slice(0, 6), ...args); },
    });
    engine.callId = callId;
    engine.peerId = peerId;
    return engine;
  }

  const primarySnapshot = (next) => {
    setSnapshot(next);
    latest.current.onCallChange({ ...latest.current.call, mode: next.mode, status: next.status });
  };

  // Room peers beyond the primary one: engines in a registry, their snapshots in state for rendering.
  const extrasRef = useRef(new PeerRegistry());
  const [extraSnapshots, setExtraSnapshots] = useState({});
  // In-call notices are queued by priority and shown one at a time (CallNotices).
  const setNotice = (text, priority = NOTICE_PRIORITY.NORMAL) => { if (text) useCallStore.getState().notify(text, { priority }); };
  const [addOpen, setAddOpen] = useState(false);
  const chats = useChatStore((state) => state.chats);
  const userId = useChatStore((state) => state.userId);
  const me = useChatStore((state) => state.user);
  const myName = me?.name || me?.username || 'You';

  // Animation Video Call: the cartoon avatar replaces the camera on every pair engine of this call.
  const avatarCalls = useAvatarCallsEnabled();
  const persona = usePersona();
  const [avatarOn, setAvatarOn] = useState(() => avatarCalls && Boolean(persona));
  const [avatarStatus, setAvatarStatus] = useState('off'); // off | loading | on | error
  const [avatarStats, setAvatarStats] = useState({ fps: 0, latencyMs: 0, tracking: false });
  const [studioOpen, setStudioOpen] = useState(false);
  const avatarStatsRef = useRef(avatarStats);
  const extrasCount = Object.keys(extraSnapshots).length;
  // One-to-one video call where both people have turned their camera off: like WhatsApp, the audio leaves the
  // loudspeaker for the earpiece so the phone can go to the ear; when either camera comes back it returns.
  const peerVideoShown = Boolean(remoteStream) && remoteHasVideo && !remoteVideoOff;
  const bothCamerasOff = isVideo && status === 'connected' && cameraOff && !peerVideoShown && extrasCount === 0;
  useEffect(() => {
    if (!nativeShell() || !isVideo || !callLive) return;
    nativeSetCallVideoShown(!bothCamerasOff).then((result) => { if (typeof result?.speaker === 'boolean') setSpeakerOn(result.speaker); });
  }, [bothCamerasOff]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!isVideo || terminal) return undefined;
    if (!avatarOn || !persona) {
      setAvatarStatus('off');
      allEngines().forEach((engine) => engine.setVideoFilter?.(null));
      return undefined;
    }
    let cancelled = false;
    setAvatarStatus('loading');
    loadFaceTracker().then((tracker) => {
      if (cancelled) return;
      const character = personaCharacter(persona);
      const factory = () => createAvatarFilter({
        character,
        profile: persona.profile,
        tracker,
        onStats: (stats) => {
          const last = avatarStatsRef.current;
          if (last.fps === stats.fps && last.latencyMs === stats.latencyMs && last.tracking === stats.tracking) return;
          avatarStatsRef.current = { ...stats };
          setAvatarStats(avatarStatsRef.current);
        },
      });
      allEngines().forEach((engine) => engine.setVideoFilter?.(factory));
      setAvatarStatus('on');
    }).catch((caught) => {
      if (cancelled) return;
      setAvatarStatus('error');
      setNotice(caught?.message || 'The face tracker could not be loaded; sending your camera instead.');
      setAvatarOn(false);
    });
    return () => { cancelled = true; };
  }, [avatarOn, persona, isVideo, terminal, extrasCount]);

  const toggleAvatar = () => {
    if (!persona) { setStudioOpen(true); return; }
    const next = !avatarOn;
    setAvatarOn(next);
    setAvatarCallsEnabled(next);
  };

  function addRoomPeer({ peerId, callId, direction, offer }) {
    if (peerId === call.peerId || extrasRef.current.forPeer(peerId)) return null;
    const engine = buildEngine({
      peerId, callId, direction, mode: call.mode, offer,
      onSnapshot: (next) => setExtraSnapshots((current) => ({ ...current, [peerId]: next })),
    });
    extrasRef.current.add(peerId, callId, engine);
    setExtraSnapshots((current) => ({ ...current, [peerId]: engine.state }));
    return engine;
  }

  function dropRoomPeer(peerId) {
    extrasRef.current.remove(peerId)?.engine.dispose();
    setExtraSnapshots((current) => { const next = { ...current }; delete next[peerId]; return next; });
  }

  const allEngines = () => [engineRef.current, ...extrasRef.current.entries().map((entry) => entry.engine)].filter(Boolean);

  // One engine per call id. StrictMode's simulated unmount defers disposal by a tick so the
  // re-run can adopt the same engine instead of sending an end signal. Invited group calls create
  // their engines on accept instead (the invitee places the pair calls).
  useEffect(() => {
    if (disposeTimerRef.current) {
      clearTimeout(disposeTimerRef.current);
      disposeTimerRef.current = null;
    }
    let engine = engineRef.current;
    if (!call.invite && (!engine || engine.callId !== call.id)) {
      engine?.dispose();
      engine = buildEngine({ peerId: call.peerId, callId: call.id, direction: call.direction, mode: call.mode, offer: call.offer, onSnapshot: primarySnapshot });
      engineRef.current = engine;
      if (call.direction === 'outgoing') engine.start();
    }
    const registry = extrasRef.current;
    return () => {
      disposeTimerRef.current = setTimeout(() => {
        disposeTimerRef.current = null;
        if (engineRef.current && engineRef.current === engine) {
          engine.dispose();
          engineRef.current = null;
        }
        for (const entry of registry.entries()) { entry.engine.dispose(); registry.remove(entry.peerId); }
      }, 0);
    };
  }, [call.id]);

  // Group call started from a group: once the first leg is connected, the remaining chosen members are invited one
  // at a time, so each newcomer's participant list already names everyone who accepted before them.
  const inviteQueueRef = useRef(null);
  const nameOf = (peerId) => chats.find((chat) => chat.id === peerId)?.name ?? call.members?.find((member) => member.id === peerId)?.name ?? 'them';
  function sendNextInvite() {
    const queue = inviteQueueRef.current;
    if (!queue) return;
    const next = queue.pending.shift();
    if (!next) { queue.current = null; return; }
    queue.current = next;
    const participants = [...new Set([userId, call.peerId, ...extrasRef.current.peerIds, ...queue.accepted])];
    const sent = latest.current.client?.send({ type: 'call:invite', roomId: call.roomId ?? call.id, targetId: next, mode: callMode, participants });
    setNotice(sent === false ? 'You are offline.' : `Inviting ${nameOf(next)}…`, sent === false ? NOTICE_PRIORITY.HIGH : NOTICE_PRIORITY.NORMAL);
  }
  useEffect(() => {
    if (status !== 'connected' || inviteQueueRef.current || !call.pendingInvites?.length) return;
    inviteQueueRef.current = { pending: [...call.pendingInvites], accepted: [], current: null };
    sendNextInvite();
  }, [status]);

  // Signals are forwarded in arrival order and routed by pair id; new room offers create a peer that
  // joins immediately (we are already in the room), invite replies become notices.
  useEffect(() => {
    for (const event of signals) {
      const done = () => latest.current.onSignalHandled?.(event.signalId);
      if (event.type === 'call:invite-reply') {
        if (!event.accepted) {
          const who = nameOf(event.from);
          setNotice(event.reason === 'busy' ? `${who} is on another call` : event.reason === 'offline' ? `${who} is offline` : `${who} declined`);
        }
        const queue = inviteQueueRef.current;
        if (queue && queue.current === event.from) {
          if (event.accepted) queue.accepted.push(event.from);
          sendNextInvite();
        }
        done();
        continue;
      }
      if (event.callId === call.id) {
        const engine = engineRef.current;
        if (!engine) continue;
        if (event.signal?.type === 'ringing') setRemoteRinging(true);
        engine.deliver(event.signal, { signalId: event.signalId, done });
        continue;
      }
      let entry = extrasRef.current.forCall(event.callId);
      if (!entry && event.signal?.type === 'offer' && event.from) {
        const engine = addRoomPeer({ peerId: event.from, callId: event.callId, direction: 'incoming', offer: event.signal });
        if (engine) { engine.accept(); done(); continue; }
      }
      if (entry) entry.engine.deliver(event.signal, { signalId: event.signalId, done });
      else done();
    }
  }, [signals, call.id]);

  // Peers whose pair ended leave the grid after their end state has been shown briefly.
  useEffect(() => {
    const finished = Object.entries(extraSnapshots).filter(([, item]) => TERMINAL_STATUSES.includes(item.status)).map(([peerId]) => peerId);
    if (!finished.length) return undefined;
    const timer = setTimeout(() => finished.forEach(dropRoomPeer), 2000);
    return () => clearTimeout(timer);
  }, [extraSnapshots]);

  useEffect(() => {
    if (!isVideo || !navigator.mediaDevices?.enumerateDevices) return;
    let cancelled = false;
    navigator.mediaDevices.enumerateDevices()
      .then((devices) => { if (!cancelled) setCanFlip(devices.filter((device) => device.kind === 'videoinput').length > 1); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isVideo]);

  useMediaElement(localVideoRef, localStream, isVideo);
  useMediaElement(remoteVideoRef, remoteStream, isVideo);
  useMediaElement(remoteAudioRef, remoteStream);

  useEffect(() => {
    if (remoteAudioRef.current) remoteAudioRef.current.muted = audioMuted;
  }, [audioMuted, remoteStream]);

  // In the Android app, a call that rings while the app is in the background shows the native call
  // notification (ringtone, Accept / Reject); it is withdrawn once the app is in front or the call moves on.
  const pageHidden = usePageHidden();
  const ringingIncoming = call.direction === 'incoming' && status === 'idle';
  // The caller hung up while this phone was still ringing (not answered here or on another device): a missed call.
  const missedByPeer = call.direction === 'incoming' && Boolean(snapshot.endedByPeer) && !answered && snapshot.endReason !== 'answered-elsewhere';
  useEffect(() => {
    if (!nativeShell()) return;
    if (ringingIncoming && pageHidden) {
      stopTone('incomingCall');
      nativeShowIncomingCall({ callId: call.id, callerId: call.peerId, callerName: peer?.name ?? 'Hidden Messenger', callerAvatar: typeof peer?.avatar === 'string' && peer.avatar.startsWith('/') ? peer.avatar : null, mode: call.mode, ringtoneSound: phoneSoundFor('incomingCall', undefined, true) });
    } else nativeCancelIncomingCall({ missed: missedByPeer });
  }, [ringingIncoming, pageHidden, missedByPeer, call.id, call.peerId, call.mode, peer?.name]);
  // While it rings the call screen stays over the lock screen, whether or not the notification is still up.
  useEffect(() => {
    if (!nativeShell() || !ringingIncoming) return undefined;
    nativeSetCallRinging(true);
    return () => { nativeSetCallRinging(false); };
  }, [ringingIncoming]);
  useEffect(() => () => { nativeCancelIncomingCall(); nativeEndCallWindow(); }, []);
  // Some phones pause <video> elements while the floating picture-in-picture window opens (or the page is briefly
  // hidden); restart any paused call video so the picture never freezes while the call continues.
  useEffect(() => {
    const resume = () => {
      for (const video of document.querySelectorAll('.wa-call-backdrop video')) {
        if (video.paused && video.srcObject) video.play().catch(() => {});
      }
    };
    const stopPip = onNative('pictureInPicture', () => { resume(); setTimeout(resume, 500); });
    const onVisible = () => { if (document.visibilityState === 'visible') resume(); };
    document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(resume, 2000);
    return () => { stopPip(); document.removeEventListener('visibilitychange', onVisible); clearInterval(timer); };
  }, []);
  const callActionsRef = useRef(null);
  useEffect(() => onNative('callAction', ({ action, callId, cameraOff: answerWithCameraOff, text, muted: mutedBySystem }) => {
    if (callId && callId !== latest.current.call.id) return;
    if (action === 'accept') callActionsRef.current?.accept({ cameraOff: Boolean(answerWithCameraOff) });
    else if (action === 'reject' || action === 'hangup') callActionsRef.current?.reject();
    // "Message" on the lock-screen call: decline and send the chosen quick reply to the caller.
    else if (action === 'reply') {
      if (typeof text === 'string' && text.trim()) useChatStore.getState().sendMessage(latest.current.call.peerId, text.trim());
      callActionsRef.current?.reject();
    }
    // Muted or unmuted from a headset, car or watch (Android Telecom).
    else if (action === 'mute' && typeof mutedBySystem === 'boolean') callActionsRef.current?.setMuted(mutedBySystem);
  }), []);

  useEffect(() => {
    const incomingRinging = call.direction === 'incoming' && status === 'idle';
    const outgoingRinging = call.direction === 'outgoing' && !answered && (status === 'connecting' || status === 'ringing');
    let vibrateTimer = null;
    if (incomingRinging) {
      playStoredTone('incomingCall');
      // The call vibration pattern repeats for as long as the phone rings.
      vibrateFor('incomingCall');
      vibrateTimer = window.setInterval(() => vibrateFor('incomingCall'), 2000);
    } else if (outgoingRinging) playStoredTone('outgoingCall');
    else {
      stopTone('incomingCall');
      stopTone('outgoingCall');
    }
    return () => {
      if (vibrateTimer) window.clearInterval(vibrateTimer);
      stopVibration();
      stopTone('incomingCall');
      stopTone('outgoingCall');
    };
  }, [call.direction, status, answered, pageHidden]);

  useEffect(() => {
    if (!terminal) return undefined;
    const timer = setTimeout(() => latest.current.onClose(), CLOSE_DELAY_MS[status] ?? CLOSE_DELAY_MS.default);
    return () => clearTimeout(timer);
  }, [terminal, status]);

  // Mid-call notices (declined video, camera switch failed) fade; end-of-call reasons stay until close.
  useEffect(() => {
    if (!error || terminal) return undefined;
    const timer = setTimeout(() => engineRef.current?.clearError(), 4000);
    return () => clearTimeout(timer);
  }, [error, terminal]);

  function acceptCall() {
    if (call.invite) {
      // Invited into a room: we place a pair call to everyone already in it, the inviter first.
      const peers = peersToConnect([call.peerId, ...(call.invite.participants ?? [])], userId);
      const [first, ...rest] = peers;
      if (!first) { onClose(); return; }
      const primary = buildEngine({ peerId: first, callId: call.id, direction: 'outgoing', mode: call.mode, onSnapshot: primarySnapshot });
      engineRef.current = primary;
      primary.start();
      for (const peerId of rest) addRoomPeer({ peerId, callId: crypto.randomUUID(), direction: 'outgoing' })?.start();
      return;
    }
    engineRef.current?.accept();
  }

  function endCall() {
    const engine = engineRef.current;
    // Also over HTTP, so the hang-up or decline reaches the server even if the socket just dropped.
    if (!call.invite && !terminal) {
      for (const callId of ownedCallIds(call.id, extrasRef.current.entries())) endCallOverHttp(callId, latest.current.sessionToken);
    }
    for (const entry of extrasRef.current.entries()) entry.engine.hangUp();
    if (call.invite && !engine) {
      latest.current.client?.send({ type: 'call:invite-reply', roomId: call.roomId, targetId: call.peerId, accepted: false, reason: 'declined' });
      onClose();
      return;
    }
    if (!engine || terminal) {
      onClose();
      return;
    }
    if (call.direction === 'incoming' && status === 'idle') engine.decline();
    else engine.hangUp();
    onClose();
  }

  callActionsRef.current = {
    // "Turn off your video" on the lock-screen call: answer, then switch the camera off right away.
    accept: ({ cameraOff: off = false } = {}) => {
      acceptCall();
      if (off) allEngines().forEach((engine) => engine.setCameraOff(true));
    },
    reject: endCall,
    setMuted: (on) => allEngines().forEach((engine) => engine.setMuted(on)),
  };

  function inviteParticipant(contact) {
    setAddOpen(false);
    const participants = [userId, call.peerId, ...extrasRef.current.peerIds];
    const sent = latest.current.client?.send({ type: 'call:invite', roomId: call.roomId ?? call.id, targetId: contact.id, mode: callMode, participants });
    setNotice(sent === false ? 'You are offline.' : `Inviting ${contact.name}…`, sent === false ? NOTICE_PRIORITY.HIGH : NOTICE_PRIORITY.NORMAL);
  }

  const toggleMute = () => allEngines().forEach((engine) => engine.setMuted(!muted));
  const toggleCamera = () => allEngines().forEach((engine) => engine.setCameraOff(!cameraOff));
  const flipCamera = () => allEngines().forEach((engine) => engine.flipCamera());
  const requestVideo = () => engineRef.current?.requestVideo();
  const cancelVideoRequest = () => engineRef.current?.cancelVideoRequest();
  const acceptVideo = () => engineRef.current?.acceptVideo();
  const declineVideo = () => engineRef.current?.declineVideo();
  const cycleFilterEffect = () => setFilterEffect((prev) => (prev + 1) % 4);
  const toggleScreenShare = () => (screenSharing
    ? allEngines().forEach((engine) => engine.stopScreenShare())
    : allEngines().forEach((engine) => engine.startScreenShare()));
  // The Android app's WebView offers getDisplayMedia but cannot capture the screen (the request never settles), so
  // sharing is offered only where browsers support it (desktop).
  const canShareScreen = Boolean(navigator.mediaDevices?.getDisplayMedia) && !nativeShell();

  // --- ⋯ sheet: reactions, noise cancellation, flash ---
  const [moreOpen, setMoreOpen] = useState(false);
  // Android Back during a call: close sheets first, then shrink the call to its floating window (it keeps going).
  useBackHandler(!minimized && !TERMINAL_STATUSES.includes(status), () => minimizeCall());
  useBackHandler(addOpen, () => setAddOpen(false));
  useBackHandler(moreOpen, () => setMoreOpen(false));
  const [floating, setFloating] = useState([]);
  const reactionTimersRef = useRef([]);
  useEffect(() => () => reactionTimersRef.current.forEach(clearTimeout), []);
  function showReaction(emoji, { mine, label: spoken }) {
    const id = `${Date.now()}-${Math.random()}`;
    setFloating((list) => [...list.slice(-11), { id, emoji, mine, label: spoken, x: 10 + Math.random() * 70 }]);
    reactionTimersRef.current.push(setTimeout(() => setFloating((list) => list.filter((item) => item.id !== id)), 2600));
  }
  const sendReaction = (emoji) => {
    const sent = allEngines().map((engine) => engine.sendReaction(emoji)).some(Boolean);
    if (sent) showReaction(emoji, { mine: true, label: `You reacted ${emoji}` });
    setMoreOpen(false);
  };
  // A device setting in the settings registry (src/settings.js), migrated from its old key.
  const noisePreference = useSetting('calls.noiseCancellation');
  const setNoiseCancellation = (enabled) => {
    appSettings().set('calls.noiseCancellation', enabled).catch(() => {});
    allEngines().forEach((engine) => engine.setNoiseSuppression(enabled));
  };
  // Capture starts with suppression on; a saved "off" is applied once each leg is up.
  useEffect(() => {
    if (status === 'connected' && !noisePreference) allEngines().forEach((engine) => engine.setNoiseSuppression(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, localStream]);
  const torchAvailable = isVideoMode(callMode) && Boolean(engineRef.current?.torchAvailable?.());
  const toggleTorch = () => allEngines().forEach((engine) => engine.setTorch(!snapshot.torch));
  const sendMessageToPeer = () => {
    setMoreOpen(false);
    minimizeCall();
    // A group call opens the group's chat (messages, voice notes, photos and files) under the floating call window.
    if (call.groupId && onOpenGroup) onOpenGroup(call.groupId);
    else onOpenChat?.(call.peerId);
  };

  // Native picture-in-picture for the remote video (where the browser offers it).
  const canNativePip = typeof document !== 'undefined' && document.pictureInPictureEnabled && Boolean(remoteStream) && remoteHasVideo;
  const toggleNativePip = async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await remoteVideoRef.current?.requestPictureInPicture();
    } catch { /* not allowed right now */ }
  };
  useEffect(() => () => { if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {}); }, []);

  // In-app floating window: dragged by its bar, kept inside the viewport; a tap anywhere restores it.
  const [pipPosition, setPipPosition] = useState(null);
  const [tilePosition, setTilePosition] = useState(null);
  const [restoring, setRestoring] = useState(false);
  const dragRef = useRef(null);
  const draggedRef = useRef(false);
  const tileDragRef = useRef(null);
  const tileDraggedRef = useRef(false);
  const floatingRef = useRef(null);
  const stageRef = useRef(null);
  const restoreCall = () => {
    dragRef.current = null;
    setTilePosition(null);
    setMinimized(false);
    setRestoring(true);
    window.setTimeout(() => setRestoring(false), 260);
  };
  const minimizeCall = () => {
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
    setTilePosition(null);
    setMinimized(true);
  };
  // The minimised window drags from anywhere on it (not just its bar) and snaps to the nearest corner on release.
  const [pipSnapping, setPipSnapping] = useState(false);
  const onPipPointerDown = (event) => {
    if (!minimized || event.target.closest('button') || (event.button ?? 0) !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setPipSnapping(false);
    dragRef.current = { offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, width: rect.width, height: rect.height, moved: false, startX: event.clientX, startY: event.clientY };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPipPointerMove = (event) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;
    drag.moved = true;
    const x = Math.max(0, Math.min(event.clientX - drag.offsetX, window.innerWidth - drag.width));
    const y = Math.max(0, Math.min(event.clientY - drag.offsetY, window.innerHeight - drag.height));
    setPipPosition({ x, y });
  };
  const onPipPointerUp = (event) => {
    const drag = dragRef.current;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    // The click that follows a drag must not restore the window.
    draggedRef.current = Boolean(drag?.moved);
    if (drag?.moved) {
      const rect = event.currentTarget.getBoundingClientRect();
      setPipPosition(pipCorner(rect));
      setPipSnapping(true);
      window.setTimeout(() => setPipSnapping(false), 260);
    }
  };
  const onTilePointerDown = (event) => {
    // Minimised, the whole window drags instead of the tile inside it.
    if (event.button !== 0 || minimized) return;
    event.stopPropagation();
    const tile = event.currentTarget.getBoundingClientRect();
    const stage = stageRef.current.getBoundingClientRect();
    tileDragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: tile.left - stage.left, y: tile.top - stage.top, width: tile.width, height: tile.height, moved: false };
    tileDraggedRef.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onTilePointerMove = (event) => {
    const drag = tileDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    drag.moved = true;
    const stage = stageRef.current.getBoundingClientRect();
    setTilePosition({ x: Math.max(0, Math.min(drag.x + dx, stage.width - drag.width)), y: Math.max(0, Math.min(drag.y + dy, stage.height - drag.height)) });
  };
  const onTilePointerUp = (event) => {
    const drag = tileDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    tileDraggedRef.current = drag.moved;
    tileDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const swapTile = (event) => {
    event.stopPropagation();
    if (tileDraggedRef.current) { tileDraggedRef.current = false; return; }
    setSwapped((value) => !value);
  };
  const tileProps = {
    onPointerDown: onTilePointerDown,
    onPointerMove: onTilePointerMove,
    onPointerUp: onTilePointerUp,
    onPointerCancel: onTilePointerUp,
    onClick: swapTile,
    onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); swapTile(event); } },
    role: 'button',
    tabIndex: 0,
    style: tilePosition ? { left: tilePosition.x, top: tilePosition.y, right: 'auto', bottom: 'auto' } : undefined,
  };
  useEffect(() => {
    const clamp = () => {
      if (floatingRef.current && minimized) {
        const rect = floatingRef.current.getBoundingClientRect();
        setPipPosition({ x: Math.max(0, Math.min(rect.left, window.innerWidth - rect.width)), y: Math.max(0, Math.min(rect.top, window.innerHeight - rect.height)) });
      }
      setTilePosition(null);
    };
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, [minimized]);

  const peerName = peer?.name ?? 'Unknown';
  const extraPeers = Object.entries(extraSnapshots).map(([peerId, item]) => ({ peerId, snapshot: item, info: chats.find((chat) => chat.id === peerId) ?? call.members?.find((member) => member.id === peerId) ?? { id: peerId, name: `@${peerId.slice(0, 6)}`, initials: '??' } }));
  const groupGrid = extraPeers.length > 0;
  // Reactions from the main peer and every other participant, each shown once.
  const seenReactionsRef = useRef(new Set());
  const reactionSources = [[call.peerId, snapshot.remoteReaction, peerName], ...extraPeers.map((item) => [item.peerId, item.snapshot.remoteReaction, item.info.name])];
  const reactionSignature = reactionSources.map(([id, reaction]) => (reaction ? `${id}:${reaction.at}` : '')).join('|');
  useEffect(() => {
    for (const [id, reaction, name] of reactionSources) {
      if (!reaction) continue;
      const key = `${id}:${reaction.at}:${reaction.emoji}`;
      if (seenReactionsRef.current.has(key)) continue;
      seenReactionsRef.current.add(key);
      showReaction(reaction.emoji, { mine: false, label: `${name} reacted ${reaction.emoji}` });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reactionSignature]);
  const canSwapTile = !groupGrid || minimized;
  const incomingRinging = call.direction === 'incoming' && status === 'idle';
  // The remote tile shows the peer's avatar until their video is live, and again whenever they cover their camera.
  const remoteVideoLive = Boolean(remoteStream) && remoteHasVideo && !remoteVideoOff;
  // Like WhatsApp: while a video call rings, your own camera fills the screen; once the other side answers (or
  // their video arrives) they take the full screen and your camera shrinks into the corner.
  const remoteJoined = Boolean(remoteStream) && (remoteVideoLive || status === 'connected' || status === 'reconnecting');
  const selfFull = swapped || !remoteJoined;
  const filterStyles = ['', 'sepia(0.35) contrast(1.05)', 'hue-rotate(180deg)', 'grayscale(1)'];

  // --- Call store: each part of the screen reads only its slice (see src/callStore.js). ---
  const canAddPeople = canInvite(1 + extrasRef.current.size);
  useLayoutEffect(() => {
    const store = useCallStore.getState();
    store.publish('header', {
      title: call.groupName ? call.groupName : extraPeers.length ? `${peerName} +${extraPeers.length}` : peerName,
      status, direction: call.direction, mode: callMode, isOnline, answered,
      group: Boolean(call.invite) || extraPeers.length > 0,
      connectedAt: snapshot.connectedAt || 0,
      networkQuality: snapshot.networkQuality || 'good',
      terminal, incomingRinging,
      canAdd: canAddPeople && status === 'connected',
      addTitle: canAddPeople ? 'Add participant' : `Up to ${MAX_CALL_PARTICIPANTS} people`,
    });
    store.publish('controls', {
      mode: callMode, status, terminal, incomingRinging, muted, cameraOff, speakerOn, nativeRouting, speakerLabel,
      moreOpen, videoRequest, screenSharing, canShareScreen,
    });
  });
  // Buttons in the parts call back into the latest handlers of this render.
  useLayoutEffect(() => {
    useCallStore.getState().setActions({
      minimize: minimizeCall,
      openAddParticipant: () => setAddOpen(true),
      toggleMore: () => setMoreOpen((open) => !open),
      toggleCamera, toggleSpeaker, toggleMute, endCall, acceptCall, requestVideo, cancelVideoRequest, toggleScreenShare,
    });
  });

  return (
    <div
      ref={floatingRef}
      className={`wa-call-backdrop ${minimized ? 'is-pip' : ''} ${minimized && !isVideo ? 'is-pip-audio' : ''} ${restoring ? 'is-restoring' : ''} ${pipSnapping ? 'is-snapping' : ''}`}
      style={minimized && pipPosition ? { left: pipPosition.x, top: pipPosition.y, right: 'auto', bottom: 'auto' } : undefined}
      onPointerDown={minimized ? onPipPointerDown : undefined}
      onPointerMove={minimized ? onPipPointerMove : undefined}
      onPointerUp={minimized ? onPipPointerUp : undefined}
      onPointerCancel={minimized ? onPipPointerUp : undefined}
      onClick={minimized ? (event) => { const dragged = draggedRef.current; draggedRef.current = false; if (!dragged && !event.target.closest('button') && !dragRef.current) restoreCall(); } : undefined}
    >
      {minimized && (
        <div className="wa-pip-bar" role="toolbar" aria-label="Call controls">
          <span className="wa-pip-text"><strong>{peerName}</strong><small><CallStatusLabel /></small></span>
          <button type="button" className="wa-pip-btn" onClick={toggleMute} aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}>{muted ? <MicOff size={16} /> : <Mic size={16} />}</button>
          <button type="button" className="wa-pip-btn" onClick={restoreCall} aria-label="Return to call"><Maximize2 size={16} /></button>
          <button type="button" className="wa-pip-btn end" onClick={endCall} aria-label="End call"><PhoneOff size={16} /></button>
        </div>
      )}

      <div className={`wa-call-screen ${isVideo ? 'is-video' : 'is-audio'}`} role="dialog" aria-modal={!minimized} aria-label={`${callMode} call with ${peerName}`}>
        {/* VIDEO CALL VIEWPORT (CallGrid: the remote tile, your own floating tile, other participants) */}
        {isVideo && (
          <CallGrid
            stageRef={stageRef} groupGrid={groupGrid} swapped={swapped} remoteVideoLive={remoteVideoLive} canSwapTile={canSwapTile}
            remoteStream={remoteStream} tileProps={tileProps} remoteVideoRef={remoteVideoRef} remoteScreen={remoteScreen}
            filter={filterStyles[filterEffect]} peerName={peerName} remoteAvatar={remoteAvatar} peer={peer} status={status}
            remoteVideoOff={remoteVideoOff} remoteMuted={remoteMuted} extraPeers={extraPeers} audioMuted={audioMuted}
            self={{ selfFull, cameraOff, localVideoRef, facing, screenSharing, videoFilter, avatarStatus, avatarStats, persona, myName, me, muted }}
          />
        )}

        {/* TOP HEADER BAR */}
        <CallHeader />

        {/* FLOATING SIDE TOOLBAR (VIDEO ONLY) */}
        {isVideo && !incomingRinging && (
          <aside className="wa-video-side-toolbar" aria-label="Call tools">
            {canFlip && (
              <button
                type="button"
                className="wa-call-circle-btn"
                onClick={flipCamera}
                title="Switch camera"
                aria-label="Switch camera"
              >
                <SwitchCamera size={20} />
              </button>
            )}
            {torchAvailable && (
              <button
                type="button"
                className={`wa-call-circle-btn ${snapshot.torch ? 'active' : ''}`}
                onClick={toggleTorch}
                title={snapshot.torch ? 'Turn off flash' : 'Turn on flash'}
                aria-label={snapshot.torch ? 'Turn off flash' : 'Turn on flash'}
                aria-pressed={snapshot.torch}
              >
                {snapshot.torch ? <FlashlightOff size={20} /> : <Flashlight size={20} />}
              </button>
            )}
            <button
              type="button"
              className={`wa-call-circle-btn ${filterEffect > 0 ? 'active' : ''}`}
              onClick={cycleFilterEffect}
              title="Effects / Filters"
              aria-label="Effects / Filters"
            >
              <Wand2 size={20} />
            </button>
            {canShareScreen && status === 'connected' && (
              <button
                type="button"
                className={`wa-call-circle-btn ${screenSharing ? 'active' : ''}`}
                onClick={toggleScreenShare}
                title={screenSharing ? 'Stop sharing screen' : 'Share screen'}
                aria-label={screenSharing ? 'Stop sharing screen' : 'Share screen'}
              >
                <MonitorUp size={20} />
              </button>
            )}
            {isVideo && (
              <button
                type="button"
                className={`wa-call-circle-btn ${avatarOn ? 'active' : ''}`}
                onClick={toggleAvatar}
                title={avatarOn ? 'Send my camera instead of the avatar' : persona ? 'Animation Video Call: send my cartoon avatar' : 'Set up your cartoon avatar'}
                aria-label={avatarOn ? 'Turn off cartoon avatar' : 'Turn on cartoon avatar'}
                aria-pressed={avatarOn}
              >
                <ScanFace size={20} />
              </button>
            )}
            {canNativePip && (
              <button
                type="button"
                className="wa-call-circle-btn"
                onClick={toggleNativePip}
                title="Picture in picture"
                aria-label="Picture in picture"
              >
                <PictureInPicture2 size={20} />
              </button>
            )}
          </aside>
        )}

        {/* AUDIO CALL CENTER AVATAR */}
        {!isVideo && (
          <div className="wa-call-audio-body">
            <div className={`wa-call-big-avatar-wrap ${incomingRinging || ['connecting', 'ringing'].includes(status) ? 'pulsing' : ''}`}>
              <Avatar
                name={peerName}
                initials={peer?.initials ?? peerName.slice(0, 2).toUpperCase()}
                color={peer?.color}
                image={peer?.avatar}
                size="large"
              />
              {/* Grows with the other person's voice, drawn on a canvas (no re-renders). */}
              {status === 'connected' && <SpeakingIndicator stream={remoteStream} />}
            </div>
          </div>
        )}

        {/* OTHER PARTICIPANTS (GROUP CALL) */}
        {!isVideo && extraPeers.length > 0 && (
          <div className="wa-call-participants is-audio" aria-label="Other participants">
            {extraPeers.map(({ peerId, info, snapshot: item }) => (
              <ParticipantTile key={peerId} info={info} snapshot={item} video={false} speakerOn={!audioMuted} />
            ))}
          </div>
        )}

        {/* REMOTE AUDIO ELEMENT (HANDLES SOUND OUTPUT IN BOTH AUDIO & VIDEO CALLS) */}
        <audio ref={remoteAudioRef} autoPlay playsInline muted={audioMuted} />

        <FloatingReactions items={floating} />
        {moreOpen && !incomingRinging && !terminal && (
          <CallMoreSheet
            onReact={sendReaction}
            canShareScreen={canShareScreen && status === 'connected'}
            screenSharing={screenSharing}
            onShareScreen={() => { setMoreOpen(false); toggleScreenShare(); }}
            onSendMessage={sendMessageToPeer}
            messageLabel={call.groupId ? 'Group chat' : 'Send message'}
            noiseSuppression={noisePreference}
            onNoiseSuppression={setNoiseCancellation}
            onClose={() => setMoreOpen(false)}
          />
        )}

        {/* ERROR / ROOM NOTICE */}
        <CallNotices error={error} />

        {addOpen && (
          <AddParticipantPicker
            contacts={[...chats, ...(call.members ?? []).filter((member) => !chats.some((chat) => chat.id === member.id))]
              .filter((person) => person.id !== userId && person.id !== call.peerId && !extrasRef.current.forPeer(person.id))}
            onSelect={inviteParticipant}
            onClose={() => setAddOpen(false)}
          />
        )}
        {studioOpen && (
          <AvatarStudio
            onClose={() => setStudioOpen(false)}
            onSaved={() => { setAvatarOn(true); setAvatarCallsEnabled(true); }}
          />
        )}

        {/* VIDEO UPGRADE CONSENT */}
        {videoRequest === 'incoming' && (
          <div className="wa-video-request" role="dialog" aria-label="Video request">
            <span className="wa-video-request-icon"><Video size={20} /></span>
            <span className="wa-video-request-text"><strong>{peerName}</strong> wants to switch to video</span>
            <span className="wa-video-request-actions">
              <button type="button" className="wa-video-request-btn decline" onClick={declineVideo}>Not now</button>
              <button type="button" className="wa-video-request-btn accept" onClick={acceptVideo}>Accept video</button>
            </span>
          </div>
        )}
        {videoRequest === 'outgoing' && (
          <div className="wa-video-request is-waiting" role="status">
            <span className="wa-video-request-icon"><Video size={20} /></span>
            <span className="wa-video-request-text">Waiting for <strong>{peerName}</strong> to accept video…</span>
            <span className="wa-video-request-actions">
              <button type="button" className="wa-video-request-btn decline" onClick={cancelVideoRequest}>Cancel</button>
            </span>
          </div>
        )}

        {/* INCOMING CALL ACTIONS, then the controls (each reads its own store slice) */}
        <IncomingCallSheet />
        <ControlCard />
      </div>
    </div>
  );
}

// Nearest corner for the minimised call window: clear of the status bar at the top and the tab bar at the bottom.
export function pipCorner(rect, viewport = { width: window.innerWidth, height: window.innerHeight }, safeTop = safeAreaTop()) {
  const margin = 12;
  const left = rect.left + rect.width / 2 < viewport.width / 2;
  const top = rect.top + rect.height / 2 < viewport.height / 2;
  return {
    x: left ? margin : Math.max(margin, viewport.width - rect.width - margin),
    y: top ? safeTop + 64 : Math.max(safeTop + 64, viewport.height - rect.height - 84),
  };
}

function safeAreaTop() {
  if (typeof document === 'undefined') return 0;
  const styles = getComputedStyle(document.documentElement);
  return parseFloat(styles.getPropertyValue('--safe-area-inset-top')) || 0;
}

function usePageHidden() {
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.visibilityState === 'hidden');
  useEffect(() => {
    const update = () => setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return hidden;
}
