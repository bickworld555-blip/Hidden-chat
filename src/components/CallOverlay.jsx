import { apiFetch } from '../api.js';
import { nativeCancelIncomingCall, nativeEndCallWindow, nativeSetCallActive, nativeSetSpeaker, nativeShell, nativeShowIncomingCall, onNative } from '../native.js';
import { useEffect, useRef, useState } from 'react';
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
import { getStatusLabel } from '../callStatus.js';
import { MAX_CALL_PARTICIPANTS, PeerRegistry, canInvite, matchesContact, peersToConnect, rankCallContacts } from '../callRoom.js';
import { DEFAULT_ICE_SERVERS, normalizeIceServers } from '../rtc.js';
import { setAvatarCallsEnabled, useAvatarCallsEnabled } from '../appearance.js';
import { personaCharacter, usePersona } from '../avatar/persona.js';
import { createAvatarFilter } from '../avatar/avatarStream.js';
import { loadFaceTracker } from '../avatar/faceTracker.js';
import { lazyComponent } from '../lazy.js';
import { useBackHandler } from '../backStack.js';
import { usesPhoneSound } from '../phoneSounds.js';
const AvatarStudio = lazyComponent(() => import('./AvatarStudio.jsx'));

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

function useMediaElement(ref, stream, enabled = true) {
  const tracksKey = stream?.getTracks().map((track) => track.id).join('|') ?? '';
  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return undefined;
    let boundStream = null;
    const bind = () => {
      boundStream = stream ? new MediaStream(stream.getTracks()) : null;
      element.srcObject = boundStream;
      if (boundStream) element.play?.().catch((error) => console.warn('Call media playback failed:', error));
    };
    bind();
    stream?.addEventListener('addtrack', bind);
    stream?.addEventListener('removetrack', bind);
    return () => {
      stream?.removeEventListener('addtrack', bind);
      stream?.removeEventListener('removetrack', bind);
      if (element.srcObject === boundStream) element.srcObject = null;
    };
  }, [ref, stream, enabled, tracksKey]);
}

// One extra participant of a group call: their video (or avatar) plus a hidden audio element.
function ParticipantTile({ info, snapshot, video, speakerOn }) {
  const videoRef = useRef(null);
  const audioRef = useRef(null);
  const live = video && Boolean(snapshot.remoteStream) && snapshot.remoteHasVideo && !snapshot.remoteVideoOff;
  useMediaElement(videoRef, snapshot.remoteStream, video);
  useMediaElement(audioRef, snapshot.remoteStream);
  useEffect(() => { if (audioRef.current) audioRef.current.muted = !speakerOn; }, [speakerOn, snapshot.remoteStream]);
  const state = snapshot.status === 'connected' ? (snapshot.remoteMuted ? 'Muted' : '') : snapshot.status === 'reconnecting' ? 'Reconnecting…' : TERMINAL_STATUSES.includes(snapshot.status) ? 'Left' : 'Connecting…';
  return (
    <div className={`wa-participant ${live ? 'has-video' : ''}`}>
      {video && <video ref={videoRef} className="wa-video-element" autoPlay playsInline muted style={{ visibility: live ? 'visible' : 'hidden' }} />}
      {!live && <Avatar name={info.name} initials={info.initials ?? info.name?.slice(0, 2).toUpperCase()} color={info.color} image={info.avatar} size={video ? 'normal' : 'large'} />}
      <audio ref={audioRef} autoPlay playsInline />
      <span className="wa-participant-name">{info.name}{state ? ` · ${state}` : ''}</span>
    </div>
  );
}

const NOISE_KEY = 'hm:noise-cancellation';
const SCREEN_SHARE_TIMEOUT_MS = 60_000;
const isVideoMode = (mode) => mode === 'video';

function ContactRow({ contact, onSelect }) {
  return (
    <li>
      <button type="button" onClick={() => onSelect(contact)}>
        <Avatar name={contact.name} initials={contact.initials ?? contact.name?.slice(0, 2).toUpperCase()} color={contact.color} image={contact.avatar} />
        <span>{contact.name}{contact.username && contact.name !== `@${contact.username}` ? <small>@{contact.username}</small> : null}</span>
      </button>
    </li>
  );
}

