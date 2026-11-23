// The native-call delegation seam: a drop-in `rtc` (and getUserMedia) for src/callEngine.js that runs the call's
// MEDIA in the native libwebrtc engine (NativeCallBridge) instead of the WebView's own RTCPeerConnection, while
// callEngine keeps owning the signaling, state machine and reconnection logic. Injected by CallOverlay only when the
// native-call path is on; the WebView path is unchanged otherwise.
//
// STATUS: structure/scaffold. The signaling delegation (offer/answer/ICE), audio, and the video media path are wired
// here against the coarse native bridge; NONE of this is reachable yet (nativeCallsAvailable() is false until a real
// 2nd-device test turns it on). Known gaps are documented inline.
//
// Mapping notes (W3C RTCPeerConnection -> the coarse NativeCall API):
//  - createOffer(): asks the native engine to build+set+emit the offer, resolves with it; setLocalDescription(offer)
//    is then a no-op (native already applied it). Same shape for the answer via setRemoteDescription(offer).
//  - The native engine fetches its OWN ICE servers (/api/v1/rtc-config) and PLAYS remote audio itself (the device
//    audio module), so the iceServers passed to the constructor are ignored and ontrack carries no JS MediaStream —
//    callEngine's <audio>-element playout becomes a no-op for native calls. Revisit when wiring playout/led indicators.
//  - VIDEO: the native engine captures the camera and DRAWS both pictures itself, on a native SurfaceView overlay
//    behind the (made-transparent) WebView — libwebrtc frames cannot reach a WebView <video>. So the local/remote
//    MediaStreams are decorative placeholders: callEngine still tracks remoteHasVideo / cameraOff / facing and the
//    controls work, but the pixels are native. getStats and transceivers remain TODO.
import {
  nativeCallStart, nativeCallAcceptOffer, nativeCallAcceptAnswer, nativeCallRemoteIce, nativeCallMic, nativeCallEnd,
  nativeCallVideoShow, nativeCallSwitchCamera, nativeCallCamera, nativeCallTorch, nativeCallAddVideo,
  nativeCallRenegotiate, nativeCallRollback, nativeCallStats, onNative,
} from './native.js';

// Latest remote audio level (0..1) per native call, fed by the bridge's `callRemoteLevel` sampler, for the speaking
// indicator (the native engine plays remote audio itself, so there is no JS MediaStream to meter). One module-level
// listener keeps the map in step; NativeRtcPeerConnection.close clears its entry.
const remoteAudioLevels = new Map();
try { onNative('callRemoteLevel', (e) => { if (e?.callId) remoteAudioLevels.set(e.callId, Number(e.level) || 0); }); } catch { /* no bridge */ }
/** The latest remote speaking level (0..1) for a native call, for SpeakingIndicator's `level` prop. */
export function nativeRemoteAudioLevel(callId) { return remoteAudioLevels.get(callId) || 0; }

// Off by default — flipped on only for an on-device 2nd-device test. Until then the injection seam is inert and the
// WebView WebRTC stack runs every call. TODO: tie to a per-account native-call flag once verified on two devices.
let nativeCallsOn = false;
export function setNativeCallsEnabled(on) { nativeCallsOn = Boolean(on); }

// Toggles the gated .native-video-call class (src/styles.css) that clears the call screen's backgrounds so the native
// video surface behind the WebView shows, and asks the native side to show/hide its renderer overlay. Guarded for the
// non-browser (callEngine unit tests) case.
function setNativeVideoVisible(callId, on) {
  try {
    if (typeof document !== 'undefined') document.documentElement.classList.toggle('native-video-call', Boolean(on));
  } catch { /* no document */ }
  nativeCallVideoShow(callId, Boolean(on)).catch(() => { /* best-effort */ });
}

