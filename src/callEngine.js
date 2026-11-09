// Framework-free WebRTC call engine. Owns one RTCPeerConnection, local/remote streams,
// the inbound signal queue, perfect negotiation, ICE restart and all call timers.
// The UI only subscribes to snapshots; Node tests drive it with @roamhq/wrtc.
import {
  AUDIO_MAX_BITRATE,
  VIDEO_MAX_BITRATE,
  VIDEO_MAX_FRAMERATE,
  candidateToJson,
  describeForPeer,
  mediaConstraints,
  orderCodecs,
  readDescription,
  videoConstraints,
} from './rtc.js';

export const TERMINAL_STATUSES = Object.freeze(['ended', 'no-answer', 'failed', 'busy']);
export const CALL_STATUSES = Object.freeze(['idle', 'connecting', 'ringing', 'connected', 'reconnecting', ...TERMINAL_STATUSES]);

export const CONNECT_TIMEOUT_MS = 30_000;
export const RECONNECT_GRACE_MS = 15_000;
export const ICE_RESTART_DELAY_MS = 2_000;
export const MAX_ICE_RESTARTS = 2;
export const VIDEO_REQUEST_TIMEOUT_MS = 30_000;
// Quick reactions that float over the call, sent to everyone in it.
export const CALL_REACTIONS = Object.freeze(['👍', '❤️', '😂', '😮', '😢', '🙏']);

const CAMERA_LABELS = {
  environment: /back|rear|environment|world/i,
  user: /front|user|face|selfie/i,
};

// Candidate getUserMedia video constraints for switching to `facing`, strongest first. A device id picked
// from enumerateDevices is the only reliable selector on many Android browsers; facingMode is the fallback.
export function cameraSwitchPlans({ facing, devices = [], currentDeviceId = '' }) {
  const base = videoConstraints(facing);
  const plans = [];
  const inputs = devices.filter((device) => device.kind === 'videoinput' && device.deviceId);
  const labelled = inputs.find((device) => device.deviceId !== currentDeviceId && CAMERA_LABELS[facing]?.test(device.label || ''));
  const other = inputs.find((device) => device.deviceId !== currentDeviceId);
  for (const device of [labelled, other]) {
    if (device && !plans.some((plan) => plan.deviceId?.exact === device.deviceId)) {
      const { facingMode, ...rest } = base;
      plans.push({ ...rest, deviceId: { exact: device.deviceId } });
    }
  }
  plans.push({ ...base, facingMode: { exact: facing } });
  plans.push(base);
  return plans;
}

export function endReasonMessage(reason, direction) {
  if (reason === 'no-answer') return direction === 'outgoing' ? 'No answer.' : 'Missed call.';
  if (reason === 'busy') return 'The other person is on another call.';
  if (reason === 'disconnected') return 'The other device disconnected.';
  if (reason === 'failed') return 'Could not connect this call.';
  if (reason === 'answered-elsewhere') return 'Answered on another device.';
  return 'Call ended.';
}

export function endReasonStatus(reason, direction) {
  if (reason === 'no-answer' && direction === 'outgoing') return 'no-answer';
  if (reason === 'busy') return 'busy';
  if (reason === 'failed') return 'failed';
  return 'ended';
}

function mediaAccessError(reason) {
  if (reason?.name === 'NotAllowedError' || reason?.name === 'SecurityError') return 'Allow microphone and camera access in browser settings.';
  if (reason?.name === 'NotFoundError' || reason?.name === 'OverconstrainedError') return 'No microphone or camera was found.';
  if (reason?.name === 'NotReadableError') return 'The microphone or camera is in use by another app.';
  return reason?.message || 'Media devices are unavailable.';
}

