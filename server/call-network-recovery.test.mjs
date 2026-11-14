// Calls on mobile networks: the engine steps video down on a lossy uplink, notices a path that stopped carrying media
// while ICE still says "connected", restarts ICE from either side, falls back to the TURN relay, and reacts to a
// Wi-Fi ↔ mobile data switch. Driven with a fake RTCPeerConnection whose getStats() the test scripts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ICE_RESTART_COOLDOWN_MS, ICE_RETRY_MS, createCallEngine } from '../src/callEngine.js';
import { DOWNGRADE_SAMPLES, STALL_SAMPLES, UPGRADE_SAMPLES, VIDEO_LEVELS, createQualityTracker, hasTurnRelay, levelFor, readQualitySample, updateQuality } from '../src/callQuality.js';
import { getStatusLabel } from '../src/callStatus.js';
import { VIDEO_MAX_BITRATE } from '../src/rtc.js';

const TURN = [{ urls: 'stun:stun.example:3478' }, { urls: ['turn:relay.example:3478?transport=udp'], username: 'u', credential: 'p' }];

// A getStats() report: a Map of stats objects, the shape browsers return.
function report({ packets = 0, lost = 0, sentLoss = null, rtt = null, available = null, cpu = false, relay = false } = {}) {
  const stats = [
    { id: 'in-a', type: 'inbound-rtp', kind: 'audio', packetsReceived: packets, packetsLost: lost },
    { id: 'out-v', type: 'outbound-rtp', kind: 'video', qualityLimitationReason: cpu ? 'cpu' : 'none' },
    { id: 't', type: 'transport', selectedCandidatePairId: 'p1' },
    { id: 'p1', type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'l', remoteCandidateId: 'r', currentRoundTripTime: rtt ?? undefined, availableOutgoingBitrate: available ?? undefined },
    { id: 'l', type: 'local-candidate', candidateType: relay ? 'relay' : 'srflx' },
    { id: 'r', type: 'remote-candidate', candidateType: 'srflx' },
  ];
  if (sentLoss != null) stats.push({ id: 'ri-v', type: 'remote-inbound-rtp', kind: 'video', fractionLost: sentLoss });
  return new Map(stats.map((stat) => [stat.id, stat]));
}

