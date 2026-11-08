import { useEffect, useRef, useState } from 'react';
import {
  Maximize2,
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
import { createCallEngine, TERMINAL_STATUSES } from '../callEngine.js';
import { getStatusLabel } from '../callStatus.js';
import { MAX_CALL_PARTICIPANTS, PeerRegistry, canInvite, peersToConnect } from '../callRoom.js';
import { DEFAULT_ICE_SERVERS, normalizeIceServers } from '../rtc.js';
import { setAvatarCallsEnabled, useAvatarCallsEnabled } from '../appearance.js';
import { personaCharacter, usePersona } from '../avatar/persona.js';
import { createAvatarFilter } from '../avatar/avatarStream.js';
import { loadFaceTracker } from '../avatar/faceTracker.js';
import AvatarStudio from './AvatarStudio.jsx';

const ICE_CONFIG_TIMEOUT_MS = 3000;
const CLOSE_DELAY_MS = { failed: 5000, busy: 4000, default: 2500 };

// Fetches the server's ICE policy with a short deadline so a slow API never delays the call.
async function loadIceServers(sessionToken) {
  try {
    const response = await fetch('/api/v1/rtc-config', {
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
  const live = Boolean(snapshot.remoteStream) && snapshot.remoteHasVideo && !snapshot.remoteVideoOff;
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

function AddParticipantPicker({ contacts, onSelect, onClose }) {
  return (
    <div className="wa-add-participant" role="dialog" aria-modal="true" aria-label="Add participant">
      <header>
        <strong>Add participant</strong>
        <button type="button" className="wa-call-circle-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </header>
      {contacts.length === 0 && <p>Everyone you chat with is already in this call.</p>}
      <ul>
        {contacts.map((contact) => (
          <li key={contact.id}>
            <button type="button" onClick={() => onSelect(contact)}>
              <Avatar name={contact.name} initials={contact.initials ?? contact.name?.slice(0, 2).toUpperCase()} color={contact.color} image={contact.avatar} />
              <span>{contact.name}{contact.username ? <small>@{contact.username}</small> : null}</span>
            </button>
          </li>
        ))}
      </ul>
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
}) {
  const [snapshot, setSnapshot] = useState(() => ({
    status: 'idle', mode: call.mode, error: '', localStream: null, remoteStream: null,
    muted: false, cameraOff: false, facing: 'user', answered: false, connectedAt: 0,
    remoteVideoOff: false, remoteMuted: false, remoteHasVideo: false, videoRequest: null, remoteScreen: false, screenSharing: false,
  }));
  const [speakerOn, setSpeakerOn] = useState(true);
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

  // Shared across the room: one screen capture feeds every pair (each engine gets its own clone).
  const displayShareRef = useRef(null);
  function sharedDisplayMedia(constraints) {
    if (!displayShareRef.current) {
      displayShareRef.current = navigator.mediaDevices.getDisplayMedia(constraints).finally(() => { setTimeout(() => { displayShareRef.current = null; }, 1500); });
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

  // Signals are forwarded in arrival order and routed by pair id; new room offers create a peer that
  // joins immediately (we are already in the room), invite replies become notices.
  useEffect(() => {
    for (const event of signals) {
      const done = () => latest.current.onSignalHandled?.(event.signalId);
      if (event.type === 'call:invite-reply') {
        if (!event.accepted) {
          const who = chats.find((chat) => chat.id === event.from)?.name ?? 'They';
          setNotice(event.reason === 'busy' ? `${who} is on another call` : event.reason === 'offline' ? `${who} is offline` : `${who} declined`);
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
    if (remoteAudioRef.current) remoteAudioRef.current.muted = !speakerOn;
  }, [speakerOn, remoteStream]);

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
  }, [call.direction, status, answered]);

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
  const canShareScreen = Boolean(navigator.mediaDevices?.getDisplayMedia);

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
  const onPipPointerDown = (event) => {
    if (event.target.closest('button')) return;
    const rect = event.currentTarget.parentElement.getBoundingClientRect();
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
  };
  const onTilePointerDown = (event) => {
    if (event.button !== 0) return;
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
  const extraPeers = Object.entries(extraSnapshots).map(([peerId, item]) => ({ peerId, snapshot: item, info: chats.find((chat) => chat.id === peerId) ?? { id: peerId, name: `@${peerId.slice(0, 6)}`, initials: '??' } }));
  const label = getStatusLabel({ status, direction: call.direction, mode: callMode, isOnline, answered, elapsed, group: Boolean(call.invite) || extraPeers.length > 0 });
  const incomingRinging = call.direction === 'incoming' && status === 'idle';
  // The remote tile shows the peer's avatar until their video is live, and again whenever they cover their camera.
  const remoteVideoLive = Boolean(remoteStream) && remoteHasVideo && !remoteVideoOff;
  const filterStyles = ['', 'sepia(0.35) contrast(1.05)', 'hue-rotate(180deg)', 'grayscale(1)'];

  return (
    <div
      ref={floatingRef}
      className={`wa-call-backdrop ${minimized ? 'is-pip' : ''} ${minimized && !isVideo ? 'is-pip-audio' : ''} ${restoring ? 'is-restoring' : ''}`}
      style={minimized && pipPosition ? { left: pipPosition.x, top: pipPosition.y, right: 'auto', bottom: 'auto' } : undefined}
      onClick={minimized ? (event) => { const dragged = draggedRef.current; draggedRef.current = false; if (!dragged && !event.target.closest('button') && !dragRef.current) restoreCall(); } : undefined}
    >
      {minimized && (
        <div className="wa-pip-bar" onPointerDown={onPipPointerDown} onPointerMove={onPipPointerMove} onPointerUp={onPipPointerUp} onPointerCancel={onPipPointerUp} role="toolbar" aria-label="Call controls">
          <span className="wa-pip-text"><strong>{peerName}</strong><small>{label}</small></span>
          <button type="button" className="wa-pip-btn" onClick={toggleMute} aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}>{muted ? <MicOff size={16} /> : <Mic size={16} />}</button>
          <button type="button" className="wa-pip-btn" onClick={restoreCall} aria-label="Return to call"><Maximize2 size={16} /></button>
          <button type="button" className="wa-pip-btn end" onClick={endCall} aria-label="End call"><PhoneOff size={16} /></button>
        </div>
      )}

      <div className={`wa-call-screen ${isVideo ? 'is-video' : 'is-audio'}`} role="dialog" aria-modal={!minimized} aria-label={`${callMode} call with ${peerName}`}>
        {/* VIDEO CALL VIEWPORT */}
        {isVideo && (
          <div className="wa-video-stage" ref={stageRef}>
            {/* Remote video tile (Full by default, or PiP when swapped) */}
            <div
              className={`wa-video-tile ${swapped ? 'is-pip' : 'is-full'} ${!remoteVideoLive ? 'waiting-remote' : ''}`}
              {...(swapped && remoteStream ? tileProps : {})}
              aria-label={swapped ? 'Swap remote video to full screen' : undefined}
              title={swapped ? 'Tap to enlarge' : undefined}
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
              {swapped && remoteStream && (
                <div className="wa-pip-label-overlay">Tap to swap</div>
              )}
            </div>

            {/* Local video tile (PiP by default when remote is connected, or Full while waiting/swapped) */}
            <div
              className={`wa-video-tile ${swapped ? 'is-full' : (remoteStream ? 'is-pip' : 'is-full')} ${cameraOff ? 'camera-off' : ''}`}
              {...(!swapped && remoteStream ? tileProps : {})}
              aria-label={!swapped && remoteStream ? 'Swap self view to full screen' : undefined}
              title={!swapped && remoteStream ? 'Tap to enlarge' : undefined}
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
              {!swapped && remoteStream && (
                <div className="wa-pip-label-overlay">Tap to swap</div>
              )}
            </div>
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
            <h1 className="wa-call-peer-title">{extraPeers.length ? `${peerName} +${extraPeers.length}` : peerName}</h1>
            <span className="wa-call-status-badge">{label}</span>
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
        {extraPeers.length > 0 && (
          <div className={`wa-call-participants ${isVideo ? 'is-video' : 'is-audio'}`} aria-label="Other participants">
            {extraPeers.map(({ peerId, info, snapshot: item }) => (
              <ParticipantTile key={peerId} info={info} snapshot={item} video={isVideo} speakerOn={speakerOn} />
            ))}
          </div>
        )}

        {/* REMOTE AUDIO ELEMENT (HANDLES SOUND OUTPUT IN BOTH AUDIO & VIDEO CALLS) */}
        <audio ref={remoteAudioRef} autoPlay playsInline muted={!speakerOn} />

        {/* ERROR / ROOM NOTICE */}
        {error && <div className="wa-call-error-toast" role="alert">{error}</div>}
        {!error && notice && <div className="wa-call-error-toast is-notice" role="status">{notice}</div>}

        {addOpen && (
          <AddParticipantPicker
            contacts={chats.filter((chat) => chat.id !== userId && chat.id !== call.peerId && !extrasRef.current.forPeer(chat.id))}
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
              className="wa-dock-btn"
              title="More options"
              aria-label="More options"
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
              className={`wa-dock-btn ${!speakerOn ? 'active' : ''}`}
              onClick={() => setSpeakerOn(!speakerOn)}
              title={speakerOn ? 'Mute speaker' : 'Turn speaker on'}
              aria-label={speakerOn ? 'Mute speaker' : 'Turn speaker on'}
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
                onClick={() => setSpeakerOn(!speakerOn)}
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
                className="wa-action-cell"
                title="More options"
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