// "Add people" during a call: frequently contacted first, then everyone else, with search.
function AddParticipantPicker({ contacts, onSelect, onClose }) {
  const messages = useChatStore((state) => state.messages);
  const callLogs = useChatStore((state) => state.callLogs);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const visible = contacts.filter((person) => matchesContact(person, query));
  const { frequent, others } = rankCallContacts(visible, { messages, callLogs });
  return (
    <div className="wa-add-participant" role="dialog" aria-modal="true" aria-label="Add people">
      <header>
        <button type="button" className="wa-call-circle-btn" onClick={onClose} aria-label="Close"><ArrowLeft size={18} /></button>
        {searching ? (
          <input autoFocus className="wa-add-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name or @handle" aria-label="Search contacts" />
        ) : (
          <span className="wa-add-title"><strong>Add people</strong><small>{contacts.length} contact{contacts.length === 1 ? '' : 's'}</small></span>
        )}
        <button type="button" className="wa-call-circle-btn" onClick={() => { setSearching((open) => !open); setQuery(''); }} aria-label={searching ? 'Close search' : 'Search'}>{searching ? <X size={18} /> : <Search size={18} />}</button>
      </header>
      {contacts.length === 0 && <p>Everyone you chat with is already in this call.</p>}
      {contacts.length > 0 && visible.length === 0 && <p>No contacts match “{query}”.</p>}
      <div className="wa-add-scroll">
        {frequent.length > 0 && <h3>Frequently contacted</h3>}
        <ul>{frequent.map((contact) => <ContactRow key={contact.id} contact={contact} onSelect={onSelect} />)}</ul>
        {others.length > 0 && <h3>{frequent.length ? 'Other contacts' : 'Contacts'}</h3>}
        <ul>{others.map((contact) => <ContactRow key={contact.id} contact={contact} onSelect={onSelect} />)}</ul>
      </div>
    </div>
  );
}

// The ⋯ sheet: quick reactions, then Share screen, Send message and Noise cancellation.
function CallMoreSheet({ onReact, canShareScreen, screenSharing, onShareScreen, onSendMessage, noiseSuppression, onNoiseSuppression, onClose }) {
  return (
    <div className="wa-call-more-layer" onClick={onClose} role="presentation">
      <div className="wa-call-more" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="More call options">
        <div className="wa-call-reactions" role="toolbar" aria-label="Send a reaction">
          {CALL_REACTIONS.map((emoji) => <button type="button" key={emoji} onClick={() => onReact(emoji)} aria-label={`React ${emoji}`}>{emoji}</button>)}
        </div>
        <div className="wa-call-more-menu">
          {canShareScreen && (
            <button type="button" onClick={onShareScreen}>
              <span className="wa-call-more-icon"><MonitorUp size={20} /></span>
              <span>{screenSharing ? 'Stop sharing screen' : 'Share screen'}</span>
            </button>
          )}
          <button type="button" onClick={onSendMessage}>
            <span className="wa-call-more-icon"><MessageSquareText size={20} /></span>
            <span>Send message</span>
          </button>
          <button type="button" role="switch" aria-checked={noiseSuppression} onClick={() => onNoiseSuppression(!noiseSuppression)}>
            <span className="wa-call-more-icon"><AudioLines size={20} /></span>
            <span>Noise cancellation</span>
            <span className={`wa-switch${noiseSuppression ? ' on' : ''}`} aria-hidden="true"><span /></span>
          </button>
        </div>
      </div>
    </div>
  );
}