function fakeRtc() {
  const connections = [];
  class FakeConnection {
    constructor(config) {
      this.config = { ...config };
      this.signalingState = 'stable';
      this.connectionState = 'new';
      this.localDescription = null;
      this.senders = [];
      this.restarts = 0;
      this.nextReport = report();
      connections.push(this);
    }
    addTrack(track) {
      const sender = { track, params: { encodings: [{}] }, getParameters() { return structuredClone(this.params); }, async setParameters(next) { this.params = next; }, async replaceTrack(next) { this.track = next; } };
      this.senders.push(sender);
      return sender;
    }
    getSenders() { return this.senders; }
    getTransceivers() { return []; }
    getConfiguration() { return { ...this.config }; }
    setConfiguration(next) { this.config = { ...next }; }
    async getStats() { return this.nextReport; }
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\nfake-offer' }; }
    async createAnswer() { return { type: 'answer', sdp: 'v=0\r\nfake-answer' }; }
    async setLocalDescription(description) { this.localDescription = description; this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable'; }
    async setRemoteDescription(description) { this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable'; }
    async addIceCandidate() {}
    restartIce() { this.restarts += 1; }
    close() { this.connectionState = 'closed'; }
    transition(state) { this.connectionState = state; this.onconnectionstatechange?.(); }
  }
  const track = (kind) => ({ kind, id: `${kind}-${Math.random()}`, enabled: true, readyState: 'live', getSettings: () => ({}), stop() { this.readyState = 'ended'; } });
  class FakeStream {
    constructor(tracks = []) { this.tracks = tracks; }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter((item) => item.kind === 'audio'); }
    getVideoTracks() { return this.tracks.filter((item) => item.kind === 'video'); }
    addTrack(item) { this.tracks.push(item); }
    removeTrack(item) { this.tracks = this.tracks.filter((other) => other !== item); }
  }
  return {
    connections,
    rtc: { RTCPeerConnection: FakeConnection, RTCIceCandidate: class { constructor(init) { Object.assign(this, init); } }, MediaStream: FakeStream },
    getUserMedia: async (constraints) => new FakeStream([track('audio'), ...(constraints.video ? [track('video')] : [])]),
  };
}

function fakeClock() {
  let now = 0;
  const timers = new Map();
  let nextId = 1;
  return {
    setTimer(fn, ms) { const id = nextId++; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimer(id) { timers.delete(id); },
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await new Promise((resolve) => setImmediate(resolve));
      }
      now = until;
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

// A connected video call whose quality sampler the test fires by hand (`tick`).
async function connectedCall({ direction = 'outgoing', iceServers = TURN } = {}) {
  const fake = fakeRtc();
  const clock = fakeClock();
  const sent = [];
  let sampler = null;
  let networkHandler = null;
  const engine = createCallEngine({
    callId: 'net', direction, mode: 'video', rtc: fake.rtc, getUserMedia: fake.getUserMedia,
    offer: direction === 'incoming' ? { type: 'offer', sdp: 'v=0\r\nfake-offer' } : null,
    fetchIceServers: async () => iceServers,
    send: (payload) => { sent.push(payload.signal); return true; },
    setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    setRepeat: (fn) => { sampler = fn; return 1; }, clearRepeat: () => { sampler = null; },
    onNetworkChange: (handler) => { networkHandler = handler; return () => { networkHandler = null; }; },
  });
  if (direction === 'outgoing') {
    await engine.start();
    engine.deliver({ type: 'answer', sdp: 'v=0\r\nfake-answer' });
  } else {
    await engine.accept();
  }
  for (let i = 0; i < 20 && !engine.state.answered; i += 1) await flush();
  const pc = fake.connections[0];
  pc.transition('connected');
  const tick = async (stats) => { pc.nextReport = report(stats); sampler?.(); await flush(); await flush(); };
  return { engine, pc, clock, sent, tick, get sampler() { return sampler; }, network: () => networkHandler?.('network-type') };
}

test('stats are read from the selected candidate pair, and each signal maps to a video level', () => {
  const sample = readQualitySample(report({ packets: 120, lost: 4, sentLoss: 0.2, rtt: 0.18, available: 2_000_000, relay: true }));
  assert.deepEqual(sample, { inboundPackets: 120, inboundLost: 4, sentVideoLoss: 0.2, rtt: 0.18, availableOutgoingBitrate: 2_000_000, cpuLimited: false, pathType: 'relay' });
  assert.equal(levelFor({ sentVideoLoss: 0.01, rtt: 0.1, availableOutgoingBitrate: 3_000_000 }), 0);
  assert.equal(levelFor({ sentVideoLoss: 0.08 }), 1, 'some loss: medium');
  assert.equal(levelFor({ sentVideoLoss: 0.2 }), 2, 'heavy loss: low');
  assert.equal(levelFor({ rtt: 0.5 }), 1);
  assert.equal(levelFor({ availableOutgoingBitrate: 300_000 }), 2, 'a thin uplink: low');
  assert.equal(levelFor({ cpuLimited: true }), 1, 'an overloaded encoder steps down too');
  assert.equal(levelFor({}), 0, 'unknown numbers never degrade the call');
  assert.equal(VIDEO_LEVELS[0].maxBitrate, VIDEO_MAX_BITRATE, 'the top level is the normal 720p budget');
  assert.equal(readQualitySample(null).inboundPackets, 0);
});

test('the level steps down quickly on a bad uplink and back up slowly, one level at a time', () => {
  const tracker = createQualityTracker();
  let packets = 0;
  const step = (extra) => updateQuality(tracker, { inboundPackets: (packets += 50), inboundLost: 0, ...extra });
  step({});
  for (let i = 1; i < DOWNGRADE_SAMPLES; i += 1) assert.equal(step({ sentVideoLoss: 0.3 }).level, 0, 'one bad sample is not enough');
  const down = step({ sentVideoLoss: 0.3 });
  assert.deepEqual([down.level, down.changed, down.quality], [2, true, 'poor']);
  for (let i = 1; i < UPGRADE_SAMPLES; i += 1) assert.equal(step({ sentVideoLoss: 0 }).level, 2);
  assert.equal(step({ sentVideoLoss: 0 }).level, 1, 'recovers one level after a clean stretch');
  for (let i = 0; i < UPGRADE_SAMPLES; i += 1) step({ sentVideoLoss: 0 });
  assert.equal(tracker.level, 0);
  const good = step({});
  assert.deepEqual([good.quality, good.stalled], ['good', false]);
});

test('heavy loss on what we receive reads as a poor connection next to the timer', () => {
  const tracker = createQualityTracker();
  updateQuality(tracker, { inboundPackets: 100, inboundLost: 0 });
  assert.equal(updateQuality(tracker, { inboundPackets: 170, inboundLost: 30 }).quality, 'poor');
  assert.equal(getStatusLabel({ status: 'connected', elapsed: 65, networkQuality: 'poor' }), '1:05 · Poor connection');
  assert.equal(getStatusLabel({ status: 'connected', elapsed: 65, networkQuality: 'weak' }), '1:05');
});

test('a lossy uplink lowers the sent video (bitrate, resolution, frame rate) and restores it later', async () => {
  const call = await connectedCall();
  const video = call.pc.getSenders().find((sender) => sender.track.kind === 'video');
  await flush();
  assert.equal(video.params.encodings[0].maxBitrate, VIDEO_MAX_BITRATE);
  let packets = 0;
  for (let i = 0; i <= DOWNGRADE_SAMPLES; i += 1) await call.tick({ packets: (packets += 60), sentLoss: 0.25 });
  assert.deepEqual(video.params.encodings[0], { maxBitrate: VIDEO_LEVELS[2].maxBitrate, maxFramerate: VIDEO_LEVELS[2].maxFramerate, scaleResolutionDownBy: VIDEO_LEVELS[2].scale }, 'low level applied to the sender');
  assert.equal(video.params.degradationPreference, 'maintain-framerate');
  assert.equal(call.engine.state.networkQuality, 'poor');
  for (let i = 0; i < UPGRADE_SAMPLES * 2; i += 1) await call.tick({ packets: (packets += 60), sentLoss: 0 });
  assert.equal(video.params.encodings[0].maxBitrate, VIDEO_MAX_BITRATE);
  assert.equal(video.params.encodings[0].scaleResolutionDownBy, 1);
  assert.equal(call.engine.state.networkQuality, 'good');
  call.engine.hangUp();
  assert.equal(call.sampler, null, 'the sampler stops with the call');
});

test('media that stops arriving while ICE says connected restarts ICE, then goes through the relay the second time', async () => {
  const call = await connectedCall();
  let packets = 100;
  await call.tick({ packets });
  for (let i = 0; i < STALL_SAMPLES; i += 1) await call.tick({ packets });
  assert.equal(call.engine.state.status, 'reconnecting', 'a stalled path is shown honestly, not as a frozen picture');
  assert.equal(call.pc.restarts, 1);
  assert.equal(call.pc.config.iceTransportPolicy, undefined, 'the first attempt may still find a direct path');

  await call.tick({ packets: (packets += 80) });
  assert.equal(call.engine.state.status, 'connected', 'media flowing again ends "Reconnecting…" even without a new ICE event');

  await call.clock.advance(ICE_RESTART_COOLDOWN_MS);
  for (let i = 0; i < STALL_SAMPLES; i += 1) await call.tick({ packets });
  assert.equal(call.pc.restarts, 2);
  assert.equal(call.pc.config.iceTransportPolicy, 'relay', 'second stall: relay-only');
  assert.deepEqual(call.sent.filter((signal) => signal.type === 'ice-restart'), [{ type: 'ice-restart', relay: true, restarting: true }], 'the callee is told to use the relay too');
  call.engine.hangUp();
});

test('without a TURN server the relay fallback is skipped and ICE still restarts', async () => {
  const call = await connectedCall({ iceServers: [{ urls: 'stun:stun.example:3478' }] });
  assert.equal(hasTurnRelay([{ urls: 'stun:stun.example:3478' }]), false);
  call.pc.transition('failed');
  await call.clock.advance(ICE_RESTART_COOLDOWN_MS);
  call.pc.transition('failed');
  assert.equal(call.pc.restarts, 2);
  assert.equal(call.pc.config.iceTransportPolicy, undefined);
  call.engine.hangUp();
});

test('the callee asks the caller to restart, and the caller restarts on that request', async () => {
  const callee = await connectedCall({ direction: 'incoming' });
  callee.pc.transition('failed');
  assert.equal(callee.pc.restarts, 0, 'the callee never sends a crossing offer itself');
  assert.deepEqual(callee.sent.filter((signal) => signal.type === 'ice-restart'), [{ type: 'ice-restart', relay: false }]);
  callee.engine.hangUp();

  const caller = await connectedCall();
  caller.engine.deliver({ type: 'ice-restart', relay: true });
  for (let i = 0; i < 5; i += 1) await flush();
  assert.equal(caller.pc.restarts, 1);
  assert.equal(caller.pc.config.iceTransportPolicy, 'relay');
  caller.engine.deliver({ type: 'ice-restart', relay: false });
  for (let i = 0; i < 5; i += 1) await flush();
  assert.equal(caller.pc.restarts, 1, 'a second request inside the cooldown is merged with the first');
  caller.engine.hangUp();
});

test('a restart that does not bring the call back is retried, through the relay, until the grace runs out', async () => {
  const call = await connectedCall();
  call.pc.transition('disconnected');
  assert.equal(call.engine.state.status, 'reconnecting');
  await call.clock.advance(2_000);
  assert.equal(call.pc.restarts, 1);
  await call.clock.advance(ICE_RETRY_MS);
  assert.equal(call.pc.restarts, 2);
  await call.clock.advance(ICE_RETRY_MS);
  assert.equal(call.pc.restarts, 3);
  assert.equal(call.pc.config.iceTransportPolicy, 'relay', 'two failed restarts: relay-only');
  call.pc.transition('connected');
  assert.equal(call.engine.state.status, 'connected');
  await call.clock.advance(60_000);
  assert.equal(call.engine.state.status, 'connected', 'no retry or grace timer outlives the recovery');
  call.engine.hangUp();
});

test('switching between Wi-Fi and mobile data restarts ICE straight away', async () => {
  const call = await connectedCall();
  call.network();
  assert.equal(call.pc.restarts, 1);
  assert.equal(call.engine.state.status, 'connected', 'the old path may still work; nothing is shown as broken');
  call.engine.hangUp();
  call.network();
  assert.equal(call.pc.restarts, 1, 'the watcher is gone once the call ends');
});