export function createCallEngine({
  callId,
  direction,
  mode,
  offer = null,
  rtc,
  getUserMedia,
  getDisplayMedia = null,
  enumerateDevices = async () => [],
  fetchIceServers = async () => [],
  send,
  onSnapshot = () => {},
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  log = () => {},
} = {}) {
  if (!rtc?.RTCPeerConnection) throw new Error('A WebRTC implementation is required.');
  if (typeof send !== 'function') throw new Error('A signal sender is required.');

  const polite = direction === 'incoming';
  const state = {
    callId,
    direction,
    mode,
    status: 'idle',
    error: '',
    endReason: null,
    localStream: null,
    remoteStream: null,
    muted: false,
    cameraOff: false,
    facing: 'user',
    answered: false,
    connectedAt: 0,
    iceRestarts: 0,
    // What the other side is sending us, so their tile can show "camera off" without touching ours.
    remoteVideoOff: false,
    remoteMuted: false,
    remoteHasVideo: false,
    remoteScreen: false,
    screenSharing: false,
    // A video filter (e.g. the cartoon avatar) is rendering the camera into the track the peer receives.
    videoFilter: false,
    remoteAvatar: false,
    // null | 'outgoing' (we asked) | 'incoming' (they asked)
    videoRequest: null,
    // Browser noise suppression on our microphone (on by default, like the capture constraints).
    noiseSuppression: true,
    // The back camera's flash, where the device exposes it.
    torch: false,
    // The latest reaction from the other side: { emoji, at } (a new object each time, so repeats re-trigger).
    remoteReaction: null,
  };

  let connection = null;
  let closed = false;
  let connectedAnnounced = false;
  let peerConnected = false;
  let switchingCamera = false;
  let screenTrack = null;
  let modeBeforeShare = null;
  let videoSender = null;
  // The filter factory the host asked for, the running filter, the camera track feeding it, and its output.
  let filterFactory = null;
  let filter = null;
  let filterInput = null;
  let filterOutput = null;
  let makingOffer = false;
  let ignoreOffer = false;
  let offerSent = false;
  let remoteDescriptionSet = false;
  let localTracksReady = false;
  const pendingCandidates = [];
  const queue = [];
  let draining = false;
  const timers = { connect: null, reconnect: null, restart: null, videoRequest: null };
  const seenSignalIds = new Set();

  function emit() {
    onSnapshot({ ...state });
  }

  function set(patch) {
    Object.assign(state, patch);
    emit();
  }

  function sendSignal(signal) {
    if (closed && signal.type !== 'end') return false;
    return send({ type: 'call:signal', callId, mode: state.mode, signal }) !== false;
  }

  function clearAllTimers() {
    for (const key of Object.keys(timers)) {
      if (timers[key] != null) clearTimer(timers[key]);
      timers[key] = null;
    }
  }

  function stopStream(stream) {
    stream?.getTracks?.().forEach((track) => {
      try { track.stop(); } catch {}
    });
  }

  function releaseConnection() {
    const current = connection;
    connection = null;
    if (!current) return;
    current.onicecandidate = null;
    current.ontrack = null;
    current.onnegotiationneeded = null;
    current.onconnectionstatechange = null;
    current.oniceconnectionstatechange = null;
    current.onsignalingstatechange = null;
    try { current.close(); } catch {}
  }

  // Releases every owned resource exactly once; tracks are stopped so cameras and
  // microphones switch off even if a React tree keeps references around.
  function teardown() {
    if (closed) return;
    closed = true;
    clearAllTimers();
    releaseConnection();
    stopStream(state.localStream);
    if (screenTrack) { screenTrack.onended = null; screenTrack.stop(); screenTrack = null; }
    releaseFilter({ stopCamera: true });
    stopStream(state.remoteStream);
    pendingCandidates.length = 0;
    queue.length = 0;
    state.localStream = null;
    state.remoteStream = null;
  }

  function finish(status, { reason = 'ended', message = '', notify = true } = {}) {
    if (closed) return;
    if (notify) sendSignal({ type: 'end', reason });
    teardown();
    set({ status, error: message, endReason: reason });
  }

  function failConnection(message) {
    finish('failed', { reason: 'failed', message });
  }

  // Both peers flip to the live timer together: whichever transport reports first tells the other.
  function markConnected({ announce = false } = {}) {
    if (closed) return;
    if (announce && !connectedAnnounced) {
      connectedAnnounced = true;
      sendSignal({ type: 'connected' });
    }
    if (state.status === 'connected') return;
    clearTimer(timers.connect);
    clearTimer(timers.reconnect);
    timers.connect = null;
    timers.reconnect = null;
    set({ status: 'connected', error: '', answered: true, connectedAt: state.connectedAt || Date.now(), iceRestarts: 0 });
    if (state.muted || state.cameraOff) announceMedia();
  }

  function armConnectTimeout() {
    if (timers.connect != null) clearTimer(timers.connect);
    timers.connect = setTimer(() => {
      timers.connect = null;
      if (!closed && state.status !== 'connected') failConnection('Could not connect. Check your network or add a TURN server.');
    }, CONNECT_TIMEOUT_MS);
  }

  function scheduleIceRestart() {
    if (closed || timers.restart != null || !connection?.restartIce) return;
    if (state.iceRestarts >= MAX_ICE_RESTARTS) return;
    timers.restart = setTimer(() => {
      timers.restart = null;
      if (closed || !connection) return;
      const current = connection.connectionState;
      if (current === 'connected' || current === 'closed') return;
      set({ iceRestarts: state.iceRestarts + 1 });
      log('ice-restart', state.iceRestarts);
      // Only the impolite side (caller) restarts so both peers never glare on an offer.
      if (!polite) {
        try { connection.restartIce(); } catch {}
      }
    }, ICE_RESTART_DELAY_MS);
  }

  function attachRemoteTrack(event) {
    const incoming = event.streams?.[0];
    let stream = state.remoteStream;
    if (incoming) {
      stream = incoming;
    } else {
      stream = stream || new rtc.MediaStream();
      if (!stream.getTracks().some((track) => track.id === event.track.id)) stream.addTrack(event.track);
    }
    const patch = { remoteStream: stream };
    if (event.track.kind === 'video') {
      patch.remoteHasVideo = true;
      // Video arriving in a voice call (older clients send it without asking) opens the video layout.
      if (state.mode !== 'video') patch.mode = 'video';
    }
    set(patch);
  }

  // Tells the peer which of our tracks are live so their UI reflects it without guessing from frames.
  function announceMedia() {
    sendSignal({ type: 'media', video: state.mode === 'video' && !state.cameraOff, audio: !state.muted, screen: state.screenSharing, avatar: Boolean(filter) });
  }

  // --- Video filter: the camera keeps running as the filter's input; its output is what the peer receives. ---

  // The camera track we own right now, whether it is sent directly or feeds the filter.
  function cameraTrack() {
    return filterInput ?? state.localStream?.getVideoTracks().find((track) => track !== filterOutput) ?? null;
  }

  function releaseFilter({ stopCamera = false } = {}) {
    const running = filter;
    const input = filterInput;
    const output = filterOutput;
    filter = null;
    filterInput = null;
    filterOutput = null;
    if (output) { try { output.stop(); } catch {} state.localStream?.removeTrack(output); }
    try { running?.stop(); } catch (error) { log('video-filter-stop-failed', error); }
    if (input && stopCamera) { try { input.stop(); } catch {} }
    state.videoFilter = false;
    return input;
  }

  // Starts `filterFactory` on `camera` and routes its output to the peer and the self view.
  async function applyFilter(camera) {
    if (!filterFactory || !camera || closed || !state.localStream) return false;
    const sender = videoSender ?? connection?.getSenders().find((item) => item.track?.kind === 'video') ?? null;
    let running;
    let output;
    try {
      running = filterFactory();
      output = await running.start(camera);
      if (!output) throw new Error('The video filter produced no track.');
    } catch (error) {
      log('video-filter-start-failed', error);
      try { running?.stop(); } catch {}
      set({ error: typeof error?.message === 'string' && error.message ? error.message : 'Could not start the video filter.' });
      return false;
    }
    if (closed) { try { running.stop(); } catch {} return false; }
    filter = running;
    filterInput = camera;
    filterOutput = output;
    output.enabled = !state.cameraOff;
    state.localStream.removeTrack(camera);
    state.localStream.addTrack(output);
    try {
      if (sender) await sender.replaceTrack(output);
    } catch (error) {
      log('video-filter-replace-failed', error);
      releaseFilter();
      state.localStream.addTrack(camera);
      set({ error: 'Could not start the video filter.' });
      return false;
    }
    set({ videoFilter: true, error: '' });
    announceMedia();
    return true;
  }

  // Puts the camera back on the wire and in the self view.
  async function removeFilter() {
    const camera = releaseFilter();
    if (closed || !camera || !state.localStream) { set({ videoFilter: false }); return; }
    camera.enabled = !state.cameraOff;
    state.localStream.addTrack(camera);
    const sender = videoSender ?? connection?.getSenders().find((item) => item.track === null || item.track?.kind === 'video') ?? null;
    try { await sender?.replaceTrack(camera); } catch (error) { log('video-filter-restore-failed', error); }
    set({ videoFilter: false });
    announceMedia();
  }

  function clearVideoRequest(patch = {}) {
    if (timers.videoRequest != null) clearTimer(timers.videoRequest);
    timers.videoRequest = null;
    set({ videoRequest: null, ...patch });
  }

  // Adds our camera to an existing call and renegotiates; shared by the consent flow on both sides.
  async function addVideo() {
    if (closed || state.mode === 'video' || !connection || !state.localStream) return state.mode === 'video';
    try {
      const extra = await getUserMedia({ video: videoConstraints(state.facing), audio: false });
      if (closed) { stopStream(extra); return false; }
      const [track] = extra.getVideoTracks();
      if (!track) return false;
      state.localStream.addTrack(track);
      const sender = connection.addTrack(track, state.localStream);
      videoSender = sender;
      tuneSender(sender);
      preferCodecs();
      set({ mode: 'video', cameraOff: false });
      announceMedia();
      // When the peer is mid-offer, negotiationneeded fires again once we return to stable.
      if (connection.signalingState === 'stable') await negotiate();
      if (filterFactory) await applyFilter(track);
      return true;
    } catch (error) {
      set({ error: mediaAccessError(error) });
      return false;
    }
  }

  function tuneSender(sender) {
    const kind = sender.track?.kind;
    if (!kind || typeof sender.getParameters !== 'function' || typeof sender.setParameters !== 'function') return;
    try {
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      if (kind === 'audio') {
        params.encodings[0].maxBitrate = AUDIO_MAX_BITRATE;
        params.encodings[0].priority = 'high';
        params.encodings[0].networkPriority = 'high';
      } else {
        params.encodings[0].maxBitrate = VIDEO_MAX_BITRATE;
        params.encodings[0].maxFramerate = VIDEO_MAX_FRAMERATE;
        params.encodings[0].scaleResolutionDownBy = 1;
      }
      // Under congestion trade a little of both rather than dropping straight to a blurry low resolution.
      if (params.degradationPreference !== undefined || kind === 'video') params.degradationPreference = 'balanced';
      Promise.resolve(sender.setParameters(params)).catch(() => {});
    } catch {}
  }

  function preferCodecs() {
    const caps = rtc.RTCRtpSender?.getCapabilities?.('video');
    if (!caps?.codecs) return;
    for (const transceiver of connection.getTransceivers()) {
      if (transceiver.sender?.track?.kind === 'video' && typeof transceiver.setCodecPreferences === 'function') {
        try { transceiver.setCodecPreferences(orderCodecs(caps.codecs)); } catch {}
      }
    }
  }

  async function negotiate() {
    if (closed || !connection) return;
    try {
      makingOffer = true;
      await connection.setLocalDescription(await connection.createOffer());
      if (closed || !connection.localDescription) return;
      offerSent = true;
      sendSignal(describeForPeer(connection.localDescription));
    } catch (error) {
      log('negotiate-error', error);
    } finally {
      makingOffer = false;
    }
  }

  function wireConnection(pc) {
    pc.onicecandidate = (event) => {
      if (event.candidate) sendSignal({ type: 'ice', candidate: candidateToJson(event.candidate) });
    };
    pc.ontrack = attachRemoteTrack;
    pc.onnegotiationneeded = () => {
      // Initial offers are produced explicitly; this covers later adds (voice to video) and ICE restarts.
      if (!makingOffer && localTracksReady && remoteDescriptionSet && pc.signalingState === 'stable') negotiate();
    };
    pc.onconnectionstatechange = () => {
      if (pc !== connection) return;
      const next = pc.connectionState;
      log('connectionState', next);
      if (next === 'connected') {
        markConnected({ announce: true });
      } else if (next === 'disconnected') {
        if (state.status === 'connected') set({ status: 'reconnecting' });
        if (timers.reconnect == null) {
          timers.reconnect = setTimer(() => {
            timers.reconnect = null;
            if (!closed && pc.connectionState !== 'connected') finish('ended', { reason: 'disconnected', message: 'The call disconnected.' });
          }, RECONNECT_GRACE_MS);
        }
        scheduleIceRestart();
      } else if (next === 'failed') {
        if (state.iceRestarts >= MAX_ICE_RESTARTS) failConnection('Could not connect. Check your network or add a TURN server.');
        else {
          if (state.status === 'connected') set({ status: 'reconnecting' });
          scheduleIceRestart();
        }
      }
    };
    pc.oniceconnectionstatechange = () => {
      if (pc !== connection) return;
      const ice = pc.iceConnectionState;
      log('iceConnectionState', ice);
      if (ice === 'connected' || ice === 'completed') markConnected({ announce: true });
    };
  }

  async function flushCandidates() {
    if (!connection || !remoteDescriptionSet) return;
    const queued = pendingCandidates.splice(0);
    for (const candidate of queued) {
      try { await connection.addIceCandidate(candidate); } catch (error) { if (!ignoreOffer) log('candidate-error', error); }
    }
  }

  async function ensureConnection() {
    if (connection) return connection;
    let iceServers = [];
    try {
      iceServers = await fetchIceServers();
    } catch (error) {
      log('ice-config-error', error);
    }
    if (closed) throw new Error('Call closed.');
    const pc = new rtc.RTCPeerConnection({
      iceServers: Array.isArray(iceServers) ? iceServers : [],
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: 2,
    });
    connection = pc;
    wireConnection(pc);
    return pc;
  }

  async function captureLocal(targetMode) {
    const stream = await getUserMedia(mediaConstraints(targetMode, state.facing)).catch((reason) => {
      throw new Error(mediaAccessError(reason));
    });
    if (closed) {
      stopStream(stream);
      throw new Error('Call closed.');
    }
    set({ localStream: stream });
    return stream;
  }

  function addLocalTracks(stream) {
    for (const track of stream.getTracks()) {
      const sender = connection.addTrack(track, stream);
      if (track.kind === 'video') videoSender = sender;
      tuneSender(sender);
    }
    preferCodecs();
    localTracksReady = true;
    const camera = stream.getVideoTracks()[0];
    if (filterFactory && camera) applyFilter(camera).catch((error) => log('video-filter-start-failed', error));
  }

  async function applyRemoteDescription(description) {
    await connection.setRemoteDescription(description);
    remoteDescriptionSet = true;
    await flushCandidates();
  }

  async function handleDescription(description) {
    await ensureConnection();
    if (description.type === 'offer') {
      const collision = makingOffer || connection.signalingState !== 'stable';
      ignoreOffer = !polite && collision;
      if (ignoreOffer) {
        log('offer-ignored');
        return;
      }
      if (collision) {
        // Polite side rolls back its own pending offer and accepts the remote one.
        await Promise.all([
          connection.setLocalDescription({ type: 'rollback' }),
          applyRemoteDescription(description),
        ]);
      } else {
        await applyRemoteDescription(description);
      }
      if (!localTracksReady) {
        // First offer on the incoming side: media is captured in accept(); the answer waits there.
        return;
      }
      await connection.setLocalDescription(await connection.createAnswer());
      sendSignal(describeForPeer(connection.localDescription));
    } else {
      if (connection.signalingState !== 'have-local-offer') {
        log('answer-ignored', connection.signalingState);
        return;
      }
      await applyRemoteDescription(description);
      if (state.status === 'ringing' || state.status === 'connecting') {
        // Ringing is unbounded; the transport gets a bounded window once both descriptions exist.
        armConnectTimeout();
        set({ status: 'connecting', answered: true });
      }
      if (peerConnected) markConnected();
    }
  }

  async function handleSignal(signal) {
    if (closed || !signal || typeof signal !== 'object') return;
    switch (signal.type) {
      case 'ringing':
        if (state.status === 'connecting' && direction === 'outgoing' && !state.answered) set({ status: 'ringing' });
        return;
      case 'connected':
        // The peer's transport is up, so ours is at most milliseconds behind; show the timer now
        // rather than waiting for our own state event. Before both descriptions exist it is remembered only.
        peerConnected = true;
        if (remoteDescriptionSet && connection?.localDescription) markConnected();
        return;
      case 'offer':
      case 'answer': {
        const description = readDescription(signal);
        if (!description) return;
        await handleDescription(description);
        return;
      }
      case 'ice': {
        if (!signal.candidate?.candidate) return;
        const candidate = new rtc.RTCIceCandidate(signal.candidate);
        if (connection && remoteDescriptionSet) {
          try { await connection.addIceCandidate(candidate); } catch (error) { if (!ignoreOffer) log('candidate-error', error); }
        } else {
          pendingCandidates.push(candidate);
        }
        return;
      }
      case 'end': {
        const reason = typeof signal.reason === 'string' ? signal.reason : 'ended';
        finish(endReasonStatus(reason, direction), { reason, message: endReasonMessage(reason, direction), notify: false });
        return;
      }
      case 'media':
        set({
          remoteVideoOff: signal.video === false,
          remoteMuted: signal.audio === false,
          remoteScreen: signal.screen === true,
          remoteAvatar: signal.avatar === true,
        });
        return;
      case 'video-request':
        if (state.mode === 'video') {
          // Already sending video; nothing to consent to, so answer straight away.
          sendSignal({ type: 'video-accept' });
          return;
        }
        if (state.videoRequest === 'outgoing') {
          // Both asked at once: treat theirs as acceptance of ours.
          sendSignal({ type: 'video-accept' });
          clearVideoRequest();
          await addVideo();
          return;
        }
        set({ videoRequest: 'incoming' });
        return;
      case 'video-accept':
        if (state.videoRequest !== 'outgoing') return;
        clearVideoRequest();
        await addVideo();
        return;
      case 'video-decline':
        if (state.videoRequest !== 'outgoing') return;
        clearVideoRequest({ error: 'Video was declined.' });
        return;
      case 'video-cancel':
        if (state.videoRequest === 'incoming') clearVideoRequest();
        return;
      case 'reaction':
        if (CALL_REACTIONS.includes(signal.emoji)) set({ remoteReaction: { emoji: signal.emoji, at: Date.now() } });
        return;
      default:
        return;
    }
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0 && !closed) {
        const { signal, done } = queue.shift();
        try {
          await handleSignal(signal);
        } catch (error) {
          log('signal-error', signal?.type, error);
        } finally {
          done?.();
        }
      }
    } finally {
      draining = false;
    }
  }

  const engine = {
    get state() { return { ...state }; },
    get connection() { return connection; },
    get closed() { return closed; },

    async start() {
      if (direction !== 'outgoing') throw new Error('Only outgoing calls start.');
      if (closed || state.status !== 'idle') return;
      set({ status: 'connecting' });
      try {
        const stream = await captureLocal(state.mode);
        await ensureConnection();
        addLocalTracks(stream);
        await negotiate();
      } catch (error) {
        if (!closed) finish('failed', { reason: 'failed', message: error.message || 'Could not start this call.', notify: offerSent });
      }
    },

    async accept() {
      if (direction !== 'incoming') throw new Error('Only incoming calls accept.');
      if (closed || state.status !== 'idle') return;
      set({ status: 'connecting' });
      try {
        const stream = await captureLocal(state.mode);
        await ensureConnection();
        addLocalTracks(stream);
        if (!remoteDescriptionSet) {
          const description = readDescription(offer);
          if (!description) throw new Error('The call offer is invalid.');
          await applyRemoteDescription(description);
        }
        armConnectTimeout();
        await connection.setLocalDescription(await connection.createAnswer());
        sendSignal(describeForPeer(connection.localDescription));
        set({ answered: true });
        if (peerConnected) markConnected();
      } catch (error) {
        if (!closed) finish('failed', { reason: 'failed', message: error.message || 'Could not accept this call.' });
      }
    },

    decline() {
      finish('ended', { reason: 'ended', message: '', notify: true });
    },

    hangUp(reason = 'ended') {
      finish('ended', { reason, message: '', notify: true });
    },

    // Delivered signals are processed strictly in order; `done` fires after each one
    // so the host can acknowledge or drop it from its own buffer.
    deliver(signal, { signalId, done } = {}) {
      if (closed) { done?.(); return; }
      if (signalId) {
        if (seenSignalIds.has(signalId)) { done?.(); return; }
        seenSignalIds.add(signalId);
      }
      queue.push({ signal, done });
      drain();
    },

    setMuted(muted) {
      state.localStream?.getAudioTracks().forEach((track) => { track.enabled = !muted; });
      set({ muted: Boolean(muted) });
      announceMedia();
    },

    // Turns the microphone's noise suppression on or off on the live track (no renegotiation).
    async setNoiseSuppression(enabled) {
      const track = state.localStream?.getAudioTracks()[0];
      if (closed || !track?.applyConstraints) return false;
      try {
        await track.applyConstraints({ ...track.getConstraints?.(), noiseSuppression: Boolean(enabled), echoCancellation: true });
      } catch {
        return false;
      }
      set({ noiseSuppression: Boolean(enabled) });
      return true;
    },

    // Whether the current camera has a controllable flash (usually only the back camera on phones).
    torchAvailable() {
      const track = cameraTrack();
      return Boolean(track?.getCapabilities?.()?.torch);
    },

    async setTorch(on) {
      const track = cameraTrack();
      if (closed || !track?.getCapabilities?.()?.torch) return false;
      try {
        await track.applyConstraints({ advanced: [{ torch: Boolean(on) }] });
      } catch {
        return false;
      }
      set({ torch: Boolean(on) });
      return true;
    },

    sendReaction(emoji) {
      if (closed || state.status !== 'connected' || !CALL_REACTIONS.includes(emoji)) return false;
      return sendSignal({ type: 'reaction', emoji });
    },

    setCameraOff(cameraOff) {
      state.localStream?.getVideoTracks().forEach((track) => { track.enabled = !cameraOff; });
      if (filterInput) filterInput.enabled = !cameraOff;
      set({ cameraOff: Boolean(cameraOff) });
      announceMedia();
    },

    // Routes the camera through a filter (camera track in, processed track out) for the peer and the self view.
    // `factory` returns `{ start(cameraTrack) → outputTrack, setInput(cameraTrack), stop() }`; `null` removes it.
    // The factory is remembered, so the filter survives camera flips, screen sharing and voice→video upgrades.
    async setVideoFilter(factory) {
      if (closed) return false;
      filterFactory = typeof factory === 'function' ? factory : null;
      if (!filterFactory) {
        if (filter) await removeFilter();
        return true;
      }
      if (filter || state.screenSharing || state.mode !== 'video') return Boolean(filter);
      return applyFilter(cameraTrack());
    },

    // Asks the peer before sending video; the camera starts only once they accept.
    requestVideo() {
      if (closed || state.mode === 'video' || state.videoRequest || state.status !== 'connected') return false;
      set({ videoRequest: 'outgoing', error: '' });
      sendSignal({ type: 'video-request' });
      timers.videoRequest = setTimer(() => {
        timers.videoRequest = null;
        if (state.videoRequest !== 'outgoing') return;
        sendSignal({ type: 'video-cancel' });
        clearVideoRequest({ error: 'No answer to the video request.' });
      }, VIDEO_REQUEST_TIMEOUT_MS);
      return true;
    },

    cancelVideoRequest() {
      if (state.videoRequest !== 'outgoing') return;
      sendSignal({ type: 'video-cancel' });
      clearVideoRequest();
    },

    clearError() {
      if (state.error && !TERMINAL_STATUSES.includes(state.status)) set({ error: '' });
    },

    async acceptVideo() {
      if (state.videoRequest !== 'incoming') return false;
      clearVideoRequest();
      sendSignal({ type: 'video-accept' });
      return addVideo();
    },

    declineVideo() {
      if (state.videoRequest !== 'incoming') return;
      sendSignal({ type: 'video-decline' });
      clearVideoRequest();
    },

    // Direct upgrade without consent; kept for the peer's side of the flow and for hosts that already have consent.
    upgradeToVideo() {
      return addVideo();
    },

    get canShareScreen() {
      return typeof getDisplayMedia === 'function';
    },

    // Shares the screen in place of the camera (or as the call's video when it was voice-only).
    // The browser's own "Stop sharing" control ends it too.
    async startScreenShare() {
      if (closed || state.screenSharing || !connection || !state.localStream || typeof getDisplayMedia !== 'function') return false;
      let stream;
      try {
        stream = await getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false });
      } catch (error) {
        if (error?.name !== 'NotAllowedError' && error?.name !== 'AbortError') set({ error: 'Screen sharing is not available here.' });
        return false;
      }
      const [track] = stream.getVideoTracks();
      if (!track) return false;
      if (closed) { track.stop(); return false; }
      modeBeforeShare = state.mode;
      screenTrack = track;
      const sender = videoSender ?? connection.getSenders().find((item) => item.track?.kind === 'video') ?? null;
      // The camera (and any filter on it) is released while the screen is shared; both come back when sharing stops.
      releaseFilter({ stopCamera: true });
      for (const old of state.localStream.getVideoTracks()) { old.stop(); state.localStream.removeTrack(old); }
      state.localStream.addTrack(track);
      try {
        if (sender) await sender.replaceTrack(track);
        else {
          videoSender = connection.addTrack(track, state.localStream);
          tuneSender(videoSender);
          if (connection.signalingState === 'stable') await negotiate();
        }
      } catch (error) {
        log('screen-share-failed', error);
        track.stop();
        state.localStream.removeTrack(track);
        screenTrack = null;
        set({ error: 'Could not start screen sharing.' });
        return false;
      }
      track.onended = () => { if (screenTrack === track) engine.stopScreenShare(); };
      set({ screenSharing: true, mode: 'video', cameraOff: false, error: '' });
      announceMedia();
      return true;
    },

    async stopScreenShare() {
      if (!screenTrack) return false;
      const track = screenTrack;
      screenTrack = null;
      track.onended = null;
      track.stop();
      state.localStream?.removeTrack(track);
      const sender = videoSender ?? connection?.getSenders().find((item) => item.track === track) ?? null;
      const restoreCamera = modeBeforeShare === 'video';
      modeBeforeShare = null;
      if (closed || !connection) { set({ screenSharing: false }); return true; }
      let camera = null;
      if (restoreCamera) {
        try {
          const stream = await getUserMedia({ video: videoConstraints(state.facing), audio: false });
          [camera] = stream.getVideoTracks();
        } catch (error) {
          log('camera-restore-failed', error);
        }
      }
      if (camera) {
        camera.enabled = !state.cameraOff;
        state.localStream.addTrack(camera);
      }
      try { await sender?.replaceTrack(camera); } catch (error) { log('screen-share-restore-failed', error); }
      set({ screenSharing: false, mode: camera ? 'video' : 'audio', cameraOff: camera ? state.cameraOff : false, error: camera || !restoreCamera ? state.error : 'Camera could not be reopened.' });
      announceMedia();
      if (camera && filterFactory) await applyFilter(camera);
      return true;
    },

    // Switches between cameras. Phones cannot open two cameras at once, so the live track is stopped first,
    // then each plan is tried in turn; if all fail the previous camera is reopened.
    async flipCamera() {
      if (closed || switchingCamera || !connection || !state.localStream) return false;
      const sender = connection.getSenders().find((item) => item.track?.kind === 'video');
      const current = cameraTrack();
      if (!sender || !current) return false;
      switchingCamera = true;
      if (state.torch) set({ torch: false });
      const previousFacing = state.facing;
      const nextFacing = previousFacing === 'user' ? 'environment' : 'user';
      const currentDeviceId = current.getSettings?.().deviceId ?? '';
      let devices = [];
      try { devices = await enumerateDevices(); } catch {}
      current.stop();
      state.localStream.removeTrack(current);
      if (filterInput === current) filterInput = null;
      const attempts = [
        ...cameraSwitchPlans({ facing: nextFacing, devices, currentDeviceId }).map((video) => ({ video, facing: nextFacing })),
        { video: videoConstraints(previousFacing), facing: previousFacing },
      ];
      try {
        for (const attempt of attempts) {
          let track = null;
          try {
            const stream = await getUserMedia({ video: attempt.video, audio: false });
            [track] = stream.getVideoTracks();
            if (!track) continue;
          } catch (error) {
            log('camera-switch-attempt-failed', attempt.facing, error?.name);
            continue;
          }
          if (closed) { track.stop(); return false; }
          track.enabled = !state.cameraOff;
          // With a filter running, the new camera simply becomes its input; the peer keeps the filter's track.
          if (filter) {
            try {
              await filter.setInput(track);
              filterInput = track;
            } catch (error) {
              track.stop();
              log('camera-switch-filter-failed', error);
              continue;
            }
          } else {
            try {
              await sender.replaceTrack(track);
            } catch (error) {
              track.stop();
              log('camera-switch-replace-failed', error);
              continue;
            }
            state.localStream.addTrack(track);
          }
          const switched = attempt.facing === nextFacing;
          set({ facing: attempt.facing, error: switched ? '' : 'Could not switch the camera.' });
          return switched;
        }
        set({ error: 'Could not switch the camera.' });
        return false;
      } finally {
        switchingCamera = false;
      }
    },

    // Host-driven disposal (unmount). No signal is sent when the call already finished.
    dispose() {
      if (closed) return;
      const active = !TERMINAL_STATUSES.includes(state.status) && state.status !== 'idle';
      finish('ended', { reason: 'ended', message: '', notify: active });
    },
  };

  return engine;
}