// A placeholder MediaStreamTrack good enough for everything callEngine/useMediaElement call on it (the real media is
// in the native engine). It must answer addEventListener/stop/getSettings/clone without throwing — a bare object made
// the call view crash. `onEnabled` lets the audio/video track's `.enabled` toggle reach the native mic/camera, since
// callEngine mutes and turns the camera off by setting `track.enabled` rather than renegotiating.
function fakeMediaTrack(kind, id, { onEnabled, onTorch } = {}) {
  let enabled = true;
  // A camera track advertises a controllable flash so callEngine's torchAvailable()/setTorch() work (best-effort: the
  // native side no-ops if the current camera has no flash). applyConstraints routes the torch toggle natively.
  const capabilities = onTorch ? { torch: true } : {};
  const track = {
    kind, id, readyState: 'live', muted: false, contentHint: '',
    stop() {}, getSettings: () => ({}), getCapabilities: () => capabilities, getConstraints: () => ({}),
    applyConstraints: (constraints) => {
      const advanced = constraints?.advanced;
      if (onTorch && Array.isArray(advanced)) {
        const entry = advanced.find((item) => item && 'torch' in item);
        if (entry) { try { onTorch(Boolean(entry.torch)); } catch { /* ignore */ } }
      }
      return Promise.resolve();
    },
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
    clone() { return fakeMediaTrack(kind, id, { onEnabled, onTorch }); },
  };
  Object.defineProperty(track, 'enabled', {
    get() { return enabled; },
    set(value) { enabled = Boolean(value); try { onEnabled?.(enabled); } catch { /* ignore */ } },
    enumerable: true, configurable: true,
  });
  return track;
}

// The native engine owns the real microphone/camera, so the local MediaStream in the WebView is decorative — but
// callEngine builds it with `new MediaStream()` and adds the (plain-object) placeholder tracks to it. A real
// MediaStream rejects a plain-object track and callEngine then ends the call, so the shim uses this permissive stream.
class FakeMediaStream {
  constructor(tracks = []) { this._tracks = [...tracks]; }
  getTracks() { return this._tracks; }
  getAudioTracks() { return this._tracks.filter((t) => t?.kind === 'audio'); }
  getVideoTracks() { return this._tracks.filter((t) => t?.kind === 'video'); }
  addTrack(track) { if (track && !this._tracks.includes(track)) this._tracks.push(track); }
  removeTrack(track) { this._tracks = this._tracks.filter((t) => t !== track); }
  // useMediaElement binds to the stream's addtrack/removetrack events; the native stream never changes, so these are
  // no-ops — but they must exist or the call view crashes.
  addEventListener() {}
  removeEventListener() {}
  dispatchEvent() { return false; }
}

/** A promise that can be resolved/rejected from outside (for an offer/answer that arrives as a later native event). */
function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * A native-backed RTCPeerConnection for one call/peer (`callId`). Implements the surface src/callEngine.js uses,
 * delegating the media to NativeCallBridge and routing its events (callLocalDescription / callLocalIce / callState /
 * callRemoteAudio / callRemoteVideo) back to the standard handlers callEngine sets.
 */
class NativeRtcPeerConnection {
  constructor(callId, { video = false } = {}) {
    this._callId = callId;
    this._video = video;
    this._localSet = false;         // native sets the local description itself during createOffer/acceptOffer
    this._started = false;          // the first createOffer builds the native call; later ones renegotiate it
    this._iceRestart = false;       // a pending ICE restart, applied to the next renegotiation offer
    this._pendingLocal = null;      // resolves with the locally produced offer/answer from the native event
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    // callEngine reads these to decide what to send (it returns without sending the offer if localDescription is
    // unset). The shim keeps them in step with the native engine's offer/answer so the signaling flows.
    this.localDescription = null;
    this.remoteDescription = null;
    this.signalingState = 'stable';
    // Standard handlers callEngine assigns:
    this.onicecandidate = null;
    this.ontrack = null;
    this.onconnectionstatechange = null;
    this.oniceconnectionstatechange = null;
    this.onnegotiationneeded = null;
    this._senders = [];
    this._subs = [
      onNative('callLocalDescription', (e) => { if (e?.callId === callId) this._pendingLocal?.resolve({ type: e.type, sdp: e.sdp }); }),
      onNative('callLocalIce', (e) => { if (e?.callId === callId && this.onicecandidate) this.onicecandidate({ candidate: { candidate: e.candidate, sdpMid: e.sdpMid, sdpMLineIndex: e.sdpMLineIndex } }); }),
      onNative('callState', (e) => { if (e?.callId === callId) this._onState(e.state); }),
      // Native plays remote audio itself; this only lets callEngine know media is flowing (no JS MediaStream to attach).
      onNative('callRemoteAudio', (e) => { if (e?.callId === callId && this.ontrack) this.ontrack({ track: fakeMediaTrack('audio', 'hm-remote-audio'), streams: [] }); }),
      // The other side's camera: tell callEngine (so it marks remoteHasVideo and lays out the remote tile) and make
      // sure the native renderer overlay is up. The pixels are drawn natively; this track is a placeholder.
      onNative('callRemoteVideo', (e) => {
        if (e?.callId !== callId) return;
        if (this.ontrack) this.ontrack({ track: fakeMediaTrack('video', 'hm-remote-video'), streams: [] });
        setNativeVideoVisible(callId, true);
      }),
    ];
  }

