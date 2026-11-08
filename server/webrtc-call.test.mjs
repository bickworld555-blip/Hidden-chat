// Real WebRTC peer connections (via @roamhq/wrtc) negotiated through the real signaling server.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createChatServer } from './index.mjs';
import { createCallEngine, cameraSwitchPlans, CONNECT_TIMEOUT_MS, RECONNECT_GRACE_MS } from '../src/callEngine.js';
import { getStatusLabel } from '../src/callStatus.js';
import { normalizeIceServers, orderCodecs, readDescription, tuneOpusSdp, turnServerFromEnv } from '../src/rtc.js';

const wrtc = createRequire(import.meta.url)('@roamhq/wrtc');
// libwebrtc worker threads keep the process alive and crash on natural exit; leave explicitly.
process.once('beforeExit', () => process.exit(process.exitCode ?? 0));

let service;
let directory;
let baseUrl;
let counter = 0;
const openEngines = new Set();
const openSockets = new Set();
const openTracks = new Set();

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-webrtc-'));
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'webrtc.sqlite') });
  const address = await service.listen();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  for (const engine of openEngines) engine.dispose();
  for (const track of openTracks) track.stop();
  for (const socket of openSockets) socket.close();
  await service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function register(prefix) {
  counter += 1;
  const response = await fetch(`${baseUrl}/api/v1/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: `${prefix}${counter}`, dob: '1990-04-12', password: 'Correct-Horse-Battery-42!' }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

async function link(a, b) {
  const response = await fetch(`${baseUrl}/api/v1/contacts`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + a.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: b.user.id }),
  });
  assert.ok(response.ok, `link failed: ${response.status}`);
}

function connectSocket(session) {
  const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/ws', [`relay.auth.${session.token}`, 'relay.v1']);
  socket.events = [];
  socket.on('message', (raw) => socket.events.push(JSON.parse(raw.toString())));
  openSockets.add(socket);
  return new Promise((resolve, reject) => { socket.once('open', () => resolve(socket)); socket.once('error', reject); });
}

function fakeMedia({ video = true } = {}) {
  return async (constraints) => {
    const tracks = [];
    if (constraints.audio) tracks.push(new wrtc.nonstandard.RTCAudioSource().createTrack());
    if (constraints.video && video) tracks.push(new wrtc.nonstandard.RTCVideoSource().createTrack());
    for (const track of tracks) openTracks.add(track);
    return new wrtc.MediaStream(tracks);
  };
}

function until(check, { timeout = 10_000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    (function poll() {
      const value = check();
      if (value) return resolve(value);
      if (Date.now() > deadline) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(poll, 20);
    })();
  });
}

// A "device": one websocket plus one engine wired exactly like CallOverlay wires them.
async function device(session, peerId, { callId, direction, mode, offer, getUserMedia, socket, log = () => {} }) {
  const ws = socket || await connectSocket(session);
  const snapshots = [];
  const sent = [];
  const engine = createCallEngine({
    callId,
    direction,
    mode,
    offer,
    rtc: wrtc,
    getUserMedia: getUserMedia || fakeMedia(),
    fetchIceServers: async () => (await (await fetch(`${baseUrl}/api/v1/rtc-config`, { headers: { Authorization: 'Bearer ' + session.token } })).json()).iceServers,
    send: (payload) => {
      sent.push(payload.signal);
      ws.send(JSON.stringify({ ...payload, targetId: peerId, signalId: `${callId}-${session.user.username}-${snapshots.length}-${Math.random()}` }));
      return true;
    },
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    log,
  });
  openEngines.add(engine);
  ws.on('message', (raw) => {
    const event = JSON.parse(raw.toString());
    if (event.type === 'call:signal' && event.callId === callId && event.signal.type !== 'offer') engine.deliver(event.signal, { signalId: event.signalId });
    // The initial offer is delivered through the engine's `offer` input (how App.jsx hands it over);
    // offers after that are renegotiations.
    if (event.type === 'call:signal' && event.callId === callId && event.signal.type === 'offer' && direction === 'incoming' && engine.state.status !== 'idle') {
      engine.deliver(event.signal, { signalId: event.signalId });
    }
  });
  return { ws, engine, snapshots, sent, statuses: () => snapshots.map((snapshot) => snapshot.status) };
}

async function waitForOffer(socket, callId) {
  return until(() => socket.events.find((event) => event.type === 'call:signal' && event.callId === callId && event.signal.type === 'offer'), { label: 'offer' });
}

function remoteKinds(engine) {
  return engine.state.remoteStream?.getTracks().map((track) => track.kind).sort() ?? [];
}

async function fullCall(mode, { callerMedia, calleeMedia, delayAcceptMs = 0 } = {}) {
  const alice = await register('alice');
  const bob = await register('bob');
  await link(alice, bob);
  const callId = `call-${counter}`;
  const caller = await device(alice, bob.user.id, { callId, direction: 'outgoing', mode, getUserMedia: callerMedia });
  const bobSocket = await connectSocket(bob);
  await caller.engine.start();
  const offerEvent = await waitForOffer(bobSocket, callId);
  await until(() => caller.engine.state.status === 'ringing', { label: 'ringing' });
  if (delayAcceptMs) await new Promise((resolve) => setTimeout(resolve, delayAcceptMs));
  const callee = await device(bob, alice.user.id, { callId, direction: 'incoming', mode, offer: offerEvent.signal, socket: bobSocket, getUserMedia: calleeMedia });
  // Candidates that arrived before acceptance must be replayed from the socket buffer, like App.jsx does.
  for (const event of bobSocket.events) {
    if (event.type === 'call:signal' && event.callId === callId && event.signal.type !== 'offer') callee.engine.deliver(event.signal, { signalId: event.signalId });
  }
  return { alice, bob, callId, caller, callee, cleanup() { caller.ws.close(); callee.ws.close(); } };
}

test('video call connects end to end through the server and both sides receive audio and video', async () => {
  const { caller, callee, cleanup } = await fullCall('video', { delayAcceptMs: 300 });
  try {
    await callee.engine.accept();
    await until(() => caller.engine.state.status === 'connected' && callee.engine.state.status === 'connected', { label: 'both connected' });
    await until(() => remoteKinds(caller.engine).length === 2 && remoteKinds(callee.engine).length === 2, { label: 'remote tracks' });
    assert.deepEqual(remoteKinds(caller.engine), ['audio', 'video']);
    assert.deepEqual(remoteKinds(callee.engine), ['audio', 'video']);
    const callerPath = caller.statuses().filter((status, index, list) => list[index - 1] !== status);
    assert.deepEqual(callerPath.slice(0, 2), ['connecting', 'ringing']);
    assert.equal(callerPath.at(-1), 'connected');
    assert.ok(callerPath.every((status) => ['connecting', 'ringing', 'connected'].includes(status)), callerPath.join(' > '));
    assert.deepEqual(callee.statuses().filter((status, index, list) => list[index - 1] !== status), ['connecting', 'connected']);
    // Each side told the other the moment its transport came up, and both clocks started within the same instant.
    assert.equal(caller.sent.filter((signal) => signal.type === 'connected').length, 1);
    assert.equal(callee.sent.filter((signal) => signal.type === 'connected').length, 1);
    assert.ok(Math.abs(caller.engine.state.connectedAt - callee.engine.state.connectedAt) < 1500, 'timers start together');
    assert.equal(caller.engine.state.answered, true);
    assert.equal(callee.engine.state.answered, true);

    const callerLocal = caller.engine.state.localStream.getTracks();
    const calleeRemote = callee.engine.state.remoteStream;
    caller.engine.hangUp();
    assert.equal(caller.engine.state.status, 'ended');
    assert.equal(caller.engine.closed, true);
    assert.ok(callerLocal.every((track) => track.readyState === 'ended'), 'caller camera and microphone are released');
    await until(() => callee.engine.state.status === 'ended', { label: 'callee ended' });
    assert.equal(callee.engine.state.error, 'Call ended.');
    assert.equal(callee.engine.connection, null);
    assert.ok(calleeRemote.getTracks().every((track) => track.readyState === 'ended'));
  } finally {
    cleanup();
  }
});

test('video frames continue in both directions after connection and camera replacement', async () => {
  const sources = [];
  const media = async (constraints) => {
    const tracks = [];
    if (constraints.audio) tracks.push(new wrtc.nonstandard.RTCAudioSource().createTrack());
    if (constraints.video) {
      const source = new wrtc.nonstandard.RTCVideoSource();
      sources.push(source);
      tracks.push(source.createTrack());
    }
    tracks.forEach((track) => openTracks.add(track));
    return new wrtc.MediaStream(tracks);
  };
  const { caller, callee, cleanup } = await fullCall('video', { callerMedia: media, calleeMedia: media });
  let timer;
  const sinks = [];
  try {
    await callee.engine.accept();
    await until(() => caller.engine.state.status === 'connected' && callee.engine.state.status === 'connected', { label: 'connected' });
    await until(() => remoteKinds(caller.engine).includes('video') && remoteKinds(callee.engine).includes('video'), { label: 'remote videos' });
    const frames = [0, 0];
    for (const [index, engine] of [caller.engine, callee.engine].entries()) {
      const sink = new wrtc.nonstandard.RTCVideoSink(engine.state.remoteStream.getVideoTracks()[0]);
      sink.onframe = () => { frames[index] += 1; };
      sinks.push(sink);
    }
    const frame = { width: 64, height: 48, data: new Uint8ClampedArray(64 * 48 * 3 / 2) };
    timer = setInterval(() => sources.forEach((source) => source.onFrame(frame)), 50);
    await until(() => frames.every((count) => count >= 5), { label: 'initial video frames' });
    const before = [...frames];
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.ok(frames.every((count, index) => count > before[index] + 3), `frames stopped: ${before} -> ${frames}`);
    assert.equal(await caller.engine.flipCamera(), true);
    const afterSwitch = frames[1];
    await until(() => frames[1] >= afterSwitch + 5, { label: 'frames after camera switch' });
  } finally {
    clearInterval(timer);
    sinks.forEach((sink) => sink.stop());
    caller.engine.hangUp();
    callee.engine.dispose();
    cleanup();
  }
});

test('voice call connects and upgrades to video with a renegotiated video track for the peer', async () => {
  const { caller, callee, cleanup } = await fullCall('audio');
  try {
    await callee.engine.accept();
    await until(() => caller.engine.state.status === 'connected' && callee.engine.state.status === 'connected', { label: 'connected' });
    assert.deepEqual(remoteKinds(callee.engine), ['audio']);
    assert.equal(await caller.engine.upgradeToVideo(), true);
    assert.equal(caller.engine.state.mode, 'video');
    await until(() => remoteKinds(callee.engine).length === 2 && callee.engine.state.mode === 'video', { label: 'video arrives' });
    assert.deepEqual(remoteKinds(callee.engine), ['audio', 'video']);
    assert.equal(callee.engine.state.status, 'connected');
    assert.equal(callee.engine.state.mode, 'video', 'unrequested video still opens the video layout');
    assert.equal(callee.engine.state.remoteHasVideo, true);

    // Muting or covering the camera is announced, so the peer's tile reflects it independently of its own stream.
    caller.engine.setMuted(true);
    assert.equal(caller.engine.state.localStream.getAudioTracks()[0].enabled, false);
    caller.engine.setCameraOff(true);
    assert.equal(caller.engine.state.localStream.getVideoTracks()[0].enabled, false);
    await until(() => callee.engine.state.remoteVideoOff && callee.engine.state.remoteMuted, { label: 'media state announced' });
    assert.equal(callee.engine.state.cameraOff, false, 'the peer’s own camera state is untouched');
    assert.equal(callee.engine.state.remoteStream.getVideoTracks().length, 1, 'the remote stream is kept, only flagged');
    caller.engine.setCameraOff(false);
    await until(() => !callee.engine.state.remoteVideoOff, { label: 'camera back on' });
  } finally {
    caller.engine.hangUp();
    callee.engine.dispose();
    cleanup();
  }
});

test('switching to video asks the peer first; accepting turns both cameras on, declining leaves the voice call intact', async () => {
  const { caller, callee, cleanup } = await fullCall('audio');
  try {
    await callee.engine.accept();
    await until(() => caller.engine.state.status === 'connected' && callee.engine.state.status === 'connected', { label: 'connected' });

    assert.equal(caller.engine.requestVideo(), true);
    assert.equal(caller.engine.state.videoRequest, 'outgoing');
    assert.equal(caller.engine.state.localStream.getVideoTracks().length, 0, 'no camera before consent');
    await until(() => callee.engine.state.videoRequest === 'incoming', { label: 'prompt on peer' });
    callee.engine.declineVideo();
    await until(() => caller.engine.state.videoRequest === null, { label: 'declined' });
    assert.equal(caller.engine.state.error, 'Video was declined.');
    assert.equal(caller.engine.state.mode, 'audio');
    assert.equal(callee.engine.state.mode, 'audio');

    assert.equal(caller.engine.requestVideo(), true);
    await until(() => callee.engine.state.videoRequest === 'incoming', { label: 'second prompt' });
    assert.equal(await callee.engine.acceptVideo(), true);
    await until(() => caller.engine.state.mode === 'video' && callee.engine.state.mode === 'video', { label: 'both video' });
    await until(() => remoteKinds(caller.engine).length === 2 && remoteKinds(callee.engine).length === 2, { label: 'video both ways' });
    assert.equal(caller.engine.state.videoRequest, null);
    assert.equal(callee.engine.state.videoRequest, null);
    assert.equal(caller.engine.state.status, 'connected');
    assert.equal(callee.engine.state.status, 'connected');
    assert.equal(caller.engine.connection.signalingState, 'stable');
    assert.equal(callee.engine.connection.signalingState, 'stable');
  } finally {
    caller.engine.hangUp();
    callee.engine.dispose();
    cleanup();
  }
});

test('declining an incoming call ends it for the caller without capturing media', async () => {
  const { caller, callee, cleanup } = await fullCall('video');
  try {
    callee.engine.decline();
    assert.equal(callee.engine.state.localStream, null);
    await until(() => caller.engine.state.status === 'ended', { label: 'caller ended' });
    assert.equal(caller.engine.state.localStream, null);
  } finally {
    cleanup();
  }
});

test('a callee whose camera is unavailable fails cleanly and the caller learns why', async () => {
  const blockedMedia = async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); };
  const { caller, callee, cleanup } = await fullCall('video', { calleeMedia: blockedMedia });
  try {
    await callee.engine.accept();
    assert.equal(callee.engine.state.status, 'failed');
    assert.equal(callee.engine.state.error, 'Allow microphone and camera access in browser settings.');
    await until(() => caller.engine.state.status === 'failed', { label: 'caller failed' });
    assert.equal(caller.engine.state.error, 'Could not connect this call.');
    assert.equal(caller.engine.connection, null);
  } finally {
    cleanup();
  }
});

test('a caller without media access never signals the peer', async () => {
  const alice = await register('alice');
  const bob = await register('bob');
  await link(alice, bob);
  const bobSocket = await connectSocket(bob);
  const caller = await device(alice, bob.user.id, { callId: `nomedia-${counter}`, direction: 'outgoing', mode: 'audio', getUserMedia: async () => { throw Object.assign(new Error('busy'), { name: 'NotReadableError' }); } });
  await caller.engine.start();
  assert.equal(caller.engine.state.status, 'failed');
  assert.equal(caller.engine.state.error, 'The microphone or camera is in use by another app.');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(bobSocket.events.filter((event) => event.type === 'call:signal').length, 0);
  caller.ws.close();
  bobSocket.close();
});

test('answering on one device stops the others and pins later negotiation to that device', async () => {
  const alice = await register('alice');
  const bob = await register('bob');
  await link(alice, bob);
  const callId = `multi-${counter}`;
  const caller = await device(alice, bob.user.id, { callId, direction: 'outgoing', mode: 'audio' });
  const phone = await connectSocket(bob);
  const laptop = await connectSocket(bob);
  await caller.engine.start();
  const [phoneOffer, laptopOffer] = await Promise.all([waitForOffer(phone, callId), waitForOffer(laptop, callId)]);
  assert.equal(phoneOffer.signalId, laptopOffer.signalId);

  const answering = await device(bob, alice.user.id, { callId, direction: 'incoming', mode: 'audio', offer: phoneOffer.signal, socket: phone });
  for (const event of phone.events) if (event.type === 'call:signal' && event.callId === callId && event.signal.type === 'ice') answering.engine.deliver(event.signal, { signalId: event.signalId });
  const laptopCountBefore = laptop.events.length;
  await answering.engine.accept();
  const elsewhere = await until(() => laptop.events.find((event) => event.signal?.type === 'end' && event.signal.reason === 'answered-elsewhere'), { label: 'answered elsewhere' });
  assert.equal(elsewhere.callId, callId);
  await until(() => caller.engine.state.status === 'connected' && answering.engine.state.status === 'connected', { label: 'connected' });

  // Renegotiation from the caller after the answer reaches only the answering device.
  await caller.engine.upgradeToVideo();
  await until(() => remoteKinds(answering.engine).length === 2, { label: 'video on phone' });
  const laptopAfter = laptop.events.slice(laptopCountBefore).filter((event) => event.type === 'call:signal' && event.callId === callId);
  assert.deepEqual(laptopAfter.map((event) => event.signal.type), ['end']);

  caller.engine.hangUp();
  await until(() => answering.engine.state.status === 'ended', { label: 'ended' });
  assert.ok(laptop.events.some((event) => event.signal?.type === 'end' && event.signal.reason === 'ended'), 'hang-up reaches every device');
  caller.ws.close(); phone.close(); laptop.close();
});

test('duplicate and out-of-order signals are tolerated', async () => {
  const { caller, callee, cleanup, callId } = await fullCall('audio');
  try {
    // Replay the caller's ICE candidates twice before accepting; duplicates are dropped by signalId.
    const ice = callee.ws.events.filter((event) => event.callId === callId && event.signal.type === 'ice');
    for (const event of [...ice, ...ice]) callee.engine.deliver(event.signal, { signalId: event.signalId });
    await callee.engine.accept();
    await until(() => caller.engine.state.status === 'connected' && callee.engine.state.status === 'connected', { label: 'connected' });
    // A stale answer after connection is ignored instead of breaking the session.
    caller.engine.deliver({ type: 'answer', sdp: caller.engine.connection.remoteDescription.sdp });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(caller.engine.state.status, 'connected');
    assert.equal(caller.engine.connection.signalingState, 'stable');
  } finally {
    caller.engine.hangUp();
    cleanup();
  }
});

// --- Timer-driven recovery with a controllable clock and a scripted peer connection -------------

function fakeRtc() {
  const connections = [];
  class FakeConnection {
    constructor() {
      this.signalingState = 'stable';
      this.connectionState = 'new';
      this.iceConnectionState = 'new';
      this.localDescription = null;
      this.remoteDescription = null;
      this.senders = [];
      this.closed = false;
      this.restarts = 0;
      connections.push(this);
    }
    addTrack(track, stream) { const sender = { track, stream, getParameters: () => ({ encodings: [{}] }), setParameters: async () => {}, async replaceTrack(next) { if (next?.id?.includes('reject')) throw new Error('replace rejected'); this.track = next; } }; this.senders.push(sender); return sender; }
    getSenders() { return this.senders; }
    getTransceivers() { return []; }
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\nfake-offer' }; }
    async createAnswer() { return { type: 'answer', sdp: 'v=0\r\nfake-answer' }; }
    async setLocalDescription(description) {
      this.localDescription = description;
      this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable';
    }
    async setRemoteDescription(description) {
      this.remoteDescription = description;
      this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
    }
    async addIceCandidate() {}
    restartIce() { this.restarts += 1; }
    close() { this.closed = true; this.connectionState = 'closed'; }
    transition(state) { this.connectionState = state; this.onconnectionstatechange?.(); }
  }
  class FakeCandidate { constructor(init) { Object.assign(this, init); } }
  class FakeStream {
    constructor(tracks = []) { this.tracks = tracks; }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter((track) => track.kind === 'audio'); }
    getVideoTracks() { return this.tracks.filter((track) => track.kind === 'video'); }
    addTrack(track) { this.tracks.push(track); }
    removeTrack(track) { this.tracks = this.tracks.filter((item) => item !== track); }
  }
  const fakeTrack = (kind, deviceId = `${kind}-device`) => ({ kind, id: `${kind}-${Math.random()}`, enabled: true, readyState: 'live', getSettings: () => ({ deviceId }), stop() { this.readyState = 'ended'; } });
  return {
    connections,
    fakeTrack,
    rtc: { RTCPeerConnection: FakeConnection, RTCIceCandidate: FakeCandidate, MediaStream: FakeStream },
    getUserMedia: async (constraints) => new FakeStream([fakeTrack('audio'), ...(constraints.video ? [fakeTrack('video')] : [])]),
  };
}

async function connectedVideoCall({ getUserMedia, enumerateDevices, send = () => true }) {
  const fake = fakeRtc();
  const engine = createCallEngine({ callId: 'cam', direction: 'outgoing', mode: 'video', rtc: fake.rtc, getUserMedia: getUserMedia(fake), enumerateDevices, send });
  await engine.start();
  engine.deliver({ type: 'answer', sdp: 'v=0\r\nfake-answer' });
  await until(() => engine.state.answered, { label: 'answered' });
  fake.connections[0].transition('connected');
  return { engine, fake };
}

test('camera switching stops the live camera first, prefers the other device id, and falls back through facing modes', async () => {
  const calls = [];
  let firstTrack = null;
  const { engine, fake } = await connectedVideoCall({
    enumerateDevices: async () => [
      { kind: 'videoinput', deviceId: 'front-1', label: 'Front Camera' },
      { kind: 'videoinput', deviceId: 'back-1', label: 'Back Camera' },
      { kind: 'audioinput', deviceId: 'mic', label: 'Mic' },
    ],
    getUserMedia: ({ fakeTrack, rtc }) => async (constraints) => {
      if (constraints.audio) { firstTrack = fakeTrack('video', 'front-1'); return new rtc.MediaStream([fakeTrack('audio'), firstTrack]); }
      calls.push({ video: constraints.video, previousEnded: firstTrack.readyState === 'ended' });
      if (constraints.video.deviceId?.exact === 'back-1') throw Object.assign(new Error('busy'), { name: 'NotReadableError' });
      if (constraints.video.facingMode?.exact) throw Object.assign(new Error('no exact'), { name: 'OverconstrainedError' });
      return new rtc.MediaStream([fakeTrack('video', 'back-1')]);
    },
  });
  engine.setCameraOff(true);
  assert.equal(await engine.flipCamera(), true);
  assert.equal(engine.state.facing, 'environment');
  assert.equal(engine.state.error, '');
  assert.ok(calls.every((call) => call.previousEnded), 'the front camera is released before any new capture');
  assert.deepEqual(calls.map((call) => call.video.deviceId?.exact ?? call.video.facingMode), ['back-1', { exact: 'environment' }, 'environment']);
  const sender = fake.connections[0].getSenders().find((item) => item.track.kind === 'video');
  const live = engine.state.localStream.getVideoTracks();
  assert.equal(live.length, 1);
  assert.equal(sender.track, live[0], 'the peer receives the new camera');
  assert.equal(live[0].enabled, false, 'camera-off is preserved across the switch');
  assert.equal(firstTrack.readyState, 'ended');

  assert.equal(await engine.flipCamera(), true, 'switching back works too');
  assert.equal(engine.state.facing, 'user');
});

test('when no other camera can be opened the previous one is restored instead of leaving the call blind', async () => {
  let opened = 0;
  const { engine } = await connectedVideoCall({
    enumerateDevices: async () => { throw new Error('no permission for labels'); },
    getUserMedia: ({ fakeTrack, rtc }) => async (constraints) => {
      if (constraints.audio) return new rtc.MediaStream([fakeTrack('audio'), fakeTrack('video', 'front')]);
      opened += 1;
      if (constraints.video.facingMode === 'user') return new rtc.MediaStream([fakeTrack('video', 'front')]);
      throw Object.assign(new Error('nope'), { name: 'NotFoundError' });
    },
  });
  assert.equal(await engine.flipCamera(), false);
  assert.equal(engine.state.facing, 'user');
  assert.equal(engine.state.error, 'Could not switch the camera.');
  assert.equal(engine.state.localStream.getVideoTracks().length, 1, 'the front camera is live again');
  assert.equal(engine.state.localStream.getVideoTracks()[0].readyState, 'live');
  assert.equal(opened, 3, 'exact environment, loose environment, then the previous camera');
});

test('camera switch plans put a different device id first and never repeat a device', () => {
  const devices = [
    { kind: 'videoinput', deviceId: 'a', label: 'Integrated Camera' },
    { kind: 'videoinput', deviceId: 'b', label: 'USB Rear Camera' },
    { kind: 'audioinput', deviceId: 'm', label: 'Mic' },
  ];
  const plans = cameraSwitchPlans({ facing: 'environment', devices, currentDeviceId: 'a' });
  assert.deepEqual(plans.map((plan) => plan.deviceId?.exact ?? plan.facingMode), ['b', { exact: 'environment' }, 'environment']);
  assert.ok(plans.slice(0, 1).every((plan) => plan.facingMode === undefined), 'device id plans do not also pin facingMode');
  assert.deepEqual(cameraSwitchPlans({ facing: 'user', devices: [], currentDeviceId: '' }).map((plan) => plan.facingMode), [{ exact: 'user' }, 'user']);
});

function fakeClock() {
  let now = 0;
  const timers = new Map();
  let nextId = 1;
  return {
    setTimer(fn, ms) { const id = nextId++; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimer(id) { timers.delete(id); },
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) { timers.delete(id); timer.fn(); await Promise.resolve(); }
      }
    },
    get pending() { return timers.size; },
  };
}

test('a call that never connects after the answer fails with guidance instead of hanging', async () => {
  const { rtc, getUserMedia, connections } = fakeRtc();
  const clock = fakeClock();
  const sent = [];
  const engine = createCallEngine({ callId: 'c1', direction: 'outgoing', mode: 'video', rtc, getUserMedia, send: (payload) => { sent.push(payload.signal); return true; }, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  await engine.start();
  assert.equal(sent[0].type, 'offer');
  assert.equal(clock.pending, 0, 'ringing has no client-side deadline');
  await clock.advance(CONNECT_TIMEOUT_MS * 2);
  assert.equal(engine.state.status, 'connecting');

  engine.deliver({ type: 'answer', sdp: 'v=0\r\nfake-answer' });
  await until(() => clock.pending === 1, { label: 'connect timer armed' });
  await clock.advance(CONNECT_TIMEOUT_MS - 1);
  assert.equal(engine.state.status, 'connecting');
  await clock.advance(1);
  assert.equal(engine.state.status, 'failed');
  assert.match(engine.state.error, /TURN server/);
  assert.deepEqual(sent.at(-1), { type: 'end', reason: 'failed' });
  assert.equal(connections[0].closed, true);
  assert.ok(engine.state.localStream === null);
});

test('a brief disconnect reconnects silently; a long one ends the call once', async () => {
  const { rtc, getUserMedia, connections } = fakeRtc();
  const clock = fakeClock();
  const sent = [];
  const engine = createCallEngine({ callId: 'c2', direction: 'outgoing', mode: 'audio', rtc, getUserMedia, send: (payload) => { sent.push(payload.signal); return true; }, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  await engine.start();
  engine.deliver({ type: 'answer', sdp: 'v=0\r\nfake-answer' });
  await until(() => clock.pending === 1, { label: 'armed' });
  const pc = connections[0];
  pc.transition('connected');
  assert.equal(engine.state.status, 'connected');
  assert.equal(clock.pending, 0);

  pc.transition('disconnected');
  assert.equal(engine.state.status, 'reconnecting');
  await clock.advance(RECONNECT_GRACE_MS - 1);
  pc.transition('connected');
  assert.equal(engine.state.status, 'connected');
  await clock.advance(RECONNECT_GRACE_MS * 2);
  assert.equal(engine.state.status, 'connected', 'the cancelled grace timer must not end a recovered call');
  assert.equal(pc.restarts, 1, 'the caller tried one ICE restart during the outage');

  pc.transition('disconnected');
  await clock.advance(RECONNECT_GRACE_MS);
  assert.equal(engine.state.status, 'ended');
  assert.equal(engine.state.error, 'The call disconnected.');
  assert.equal(sent.filter((signal) => signal.type === 'end').length, 1);
  engine.hangUp();
  engine.dispose();
  assert.equal(sent.filter((signal) => signal.type === 'end').length, 1, 'ending twice sends nothing new');
});

test('the peer reporting connected flips this side to the live timer without waiting for its own transport event', async () => {
  const { rtc, getUserMedia, connections } = fakeRtc();
  const clock = fakeClock();
  const sent = [];
  const engine = createCallEngine({ callId: 'c4', direction: 'outgoing', mode: 'audio', rtc, getUserMedia, send: (payload) => { sent.push(payload.signal); return true; }, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  await engine.start();
  engine.deliver({ type: 'ringing' });
  await until(() => engine.state.status === 'ringing', { label: 'ringing' });
  // A stray "connected" before the answer is remembered but cannot fake a connection.
  engine.deliver({ type: 'connected' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(engine.state.status, 'ringing');
  assert.equal(engine.state.answered, false);

  engine.deliver({ type: 'answer', sdp: 'v=0\r\nfake-answer' });
  await until(() => engine.state.status === 'connected', { label: 'connected via peer' });
  assert.equal(engine.state.answered, true);
  assert.ok(engine.state.connectedAt > 0);
  assert.equal(clock.pending, 0, 'the connect deadline is cleared');
  assert.equal(sent.filter((signal) => signal.type === 'connected').length, 0, 'a peer-triggered flip is not echoed');

  // Our own transport catching up announces once; a later real failure still ends the call honestly.
  const pc = connections[0];
  pc.transition('connected');
  assert.equal(sent.filter((signal) => signal.type === 'connected').length, 1);
  for (let attempt = 0; attempt < 3; attempt += 1) { pc.transition('failed'); await clock.advance(2_000); }
  assert.equal(engine.state.status, 'failed');
});

test('a late ringing signal never regresses an answered call and labels follow the answer', async () => {
  const { rtc, getUserMedia } = fakeRtc();
  const clock = fakeClock();
  const engine = createCallEngine({ callId: 'c5', direction: 'outgoing', mode: 'video', rtc, getUserMedia, send: () => true, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  await engine.start();
  engine.deliver({ type: 'answer', sdp: 'v=0\r\nfake-answer' });
  await until(() => engine.state.answered, { label: 'answered' });
  engine.deliver({ type: 'ringing' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(engine.state.status, 'connecting');
  const outgoing = (status, answered, isOnline = true) => getStatusLabel({ status, direction: 'outgoing', mode: 'video', isOnline, answered, elapsed: 0 });
  assert.equal(outgoing('connecting', false), 'Calling…');
  assert.equal(outgoing('connecting', false, false), 'Calling');
  assert.equal(outgoing('ringing', false), 'Ringing…');
  assert.equal(outgoing('connecting', true), 'Connecting…', 'after the answer the caller never reads as still calling');
  assert.equal(outgoing('connected', true), '0:00');
  assert.equal(getStatusLabel({ status: 'connected', direction: 'incoming', mode: 'audio', answered: true, elapsed: 3725 }), '1:02:05');
  assert.equal(getStatusLabel({ status: 'idle', direction: 'incoming', mode: 'audio', answered: false, elapsed: 0 }), 'Incoming voice call');
  assert.equal(getStatusLabel({ status: 'connecting', direction: 'incoming', mode: 'audio', answered: true, elapsed: 0 }), 'Connecting…');
});

test('repeated failures give up after the ICE restart budget', async () => {
  const { rtc, getUserMedia, connections } = fakeRtc();
  const clock = fakeClock();
  const engine = createCallEngine({ callId: 'c3', direction: 'outgoing', mode: 'audio', rtc, getUserMedia, send: () => true, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  await engine.start();
  engine.deliver({ type: 'answer', sdp: 'v=0\r\nfake-answer' });
  await until(() => clock.pending === 1, { label: 'armed' });
  const pc = connections[0];
  pc.transition('connected');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    pc.transition('failed');
    assert.equal(engine.state.status, 'reconnecting');
    await clock.advance(2_000);
  }
  assert.equal(pc.restarts, 2);
  pc.transition('failed');
  assert.equal(engine.state.status, 'failed');
});

// --- Shared RTC policy --------------------------------------------------------------------------

test('ICE server normalization keeps multi-port TURN with credentials and drops unusable entries', () => {
  const turn = turnServerFromEnv({ url: 'turn:relay.example:3478?transport=udp, turn:relay.example:3478?transport=tcp,turns:relay.example:443?transport=tcp', username: 'u', credential: 'p' });
  assert.deepEqual(normalizeIceServers([
    { urls: 'stun:stun.example:3478' },
    turn,
    { urls: 'turn:anonymous.example:3478' },
    { urls: ['stun:stun.example:3478', 'http://not-ice'] },
    { urls: 'turns:second.example:443?transport=tcp', username: 'x', credential: '' },
    null,
  ]), [
    { urls: 'stun:stun.example:3478' },
    { urls: ['turn:relay.example:3478?transport=udp', 'turn:relay.example:3478?transport=tcp', 'turns:relay.example:443?transport=tcp'], username: 'u', credential: 'p' },
  ]);
  assert.equal(turnServerFromEnv({ url: '' }), null);
});

test('rtc-config exposes the configured multi-port TURN relay to authenticated users', async () => {
  const user = await register('turnuser');
  const saved = { url: process.env.RELAY_TURN_URL, username: process.env.RELAY_TURN_USERNAME, credential: process.env.RELAY_TURN_CREDENTIAL };
  process.env.RELAY_TURN_URL = 'turn:relay.example:3478?transport=udp,turns:relay.example:443?transport=tcp';
  process.env.RELAY_TURN_USERNAME = 'relay-user';
  process.env.RELAY_TURN_CREDENTIAL = 'relay-secret';
  try {
    const response = await fetch(`${baseUrl}/api/v1/rtc-config`, { headers: { Authorization: 'Bearer ' + user.token } });
    assert.equal(response.status, 200);
    const { iceServers } = await response.json();
    assert.deepEqual(iceServers.at(-1), { urls: ['turn:relay.example:3478?transport=udp', 'turns:relay.example:443?transport=tcp'], username: 'relay-user', credential: 'relay-secret' });
  } finally {
    for (const [key, name] of [['url', 'RELAY_TURN_URL'], ['username', 'RELAY_TURN_USERNAME'], ['credential', 'RELAY_TURN_CREDENTIAL']]) {
      if (saved[key] === undefined) delete process.env[name]; else process.env[name] = saved[key];
    }
  }
});

test('codec ordering and Opus tuning are stable and idempotent', () => {
  const codecs = [{ mimeType: 'video/VP9' }, { mimeType: 'video/rtx' }, { mimeType: 'video/H264' }, { mimeType: 'video/VP8' }, { mimeType: 'video/AV1' }];
  assert.deepEqual(orderCodecs(codecs).map((codec) => codec.mimeType), ['video/VP8', 'video/H264', 'video/VP9', 'video/rtx', 'video/AV1']);
  const sdp = 'm=audio 9 UDP/TLS/RTP/SAVPF 111 63\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=0\r\na=rtpmap:63 red/48000/2\r\na=fmtp:63 111/111\r\n';
  const tuned = tuneOpusSdp(sdp);
  assert.ok(tuned.includes('a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1;maxaveragebitrate=48000'));
  assert.ok(tuned.includes('a=fmtp:63 111/111'), 'non-Opus fmtp lines are untouched');
  assert.equal(tuneOpusSdp(tuned), tuned);
  assert.deepEqual(readDescription({ type: 'offer', sdp: { type: 'offer', sdp: 'v=0' } }), { type: 'offer', sdp: 'v=0' });
  assert.equal(readDescription({ type: 'offer', sdp: '' }), null);
  assert.equal(readDescription({ type: 'rollback', sdp: 'v=0' }), null);
});

// --- UI wiring contracts ------------------------------------------------------------------------

test('the React overlay delegates all WebRTC work to the engine and no public relay is hardcoded', async () => {
  const { readFile } = await import('node:fs/promises');
  const read = async (path) => (await readFile(new URL(path, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const overlay = await read('../src/components/CallOverlay.jsx');
  const app = await read('../src/App.jsx');
  const engine = await read('../src/callEngine.js');

  assert.match(overlay, /import \{[^}]*\bcreateCallEngine\b[^}]*\} from '\.\.\/callEngine\.js'/);
  assert.doesNotMatch(overlay, /new RTCPeerConnection|createOffer|createAnswer|addIceCandidate|setRemoteDescription/);
  assert.doesNotMatch(overlay, /onLoadedMetadata/, 'playback is owned by one hook, not per-element handlers');
  assert.doesNotMatch(overlay + app + engine, /openrelay|metered\.ca/i);
  assert.ok(overlay.includes('AbortSignal.timeout(ICE_CONFIG_TIMEOUT_MS)'), 'a slow rtc-config fetch cannot delay the call');
  assert.ok(overlay.includes('disposeTimerRef.current = setTimeout('), 'StrictMode remounts reuse the engine');
  assert.ok(overlay.includes("useMediaElement(remoteAudioRef, remoteStream)"));
  assert.ok(overlay.includes("videoRequest === 'incoming'") && overlay.includes('Accept video') && overlay.includes('onClick={declineVideo}'), 'the peer is asked before video starts');
  assert.ok(overlay.includes("videoRequest === 'outgoing'") && overlay.includes('onClick={cancelVideoRequest}'), 'the requester can cancel while waiting');
  assert.ok(overlay.includes('const remoteVideoLive = Boolean(remoteStream) && remoteHasVideo && !remoteVideoOff'), 'the remote tile follows the peer’s own camera state');
  assert.doesNotMatch(overlay, /upgradeToVideo/, 'the UI never adds video without consent');
  assert.ok(overlay.includes('enumerateDevices: () => navigator.mediaDevices?.enumerateDevices?.()'), 'camera switching can pick a real device id');

  assert.ok(app.includes("signal: { type: 'end', reason: 'busy' }"), 'a second incoming offer is answered with busy');
  assert.ok(app.includes('if (active && !TERMINAL_STATUSES.includes(active.status))'), 'a call still on its ended screen never answers busy');
  assert.ok(app.includes('key={call.id}'), 'a replaced call mounts a fresh overlay');
  assert.ok(app.includes('if (active && (active.id === event.callId || (event.roomId && event.roomId === active.roomId))) setCallSignals'), 'stray signals are dropped instead of buffered forever');
  assert.doesNotMatch(app, /status: 'calling'|status: 'ringing'/);

  assert.ok(engine.includes("import {") && !/from 'react'/.test(engine), 'the engine is framework-free');
  assert.ok(engine.includes('ignoreOffer = !polite && collision'), 'perfect negotiation handles offer glare');
});

// --- Group calls: a full mesh of pair engines through the real server -----------------------------

import { MAX_CALL_PARTICIPANTS, PeerRegistry, canInvite, isRoomOffer, peersToConnect } from '../src/callRoom.js';

// A participant device: one socket, one engine per pair, auto-joining room offers like App.jsx does.
async function participant(session, roomId, mode = 'audio') {
  const ws = await connectSocket(session);
  const engines = new Map();
  const make = (peerId, callId, direction, offer) => {
    const engine = createCallEngine({
      callId, direction, mode, offer, rtc: wrtc, getUserMedia: fakeMedia(),
      fetchIceServers: async () => [],
      send: (payload) => { ws.send(JSON.stringify({ ...payload, targetId: peerId, roomId, signalId: crypto.randomUUID() })); return true; },
    });
    openEngines.add(engine);
    engines.set(callId, { engine, peerId });
    return engine;
  };
  ws.on('message', (raw) => {
    const event = JSON.parse(raw.toString());
    if (event.type !== 'call:signal') return;
    const known = engines.get(event.callId);
    if (known) { known.engine.deliver(event.signal, { signalId: event.signalId }); return; }
    if (isRoomOffer(event, { roomId })) make(event.from, event.callId, 'incoming', event.signal).accept();
  });
  return {
    ws, engines,
    call: (peerId) => { const engine = make(peerId, crypto.randomUUID(), 'outgoing', null); engine.start(); return engine; },
    connectedPeers: () => [...engines.values()].filter(({ engine }) => engine.state.status === 'connected').map(({ peerId }) => peerId).sort(),
    hangUpAll: () => { for (const { engine } of engines.values()) engine.hangUp(); },
  };
}

test('a contact invited into a call joins the mesh: every pair connects and each person hears the other two', async () => {
  const alice = await register('alice');
  const bob = await register('bob');
  const carol = await register('carol');
  await link(alice, bob);
  await link(alice, carol);
  const roomId = `room-${counter}`;
  const a = await participant(alice, roomId);
  const b = await participant(bob, roomId);
  const c = await participant(carol, roomId);

  a.call(bob.user.id);
  await until(() => a.connectedPeers().length === 1 && b.connectedPeers().length === 1, { label: 'first pair' });

  // Alice adds Carol; Carol's device receives the invite and calls everyone listed (Alice and Bob).
  a.ws.send(JSON.stringify({ type: 'call:invite', roomId, targetId: carol.user.id, mode: 'audio', participants: [alice.user.id, bob.user.id] }));
  const invite = await until(() => c.ws.events.find((event) => event.type === 'call:invite'), { label: 'invite' });
  assert.equal(invite.from, alice.user.id);
  assert.deepEqual([...invite.participants].sort(), [alice.user.id, bob.user.id].sort());
  const peers = peersToConnect([invite.from, ...invite.participants], carol.user.id);
  assert.deepEqual(peers.sort(), [alice.user.id, bob.user.id].sort());
  for (const peerId of peers) c.call(peerId);

  await until(() => c.connectedPeers().length === 2 && a.connectedPeers().length === 2 && b.connectedPeers().length === 2, { label: 'full mesh', timeout: 15_000 });
  assert.deepEqual(a.connectedPeers(), [bob.user.id, carol.user.id].sort());
  assert.deepEqual(b.connectedPeers(), [alice.user.id, carol.user.id].sort(), 'Bob and Carol were linked by the invite although they never added each other');
  for (const side of [a, b, c]) for (const { engine } of side.engines.values()) assert.deepEqual(remoteKinds(engine), ['audio']);

  // Carol leaves: her two pairs end for the others, Alice and Bob stay connected.
  c.hangUpAll();
  await until(() => a.connectedPeers().length === 1 && b.connectedPeers().length === 1, { label: 'carol left' });
  assert.deepEqual(a.connectedPeers(), [bob.user.id]);
  assert.equal([...a.engines.values()].find(({ peerId }) => peerId === carol.user.id).engine.state.status, 'ended');

  // A busy person declines through the reply channel; the server tells the inviter.
  a.ws.send(JSON.stringify({ type: 'call:invite-reply', roomId, targetId: bob.user.id, accepted: false, reason: 'busy' }));
  const reply = await until(() => b.ws.events.find((event) => event.type === 'call:invite-reply'), { label: 'reply' });
  assert.equal(reply.reason, 'busy');
  a.ws.send(JSON.stringify({ type: 'call:invite', roomId, targetId: carol.user.id, mode: 'audio', participants: [alice.user.id, bob.user.id, carol.user.id, 'x'] }));
  await until(() => a.ws.events.some((event) => event.type === 'error' && /full/.test(event.message)), { label: 'full room rejected' });
  a.hangUpAll(); b.hangUpAll();
  a.ws.close(); b.ws.close(); c.ws.close();
});

test('room helpers: invite capacity, room offers and the peer registry', () => {
  assert.equal(MAX_CALL_PARTICIPANTS, 4);
  assert.equal(canInvite(1), true);
  assert.equal(canInvite(2), true);
  assert.equal(canInvite(3), false, 'me plus three peers is full');
  assert.equal(isRoomOffer({ roomId: 'r', signal: { type: 'offer' } }, { roomId: 'r' }), true);
  assert.equal(isRoomOffer({ roomId: 'r', signal: { type: 'ice' } }, { roomId: 'r' }), false);
  assert.equal(isRoomOffer({ signal: { type: 'offer' } }, { roomId: 'r' }), false);
  assert.deepEqual(peersToConnect(['a', 'me', 'a', 'b', '', null], 'me'), ['a', 'b']);
  const registry = new PeerRegistry();
  const engine = { id: 1 };
  registry.add('p1', 'c1', engine);
  assert.equal(registry.forCall('c1').engine, engine);
  assert.equal(registry.forPeer('p1').callId, 'c1');
  registry.add('p1', 'c2', { id: 2 });
  assert.equal(registry.forCall('c1'), null, 're-adding a peer drops the old pair id');
  assert.equal(registry.size, 1);
  registry.remove('p1');
  assert.deepEqual(registry.peerIds, []);
});

test('the overlay restores from PiP on a tap, adds participants, and the chat header has the full menu', async () => {
  const { readFile } = await import('node:fs/promises');
  const read = async (path) => (await readFile(new URL(path, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const overlay = await read('../src/components/CallOverlay.jsx');
  const chatWindow = await read('../src/components/ChatWindow.jsx');
  const app = await read('../src/App.jsx');
  assert.ok(overlay.includes("onClick={minimized ? (event) => { const dragged = draggedRef.current; draggedRef.current = false; if (!dragged && !event.target.closest('button') && !dragRef.current) restoreCall(); } : undefined}"), 'tapping the floating window restores it, finishing a drag does not');
  assert.ok(overlay.includes("setRestoring(true)") && overlay.includes("restoring ? 'is-restoring'"), 'restore animates instead of snapping');
  assert.ok(overlay.includes('if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;'), 'a tap is not mistaken for a drag');
  assert.ok(overlay.includes('aria-label="Add participant"') && overlay.includes("type: 'call:invite'") && overlay.includes('<AddParticipantPicker'), 'the + button invites a contact');
  assert.ok(overlay.includes("addRoomPeer({ peerId: event.from, callId: event.callId, direction: 'incoming', offer: event.signal })") && overlay.includes('<ParticipantTile'), 'joining peers get their own engine and tile');
  assert.ok(overlay.includes('const toggleMute = () => allEngines().forEach'), 'mute applies to every pair');
  assert.ok(app.includes("event.type === 'call:invite'") && app.includes('isRoomOffer(event, active)'), 'invites ring and room offers join silently');
  for (const item of ['New group', 'New contact', "label: 'Search'", 'Media, links and docs', 'Mute notifications', 'Disappearing messages', 'Chat theme', "label: 'Pair a device'"]) {
    assert.ok(chatWindow.includes(item), `header menu has ${item}`);
  }
  assert.ok(chatWindow.includes("{ id: 'new-group', label: 'New group', action: () => onGroups?.(true) }"), 'New group opens group creation');
  assert.ok(chatWindow.includes("openInfo('media')") && chatWindow.includes("openInfo('disappearing')") && chatWindow.includes("openInfo('theme')") && chatWindow.includes('initialView={contactInfoView}'), 'menu entries deep-link into the info drawer');

  // Responsive header: secondary actions collapse into ⋮ on phones and the pane can never outgrow the viewport.
  const styles = await read('../src/styles.css');
  assert.equal((chatWindow.match(/className="icon-button header-action-secondary"/g) ?? []).length, 2, 'Search and Pair are the collapsible header actions');
  assert.ok(styles.includes('.app-shell.is-mobile .header-action-secondary { display: none; }') && styles.includes('@media (max-width: 480px) { .header-action-secondary { display: none; } }'), 'they are hidden on narrow screens');
  assert.ok(styles.includes('.conversation { flex: 1; min-width: 0; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr);'), 'the chat column is capped at its container');
  assert.ok(styles.includes('.conversation-person { flex: 1 1 auto; min-width: 0;') && styles.includes('.conversation-actions { flex: none;') && styles.includes('.conversation-person strong, .conversation-person small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }'), 'the name truncates instead of pushing the icons out');
  assert.ok(styles.includes('.message-bubble p, .message-bubble .wa-file-name, .wa-reply-quote, .wa-composer-reply-content span { overflow-wrap: anywhere;') && styles.includes('.composer-wrap, .composer-row, .composer { min-width: 0; }') && styles.includes('html, body { overflow-x: hidden; }'), 'long tokens wrap and the composer shrinks; no horizontal scroll');
});
