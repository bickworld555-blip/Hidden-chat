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
export function nativeCallsAvailable() { return nativeCallsOn; }
export function setNativeCallsEnabled(on) { nativeCallsOn = Boolean(on); }

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
    // Standard handlers callEngine assigns:
    this.onicecandidate = null;
    this.ontrack = null;
    this.onconnectionstatechange = null;
    this.oniceconnectionstatechange = null;
    this.onnegotiationneeded = null;
    this._subs = [
      onNative('callLocalDescription', (e) => { if (e?.callId === callId) this._pendingLocal?.resolve({ type: e.type, sdp: e.sdp }); }),
      onNative('callLocalIce', (e) => { if (e?.callId === callId && this.onicecandidate) this.onicecandidate({ candidate: { candidate: e.candidate, sdpMid: e.sdpMid, sdpMLineIndex: e.sdpMLineIndex } }); }),
      onNative('callState', (e) => { if (e?.callId === callId) this._onState(e.state); }),
      // Native plays remote audio itself; this only lets callEngine know media is flowing (no JS MediaStream to attach).
      onNative('callRemoteAudio', (e) => { if (e?.callId === callId && this.ontrack) this.ontrack({ track: { kind: 'audio' }, streams: [] }); }),
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
    return local;
  }

  async createAnswer() {
    // setRemoteDescription(offer) already kicked off the native answer; just hand it back.
    if (!this._pendingLocal) this._pendingLocal = deferred();
    const local = await this._pendingLocal.promise;
    this._localSet = true;
    return local;
  }

  async setLocalDescription(description) {
    // Native applies its own local description during createOffer/acceptOffer, so this is a no-op except rollback.
    if (description?.type === 'rollback') { /* TODO: native rollback on glare */ }
  }

  async setRemoteDescription(description) {
    if (!description) return;
    if (description.type === 'offer') {
      this._pendingLocal = deferred();                       // the answer will arrive as callLocalDescription
      await nativeCallAcceptOffer(this._callId, description.sdp, this._video);
    } else if (description.type === 'answer') {
      await nativeCallAcceptAnswer(this._callId, description.sdp);
    }
  }

  async addIceCandidate(candidate) {
    if (!candidate) return;                                  // a null candidate ends gathering; nothing to add
    await nativeCallRemoteIce(this._callId, candidate);
  }

  // --- tracks (native owns the microphone; the "sender" only carries the mute toggle) ---
  addTrack(track) {
    const callId = this._callId;
    return {
      track,
      // callEngine toggles the mic by replacing the track / flipping track.enabled; map both to the native mic.
      replaceTrack: async (next) => { await nativeCallMic(callId, Boolean(next?.enabled ?? true)); },
    };
  }

  addTransceiver() { /* TODO: video transceiver when native video lands */ return { sender: {}, receiver: {} }; }
  getSenders() { return []; }        // TODO: expose the mic sender for mute if callEngine needs it directly
  getTransceivers() { return []; }   // TODO
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
  const track = { kind: 'audio', enabled: true, stop() {}, getSettings: () => ({}), addEventListener() {}, removeEventListener() {} };
  return Promise.resolve({
    getTracks: () => [track],
    getAudioTracks: () => [track],
    getVideoTracks: () => [],
    addTrack() {}, removeTrack() {},
  });
}

/** The `rtc` + `getUserMedia` pair to inject into createCallEngine for a native call on `callId`. */
export function createNativeRtc(callId, { video = false } = {}) {
  return {
    rtc: {
      RTCPeerConnection: function (config) { return new NativeRtcPeerConnection(callId, { video }); },
      RTCIceCandidate: function (init) { return init; },
      RTCRtpSender: globalThis.RTCRtpSender,
      MediaStream: globalThis.MediaStream,
    },
    getUserMedia: nativeGetUserMedia,
  };
}