  _onState(state) {
    const next = state === 'connected' ? 'connected' : state === 'closed' ? 'closed' : state === 'failed' ? 'failed' : this.connectionState;
    this.connectionState = next;
    this.iceConnectionState = next;
    if (this._video && next === 'connected') setNativeVideoVisible(this._callId, true);
    this.onconnectionstatechange?.();
    this.oniceconnectionstatechange?.();
  }

  // --- offer/answer ---
  async createOffer() {
    this._pendingLocal = deferred();
    if (!this._started) {
      this._started = true;
      await nativeCallStart(this._callId, this._video);   // native: fetch ICE, build, make+set+emit the offer
    } else {
      // A later offer on the SAME connection — callEngine's negotiate() for an ICE restart (network switch) or a
      // voice→video upgrade. The native engine re-offers on the existing peer connection.
      const iceRestart = this._iceRestart;
      this._iceRestart = false;
      await nativeCallRenegotiate(this._callId, iceRestart);
    }
    const local = await this._pendingLocal.promise;
    this._localSet = true;
    this.localDescription = local;            // so callEngine can read + send the offer
    this.signalingState = 'have-local-offer';
    // Show the local camera preview while the call rings (the native call + its camera track exist by now).
    if (this._video) setNativeVideoVisible(this._callId, true);
    return local;
  }

  async createAnswer() {
    // setRemoteDescription(offer) already kicked off the native answer; just hand it back.
    if (!this._pendingLocal) this._pendingLocal = deferred();
    const local = await this._pendingLocal.promise;
    this._localSet = true;
    this.localDescription = local;            // the answer callEngine will send
    this.signalingState = 'stable';
    if (this._video) setNativeVideoVisible(this._callId, true);
    return local;
  }

  async setLocalDescription(description) {
    // Native applied its own local description during createOffer/acceptOffer; keep our copy in step so callEngine
    // reads the right SDP, and handle rollback.
    if (description?.type === 'rollback') {
      this.signalingState = 'stable';
      try { await nativeCallRollback(this._callId); } catch { /* best-effort glare recovery */ }
      return;
    }
    if (description?.sdp) {
      this.localDescription = description;
      this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable';
    }
  }

  async setRemoteDescription(description) {
    if (!description) return;
    this.remoteDescription = description;
    if (description.type === 'offer') {
      this.signalingState = 'have-remote-offer';
      this._pendingLocal = deferred();                       // the answer will arrive as callLocalDescription
      await nativeCallAcceptOffer(this._callId, description.sdp, this._video);
    } else if (description.type === 'answer') {
      this.signalingState = 'stable';
      await nativeCallAcceptAnswer(this._callId, description.sdp);
    }
  }

  async addIceCandidate(candidate) {
    if (!candidate) return;                                  // a null candidate ends gathering; nothing to add
    await nativeCallRemoteIce(this._callId, candidate);
  }

  // --- tracks (native owns the microphone and camera; a "sender" only carries the mute/camera toggle) ---
  // A sender compatible with what callEngine calls: replaceTrack (mapped to the native mic/camera), and no-op
  // parameter hooks (tuneSender tunes bitrate the native engine sets itself).
  _nativeSender(kind) {
    const callId = this._callId;
    const sender = {
      track: null,
      replaceTrack: async (next) => {
        sender.track = next ?? null;
        // Mute/unmute (audio) or camera off/on (video) follow the replaced track's enabled flag. flipCamera and
        // cameraOff also reach the native engine through the track's own `.enabled` setter (see fakeMediaTrack).
        if (kind === 'audio') await nativeCallMic(callId, Boolean(next?.enabled ?? true));
        else if (kind === 'video') await nativeCallCamera(callId, Boolean(next ? (next.enabled ?? true) : false));
      },
      getParameters: () => ({ encodings: [{}] }),
      setParameters: async () => {},
    };
    return sender;
  }

  addTrack(track) {
    const kind = track?.kind === 'video' ? 'video' : 'audio';
    // callEngine's voice→video upgrade adds a camera track to the live connection (addVideo). Publish a native camera
    // track, show the renderer, and let the subsequent negotiate() renegotiate (see createOffer's renegotiate path).
    if (kind === 'video' && !this._video) {
      this._video = true;
      nativeCallAddVideo(this._callId).catch(() => { /* best-effort */ });
      setNativeVideoVisible(this._callId, true);
    }
    const sender = this._nativeSender(kind);
    sender.track = track ?? null;
    this._senders.push(sender);
    return sender;
  }