// Reactions float up from the bottom and fade; mine and everyone else's.
function FloatingReactions({ items }) {
  return (
    <div className="wa-call-floating-reactions" aria-live="polite">
      {items.map((item) => <span key={item.id} className={`wa-call-floating-reaction${item.mine ? ' is-mine' : ''}`} style={{ left: `${item.x}%` }} aria-label={item.label}>{item.emoji}</span>)}
    </div>
  );
}

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
  const [elapsed, setElapsed] = useState(0);

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
  useEffect(() => {
    if (!nativeShell()) return undefined;
    // Starting (or switching to video) picks the default route; the button shows what Android actually chose.
    nativeSetCallActive(callLive, isVideo).then((result) => { if (callLive && typeof result?.speaker === 'boolean') setSpeakerOn(result.speaker); });
    return () => { if (callLive) nativeSetCallActive(false); };
  }, [callLive, isVideo]);

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
  const [notice, setNotice] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const chats = useChatStore((state) => state.chats);
  const userId = useChatStore((state) => state.userId);

  // Animation Video Call: the cartoon avatar replaces the camera on every pair engine of this call.
  const avatarCalls = useAvatarCallsEnabled();
  const persona = usePersona();
  const [avatarOn, setAvatarOn] = useState(() => avatarCalls && Boolean(persona));
  const [avatarStatus, setAvatarStatus] = useState('off'); // off | loading | on | error
  const [avatarStats, setAvatarStats] = useState({ fps: 0, latencyMs: 0, tracking: false });
  const [studioOpen, setStudioOpen] = useState(false);
  const avatarStatsRef = useRef(avatarStats);
  const extrasCount = Object.keys(extraSnapshots).length;
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
    setNotice(sent === false ? 'You are offline.' : `Inviting ${nameOf(next)}…`);
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
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

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
  useEffect(() => {
    if (!nativeShell()) return;
    if (ringingIncoming && pageHidden) {
      stopTone('incomingCall');
      nativeShowIncomingCall({ callId: call.id, callerName: peer?.name ?? 'Hidden Messenger', mode: call.mode, phoneRingtone: usesPhoneSound('incomingCall', undefined, true) });
    } else nativeCancelIncomingCall();
  }, [ringingIncoming, pageHidden, call.id, call.mode, peer?.name]);
  useEffect(() => () => { nativeCancelIncomingCall(); nativeEndCallWindow(); }, []);
  const callActionsRef = useRef(null);
  useEffect(() => onNative('callAction', ({ action, callId }) => {
    if (callId && callId !== latest.current.call.id) return;
    if (action === 'accept') callActionsRef.current?.accept();
    else if (action === 'reject') callActionsRef.current?.reject();
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
    if (status !== 'connected' && status !== 'reconnecting') return undefined;
    const startedAt = snapshot.connectedAt || Date.now();
    const tick = () => setElapsed((Date.now() - startedAt) / 1000);
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [status, snapshot.connectedAt]);

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

  callActionsRef.current = { accept: acceptCall, reject: endCall };

  function inviteParticipant(contact) {
    setAddOpen(false);
    const participants = [userId, call.peerId, ...extrasRef.current.peerIds];
    const sent = latest.current.client?.send({ type: 'call:invite', roomId: call.roomId ?? call.id, targetId: contact.id, mode: callMode, participants });
    setNotice(sent === false ? 'You are offline.' : `Inviting ${contact.name}…`);
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
  const [noisePreference, setNoisePreference] = useState(() => {
    try { return localStorage.getItem(NOISE_KEY) !== 'off'; } catch { return true; }
  });
  const setNoiseCancellation = (enabled) => {
    setNoisePreference(enabled);
    try { localStorage.setItem(NOISE_KEY, enabled ? 'on' : 'off'); } catch { /* private mode */ }
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
    onOpenChat?.(call.peerId);
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
  const label = getStatusLabel({ status, direction: call.direction, mode: callMode, isOnline, answered, elapsed, group: Boolean(call.invite) || extraPeers.length > 0 });
  const incomingRinging = call.direction === 'incoming' && status === 'idle';
  // The remote tile shows the peer's avatar until their video is live, and again whenever they cover their camera.
  const remoteVideoLive = Boolean(remoteStream) && remoteHasVideo && !remoteVideoOff;
  const filterStyles = ['', 'sepia(0.35) contrast(1.05)', 'hue-rotate(180deg)', 'grayscale(1)'];

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
          <span className="wa-pip-text"><strong>{peerName}</strong><small>{label}</small></span>
          <button type="button" className="wa-pip-btn" onClick={toggleMute} aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}>{muted ? <MicOff size={16} /> : <Mic size={16} />}</button>
          <button type="button" className="wa-pip-btn" onClick={restoreCall} aria-label="Return to call"><Maximize2 size={16} /></button>
          <button type="button" className="wa-pip-btn end" onClick={endCall} aria-label="End call"><PhoneOff size={16} /></button>
        </div>
      )}

      <div className={`wa-call-screen ${isVideo ? 'is-video' : 'is-audio'}`} role="dialog" aria-modal={!minimized} aria-label={`${callMode} call with ${peerName}`}>
        {/* VIDEO CALL VIEWPORT */}
        {isVideo && (
          <div className={`wa-video-stage ${groupGrid ? 'is-group' : ''}`} ref={stageRef}>
            {/* Remote video tile (Full by default, or PiP when swapped) */}
            <div
              className={`wa-video-tile ${swapped ? 'is-pip' : 'is-full'} ${!remoteVideoLive ? 'waiting-remote' : ''}`}
              {...(canSwapTile && swapped && remoteStream ? tileProps : {})}
              aria-label={canSwapTile && swapped ? 'Swap remote video to full screen' : undefined}
              title={canSwapTile && swapped ? 'Tap to enlarge' : undefined}
            >
              <video
                ref={remoteVideoRef}
                className={`wa-video-element remote-video ${remoteScreen ? 'is-screen' : ''}`}
                autoPlay
                playsInline
                muted
                style={{ filter: filterStyles[filterEffect], visibility: remoteVideoLive ? 'visible' : 'hidden' }}
              />
              {remoteScreen && remoteVideoLive && <span className="wa-share-badge"><MonitorUp size={13} /> {peerName} is sharing their screen</span>}
              {remoteAvatar && !remoteScreen && remoteVideoLive && <span className="wa-share-badge"><ScanFace size={13} /> {peerName} is using a cartoon avatar</span>}
              {!remoteVideoLive && (
                <div className="wa-video-waiting-placeholder">
                  <div className="wa-waiting-avatar">
                    <Avatar name={peerName} initials={peer?.initials ?? peerName.slice(0, 2).toUpperCase()} color={peer?.color} image={peer?.avatar} size="large" />
                  </div>
                  <strong className="wa-waiting-name">{peerName}</strong>
                  <span className="wa-waiting-status">{remoteStream && status === 'connected' ? (remoteVideoOff ? 'Camera off' : 'Voice only') : label}</span>
                </div>
              )}
              {remoteMuted && status === 'connected' && (
                <span className="wa-remote-muted-badge" title={`${peerName} is muted`}><MicOff size={14} /></span>
              )}
              {canSwapTile && swapped && remoteStream && (
                <div className="wa-pip-label-overlay">Tap to swap</div>
              )}
              {groupGrid && <span className="wa-grid-participant-name">{peerName}</span>}
            </div>

            {/* Local video tile (PiP by default when remote is connected, or Full while waiting/swapped) */}
            <div
              className={`wa-video-tile ${swapped ? 'is-full' : (remoteStream ? 'is-pip' : 'is-full')} ${cameraOff ? 'camera-off' : ''}`}
              {...(canSwapTile && !swapped && remoteStream ? tileProps : {})}
              aria-label={canSwapTile && !swapped && remoteStream ? 'Swap self view to full screen' : undefined}
              title={canSwapTile && !swapped && remoteStream ? 'Tap to enlarge' : undefined}
            >
              <video
                ref={localVideoRef}
                className={`wa-video-element local-video ${facing === 'user' && !screenSharing && !videoFilter ? 'mirror' : ''} ${screenSharing ? 'is-screen' : ''}`}
                autoPlay
                playsInline
                muted
                style={{ filter: filterStyles[filterEffect] }}
              />
              {screenSharing && <span className="wa-share-badge mine"><MonitorUp size={13} /> You're sharing your screen</span>}
              {!screenSharing && avatarStatus === 'loading' && <span className="wa-share-badge mine"><ScanFace size={13} /> Loading face tracker…</span>}
              {!screenSharing && videoFilter && (
                <span className="wa-share-badge mine wa-avatar-badge" title="Avatar rendering: frames per second and tracking time per frame on this device">
                  <ScanFace size={13} /> {personaCharacter(persona).name} · {avatarStats.fps} fps · {avatarStats.latencyMs} ms{avatarStats.tracking ? '' : ' · looking for your face'}
                </span>
              )}
              {cameraOff && (
                <div className="wa-video-off-notice">
                  <VideoOff size={28} />
                  <span>Camera off</span>
                </div>
              )}
              {canSwapTile && !swapped && remoteStream && (
                <div className="wa-pip-label-overlay">Tap to swap</div>
              )}
              {groupGrid && <span className="wa-grid-participant-name">You{muted ? ' · Muted' : ''}</span>}
            </div>
            {extraPeers.map(({ peerId, info, snapshot: item }) => (
              <ParticipantTile key={peerId} info={info} snapshot={item} video speakerOn={!audioMuted} />
            ))}
          </div>
        )}

        {/* TOP HEADER BAR */}
        <header className="wa-call-header">
          {incomingRinging || terminal ? (
            <span className="wa-call-header-spacer" />
          ) : (
            <button
              type="button"
              className="wa-call-circle-btn"
              onClick={minimizeCall}
              aria-label="Minimize call"
              title="Minimize call"
            >
              <Minimize2 size={20} />
            </button>
          )}

          <div className="wa-call-header-info">
            <h1 className="wa-call-peer-title">{call.groupName ? call.groupName : extraPeers.length ? `${peerName} +${extraPeers.length}` : peerName}</h1>
            <span className="wa-call-status-badge">{!terminal && <Lock size={11} className="wa-call-lock" aria-label="End-to-end encrypted" />}{label}</span>
          </div>

          {!incomingRinging && !terminal ? (
            <button
              type="button"
              className="wa-call-circle-btn"
              onClick={() => setAddOpen(true)}
              disabled={!canInvite(1 + extrasRef.current.size) || status !== 'connected'}
              title={canInvite(1 + extrasRef.current.size) ? 'Add participant' : `Up to ${MAX_CALL_PARTICIPANTS} people`}
              aria-label="Add participant"
            >
              <UserPlus size={20} />
            </button>
          ) : <span className="wa-call-header-spacer" />}
        </header>

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
            noiseSuppression={noisePreference}
            onNoiseSuppression={setNoiseCancellation}
            onClose={() => setMoreOpen(false)}
          />
        )}

        {/* ERROR / ROOM NOTICE */}
        {error && <div className="wa-call-error-toast" role="alert">{error}</div>}
        {!error && notice && <div className="wa-call-error-toast is-notice" role="status">{notice}</div>}

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

        {/* INCOMING CALL ACTIONS */}
        {incomingRinging ? (
          <div className="wa-incoming-call-actions">
            <button type="button" className="wa-incoming-btn decline" onClick={endCall}>
              <span className="wa-incoming-icon"><PhoneOff size={28} /></span>
              <span className="wa-incoming-label">Decline</span>
            </button>
            <button type="button" className="wa-incoming-btn accept" onClick={acceptCall}>
              <span className="wa-incoming-icon"><Phone size={28} /></span>
              <span className="wa-incoming-label">Accept</span>
            </button>
          </div>
        ) : isVideo ? (
          /* VIDEO CALL BOTTOM FLOATING DOCK */
          <footer className="wa-video-bottom-dock">
            <button
              type="button"
              className={`wa-dock-btn ${moreOpen ? 'active' : ''}`}
              onClick={() => setMoreOpen((open) => !open)}
              title="More options"
              aria-label="More options"
              aria-expanded={moreOpen}
            >
              <MoreHorizontal size={22} />
            </button>

            <button
              type="button"
              className={`wa-dock-btn ${cameraOff ? 'active' : ''}`}
              onClick={toggleCamera}
              title={cameraOff ? 'Turn camera on' : 'Turn camera off'}
              aria-label={cameraOff ? 'Turn camera on' : 'Turn camera off'}
            >
              {cameraOff ? <VideoOff size={22} /> : <Video size={22} />}
            </button>

            <button
              type="button"
              className={`wa-dock-btn ${nativeRouting ? (speakerOn ? 'active' : '') : (!speakerOn ? 'active' : '')}`}
              onClick={toggleSpeaker}
              title={speakerLabel}
              aria-label={speakerLabel}
              aria-pressed={speakerOn}
            >
              {speakerOn ? <Volume2 size={22} /> : <VolumeX size={22} />}
            </button>

            <button
              type="button"
              className={`wa-dock-btn ${muted ? 'active' : ''}`}
              onClick={toggleMute}
              title={muted ? 'Unmute microphone' : 'Mute microphone'}
              aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
            >
              {muted ? <MicOff size={22} /> : <Mic size={22} />}
            </button>

            <button
              type="button"
              className="wa-dock-btn end-call"
              onClick={endCall}
              title={terminal ? 'Close' : 'End call'}
              aria-label={terminal ? 'Close' : 'End call'}
            >
              <PhoneOff size={22} />
            </button>
          </footer>
        ) : (
          /* AUDIO CALL BOTTOM SHEET CARD (WHATSAPP 2-ROW GRID) */
          <footer className="wa-audio-bottom-sheet">
            <div className="wa-audio-actions-grid">
              {/* Row 1 */}
              <button
                type="button"
                className={`wa-action-cell ${speakerOn ? 'selected' : ''}`}
                onClick={toggleSpeaker}
                aria-label={speakerLabel}
                aria-pressed={speakerOn}
              >
                <span className="wa-action-bubble">
                  {speakerOn ? <Volume2 size={24} /> : <VolumeX size={24} />}
                </span>
                <span className="wa-action-name">Speaker</span>
              </button>

              <button
                type="button"
                className={`wa-action-cell ${videoRequest === 'outgoing' ? 'selected' : ''}`}
                onClick={videoRequest === 'outgoing' ? cancelVideoRequest : requestVideo}
                disabled={status !== 'connected' && status !== 'reconnecting'}
                title={status === 'connected' ? 'Ask to switch to video' : 'Available once connected'}
              >
                <span className="wa-action-bubble">
                  <Video size={24} />
                </span>
                <span className="wa-action-name">Video</span>
              </button>

              <button
                type="button"
                className={`wa-action-cell ${muted ? 'selected' : ''}`}
                onClick={toggleMute}
              >
                <span className="wa-action-bubble">
                  {muted ? <MicOff size={24} /> : <Mic size={24} />}
                </span>
                <span className="wa-action-name">Mute</span>
              </button>

              {/* Row 2 */}
              <button
                type="button"
                className={`wa-action-cell ${moreOpen ? 'selected' : ''}`}
                onClick={() => setMoreOpen((open) => !open)}
                title="More options"
                aria-expanded={moreOpen}
              >
                <span className="wa-action-bubble">
                  <MoreHorizontal size={24} />
                </span>
                <span className="wa-action-name">More</span>
              </button>

              <button
                type="button"
                className={`wa-action-cell ${screenSharing ? 'selected' : ''}`}
                title={canShareScreen ? (screenSharing ? 'Stop sharing screen' : 'Share your screen') : 'Screen sharing is not available in this browser'}
                onClick={toggleScreenShare}
                disabled={!canShareScreen || status !== 'connected'}
              >
                <span className="wa-action-bubble">
                  <MonitorUp size={22} />
                </span>
                <span className="wa-action-name">{screenSharing ? 'Stop share' : 'Share screen'}</span>
              </button>

              {isVideo && (
                <button
                  type="button"
                  className={`wa-action-cell ${avatarOn ? 'selected' : ''}`}
                  title={avatarOn ? 'Send my camera instead of the avatar' : persona ? 'Animation Video Call: send my cartoon avatar' : 'Set up your cartoon avatar'}
                  onClick={toggleAvatar}
                  aria-pressed={avatarOn}
                >
                  <span className="wa-action-bubble">
                    <ScanFace size={22} />
                  </span>
                  <span className="wa-action-name">{avatarOn ? 'Avatar on' : 'Avatar'}</span>
                </button>
              )}

              <button
                type="button"
                className="wa-action-cell danger"
                onClick={endCall}
              >
                <span className="wa-action-bubble end-btn">
                  <PhoneOff size={24} />
                </span>
                <span className="wa-action-name">End</span>
              </button>
            </div>
          </footer>
        )}
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
