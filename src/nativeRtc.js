// The native-call delegation seam: a drop-in `rtc` (and getUserMedia) for src/callEngine.js that runs the call's
// MEDIA in the native libwebrtc engine (NativeCallBridge) instead of the WebView's own RTCPeerConnection, while
// callEngine keeps owning the signaling, state machine and reconnection logic. Injected by CallOverlay only when the
// native-call path is on; the WebView path is unchanged otherwise.
//
// STATUS: structure/scaffold. The signaling delegation (offer/answer/ICE) and event routing are wired here against the
// coarse native bridge; several pieces are deliberately stubbed and marked TODO, and NONE of this is reachable yet
// (nativeCallsAvailable() is false until a real 2nd-device test turns it on). The known gaps are documented inline.
//
// Mapping notes (W3C RTCPeerConnection -> the coarse NativeCall API):
//  - createOffer(): asks the native engine to build+set+emit the offer, resolves with it; setLocalDescription(offer)
//    is then a no-op (native already applied it). Same shape for the answer via setRemoteDescription(offer).
//  - The native engine fetches its OWN ICE servers (/api/v1/rtc-config) and PLAYS remote audio itself (the device
//    audio module), so the iceServers passed to the constructor are ignored and ontrack carries no JS MediaStream —
//    callEngine's <audio>-element playout becomes a no-op for native calls. Revisit when wiring playout/led indicators.
//  - Video, getStats, transceivers and replaceTrack-based mute/camera are TODO (audio-first).
import {
  nativeCallStart, nativeCallAcceptOffer, nativeCallAcceptAnswer, nativeCallRemoteIce, nativeCallMic, nativeCallEnd, onNative,
} from './native.js';

// Off by default — flipped on only for an on-device 2nd-device test. Until then the injection seam is inert and the
// WebView WebRTC stack runs every call. TODO: tie to a per-account native-call flag once verified on two devices.
let nativeCallsOn = false;
export function setNativeCallsEnabled(on) { nativeCallsOn = Boolean(on); }

// A placeholder MediaStreamTrack good enough for everything callEngine/useMediaElement call on it (the real media is
// in the native engine). It must answer addEventListener/stop/getSettings/clone without throwing — a bare object made
// the call view crash.
function fakeMediaTrack(kind, id) {
  return {
    kind, id, enabled: true, readyState: 'live', muted: false, contentHint: '',
    stop() {}, getSettings: () => ({}), getCapabilities: () => ({}), applyConstraints: () => Promise.resolve(),
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
    clone() { return fakeMediaTrack(kind, id); },
  };
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
 * callRemoteAudio) back to the standard handlers callEngine sets.
 */
class NativeRtcPeerConnection {
  constructor(callId, { video = false } = {}) {
    this._callId = callId;
    this._video = video;
    this._localSet = false;         // native sets the local description itself during createOffer/acceptOffer
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
    ];
  }

  _onState(state) {
    const next = state === 'connected' ? 'connected' : state === 'closed' ? 'closed' : state === 'failed' ? 'failed' : this.connectionState;
    this.connectionState = next;
    this.iceConnectionState = next;
    this.onconnectionstatechange?.();
    this.oniceconnectionstatechange?.();
  }

  // --- offer/answer ---
  async createOffer() {
    this._pendingLocal = deferred();
    await nativeCallStart(this._callId, this._video);   // native: fetch ICE, build, make+set+emit the offer
    const local = await this._pendingLocal.promise;
    this._localSet = true;
    this.localDescription = local;            // so callEngine can read + send the offer
    this.signalingState = 'have-local-offer';
    return local;
  }

  async createAnswer() {
    // setRemoteDescription(offer) already kicked off the native answer; just hand it back.
    if (!this._pendingLocal) this._pendingLocal = deferred();
    const local = await this._pendingLocal.promise;
    this._localSet = true;
    this.localDescription = local;            // the answer callEngine will send
    this.signalingState = 'stable';
    return local;
  }

  async setLocalDescription(description) {
    // Native applied its own local description during createOffer/acceptOffer; keep our copy in step so callEngine
    // reads the right SDP, and handle rollback.
    if (description?.type === 'rollback') { this.signalingState = 'stable'; return; }
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

  // --- tracks (native owns the microphone; a "sender" only carries the mute toggle) ---
  // A sender compatible with what callEngine calls: replaceTrack (mapped to the native mic for audio), and no-op
  // parameter hooks (tuneSender tunes bitrate the native engine sets itself).
  _nativeSender(kind) {
    const callId = this._callId;
    const sender = {
      track: null,
      replaceTrack: async (next) => {
        sender.track = next ?? null;
        if (kind === 'audio') await nativeCallMic(callId, Boolean(next?.enabled ?? true));
      },
      getParameters: () => ({ encodings: [{}] }),
      setParameters: async () => {},
    };
    return sender;
  }

  addTrack(track) {
    const sender = this._nativeSender(track?.kind === 'video' ? 'video' : 'audio');
    sender.track = track ?? null;
    this._senders.push(sender);
    return sender;
  }

  // callEngine's outgoing path opens audio/video slots with addTransceiver and then fills them with
  // sender.replaceTrack. The native engine already owns the mic track, so the slot's sender only needs a working
  // replaceTrack (mapped to the native mic for audio) and no-op parameter hooks — returning a bare object made
  // fillSlots throw and the call end locally right after the offer.
  addTransceiver(kind) {
    const sender = this._nativeSender(kind === 'video' ? 'video' : 'audio');
    this._senders.push(sender);
    return { sender, receiver: { track: null }, setCodecPreferences: () => { /* codecs are native */ } };
  }
  getSenders() { return this._senders; }
  getTransceivers() { return []; }   // native owns the transceivers; callEngine's preferCodecs loops this harmlessly
  async getStats() { return new Map(); }   // TODO: surface native getStats for the call-quality indicator

  // --- config / lifecycle ---
  getConfiguration() { return {}; }
  setConfiguration() { /* ICE config is owned natively; no-op */ }
  restartIce() { /* TODO: native ICE restart for a network switch */ }

  close() {
    for (const sub of this._subs) { try { sub?.remove?.(); } catch { /* already gone */ } }
    this._subs = [];
    try { nativeCallEnd(this._callId); } catch { /* best-effort */ }
    this.connectionState = 'closed';
  }
}

/**
 * A minimal getUserMedia for native calls: the native engine captures the microphone itself, so this returns a
 * placeholder MediaStream whose single audio track only carries the enabled flag (mapped to the native mic through the
 * sender's replaceTrack). TODO: video capture (a native camera track + a renderer surface).
 */
function nativeGetUserMedia() {
  return Promise.resolve(new FakeMediaStream([fakeMediaTrack('audio', 'hm-local-audio')]));
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
    getUserMedia: nativeGetUserMedia,
  };
}