  // callEngine's outgoing path opens audio/video slots with addTransceiver and then fills them with
  // sender.replaceTrack. The native engine already owns the tracks, so the slot's sender only needs a working
  // replaceTrack (mapped to the native mic/camera) and no-op parameter hooks — returning a bare object made
  // fillSlots throw and the call end locally right after the offer.
  addTransceiver(kind) {
    const sender = this._nativeSender(kind === 'video' ? 'video' : 'audio');
    this._senders.push(sender);
    return { sender, receiver: { track: null }, setCodecPreferences: () => { /* codecs are native */ } };
  }
  getSenders() { return this._senders; }
  getTransceivers() { return []; }   // native owns the transceivers; callEngine's preferCodecs loops this harmlessly

  // The native PeerConnection's WebRTC stats, shaped as the RTCStatsReport callEngine's quality monitor and telemetry
  // read (forEach + get over flat stat rows: inbound-rtp / outbound-rtp / transport / candidate-pair, with kind).
  async getStats() {
    try {
      const result = await nativeCallStats(this._callId);
      const list = Array.isArray(result?.stats) ? result.stats : [];
      const byId = new Map(list.map((stat) => [stat.id, stat]));
      return {
        forEach: (callback) => { for (const stat of list) callback(stat, stat.id); },
        get: (id) => byId.get(id),
        values: () => list.values(),
        [Symbol.iterator]: () => list[Symbol.iterator](),
      };
    } catch {
      return new Map();
    }
  }

  // --- config / lifecycle ---
  getConfiguration() { return {}; }
  setConfiguration() { /* ICE config is owned natively; no-op */ }

  // Network switch / media stall: callEngine asks for an ICE restart. Flag it and drive a fresh offer on this same
  // connection (createOffer's renegotiate path sends it with the IceRestart constraint).
  restartIce() {
    this._iceRestart = true;
    Promise.resolve().then(() => { try { this.onnegotiationneeded?.(); } catch { /* ignore */ } });
  }

  close() {
    for (const sub of this._subs) { try { sub?.remove?.(); } catch { /* already gone */ } }
    this._subs = [];
    remoteAudioLevels.delete(this._callId);
    if (this._video) setNativeVideoVisible(this._callId, false);
    try { nativeCallEnd(this._callId); } catch { /* best-effort */ }
    this.connectionState = 'closed';
  }
}

/**
 * A minimal getUserMedia for native calls: the native engine captures the microphone and camera itself, so this
 * returns placeholder tracks that only carry the enabled flag (mapped to the native mic/camera) — plus, when the
 * camera is being switched (flipCamera asks getUserMedia again with `switchCamera`), it flips the native camera.
 */
function makeNativeGetUserMedia(callId) {
  const audioTrack = () => fakeMediaTrack('audio', 'hm-local-audio', { onEnabled: (enabled) => { nativeCallMic(callId, enabled).catch(() => {}); } });
  return (constraints = {}) => {
    if (constraints.switchCamera) nativeCallSwitchCamera(callId).catch(() => { /* best-effort */ });
    const tracks = [];
    if (constraints.audio) tracks.push(audioTrack());
    if (constraints.video) {
      tracks.push(fakeMediaTrack('video', 'hm-local-video', {
        onEnabled: (enabled) => { nativeCallCamera(callId, enabled).catch(() => {}); },
        onTorch: (on) => { nativeCallTorch(callId, on).catch(() => {}); },
      }));
    }
    // A call always needs at least one local track for callEngine's slot filling; default to the microphone.
    if (tracks.length === 0) tracks.push(audioTrack());
    return Promise.resolve(new FakeMediaStream(tracks));
  };
}

/** The `rtc` + `getUserMedia` pair to inject into createCallEngine for a native call on `callId`. */
export function createNativeRtc(callId, { video = false } = {}) {
  return {
    rtc: {
      RTCPeerConnection: function (config) { return new NativeRtcPeerConnection(callId, { video }); },
      RTCIceCandidate: function (init) { return init; },
      RTCRtpSender: globalThis.RTCRtpSender,
      MediaStream: FakeMediaStream,
    },
    getUserMedia: makeNativeGetUserMedia(callId),
  };
}

/** Whether the native-call media path should run (off until a 2nd-device test turns it on). */
export function nativeCallsAvailable() {
  return nativeCallsOn;
}
