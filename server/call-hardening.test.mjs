// Call edge cases fixed after the 2026-11-22 S23 runs: a call request that is never lost silently, an action kept
// from an earlier call that cannot answer or end the next one, and a floating window whose close keeps the call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCallEngine } from '../src/callEngine.js';
import { CALL_ACTION_MAX_AGE_MS, staleCallAction } from '../src/callActions.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const java = (name) => read(`android/app/src/main/java/io/github/bickworld555/hiddenchat/${name}.java`);
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fake() {
  const connections = [];
  class Connection {
    constructor() { this.signalingState = 'stable'; this.connectionState = 'new'; this.localDescription = null; this.remote = []; connections.push(this); }
    addTrack(track) { return { track, getParameters: () => ({ encodings: [{}] }), setParameters: async () => {}, replaceTrack: async () => {} }; }
    getSenders() { return []; }
    getTransceivers() { return []; }
    getConfiguration() { return {}; }
    setConfiguration() {}
    async getStats() { return new Map(); }
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\nthe-offer' }; }
    async createAnswer() { return { type: 'answer', sdp: 'v=0\r\nthe-answer' }; }
    async setLocalDescription(description) { this.localDescription = description; this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable'; }
    async setRemoteDescription(description) { this.remote.push(description); this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable'; }
    async addIceCandidate() {}
    close() {}
  }
  const track = (kind) => ({ kind, id: kind, enabled: true, readyState: 'live', getSettings: () => ({}), stop() {} });
  class Stream {
    constructor(tracks = []) { this.tracks = tracks; }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter((item) => item.kind === 'audio'); }
    getVideoTracks() { return []; }
    addTrack(item) { this.tracks.push(item); }
  }
  // The resend timers, fired by hand.
  const timers = [];
  return {
    connections, timers,
    options: {
      rtc: { RTCPeerConnection: Connection, RTCIceCandidate: class { constructor(init) { Object.assign(this, init); } }, MediaStream: Stream },
      getUserMedia: async () => new Stream([track('audio')]),
      setSignalTimer: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
      clearSignalTimer: (timer) => { if (timer) timer.cleared = true; },
      setRepeat: () => 0, clearRepeat: () => {},
    },
  };
}
const fire = async (timer) => { if (!timer.cleared) timer.fn(); await flush(); };

test('an outgoing call\'s request is sent again (with its candidates, after a connection check) until something comes back', async () => {
  const harness = fake();
  const sent = [];
  let checks = 0;
  const engine = createCallEngine({ ...harness.options, callId: 'c1', direction: 'outgoing', mode: 'audio', send: (payload) => { sent.push(payload.signal); return true; }, checkSignaling: () => { checks += 1; } });
  await engine.start();
  await flush();
  assert.deepEqual(sent.map((signal) => signal.type), ['offer']);
  harness.connections[0].onicecandidate({ candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 } });
  assert.deepEqual(sent.map((signal) => signal.type), ['offer', 'ice']);
  assert.deepEqual(harness.timers.map((timer) => timer.ms), [2000], 'the first check two seconds after the request');

  await fire(harness.timers[0]);
  assert.equal(checks, 1, 'the connection is checked before resending');
  assert.deepEqual(sent.map((signal) => signal.type), ['offer', 'ice', 'offer', 'ice'], 'the same request and its candidates again');
  assert.equal(sent[2].sdp, sent[0].sdp);
  assert.deepEqual(harness.timers.map((timer) => timer.ms), [2000, 3000]);

  // "Ringing" came back: the request arrived, nothing more is resent.
  engine.deliver({ type: 'ringing' });
  await flush();
  await fire(harness.timers[1]);
  assert.equal(sent.filter((signal) => signal.type === 'offer').length, 2);
  assert.equal(harness.timers.length, 2, 'no further resend is scheduled');
  engine.dispose?.();
});

test('with nothing ever coming back the request is resent three times, then left to the ring timeout', async () => {
  const harness = fake();
  const sent = [];
  const engine = createCallEngine({ ...harness.options, callId: 'c2', direction: 'outgoing', mode: 'audio', send: (payload) => { sent.push(payload.signal); return true; } });
  await engine.start();
  await flush();
  for (let index = 0; index < 5 && harness.timers[index]; index += 1) await fire(harness.timers[index]);
  assert.deepEqual(harness.timers.map((timer) => timer.ms), [2000, 3000, 5000]);
  assert.equal(sent.filter((signal) => signal.type === 'offer').length, 4, 'the request and three resends');
  engine.dispose?.();
});

test('the phone being called ignores an exact repeat of the request, before and after it is answered', async () => {
  const harness = fake();
  const sent = [];
  const logs = [];
  const offer = { type: 'offer', sdp: 'v=0\r\nthe-offer' };
  const engine = createCallEngine({ ...harness.options, callId: 'c3', direction: 'incoming', mode: 'audio', offer, send: (payload) => { sent.push(payload.signal); return true; }, log: (...args) => logs.push(args.join(' ')) });
  engine.deliver({ ...offer });
  await flush();
  assert.ok(logs.includes('offer-repeat-ignored'));
  assert.equal(harness.connections.length, 0, 'still only ringing: nothing was set up for the repeat');
  await engine.accept();
  await flush();
  assert.equal(harness.connections[0].remote.length, 1, 'the offer applied once');
  engine.deliver({ ...offer });
  await flush();
  assert.equal(harness.connections[0].remote.length, 1);
  assert.equal(sent.filter((signal) => signal.type === 'answer').length, 1, 'one answer');
  // A different offer (the caller switching to video) is a real renegotiation.
  engine.deliver({ type: 'offer', sdp: 'v=0\r\nanother-offer' });
  await flush();
  assert.equal(harness.connections[0].remote.length, 2);
  engine.dispose?.();
});

test('an action kept from an earlier call is dropped: an Answer may wait a minute, anything else fifteen seconds', () => {
  const now = 1_000_000;
  assert.equal(staleCallAction('accept', now - 5_000, now), false, 'answered from the notification while the app starts');
  assert.equal(staleCallAction('accept', now - CALL_ACTION_MAX_AGE_MS.accept - 1, now), true, 'an Answer for a call long gone');
  assert.equal(staleCallAction('hangup', now - 2_000, now), false);
  assert.equal(staleCallAction('hangup', now - 20_000, now), true, 'a Hang up kept from the previous call must not end this one');
  assert.equal(staleCallAction('reject', now - 20_000, now), true);
  assert.equal(staleCallAction('mute', now - 20_000, now), true);
  assert.equal(staleCallAction('accept', undefined, now), false, 'an older APK that does not say when: as before');
  assert.match(java('HiddenNativePlugin'), /data\.put\("callId", callId\);[\s\S]{0,400}data\.put\("at", System\.currentTimeMillis\(\)\);/);
  const overlay = read('src/components/CallOverlay.jsx');
  assert.match(overlay, /if \(callId && callId !== latest\.current\.call\.id\) return;[\s\S]{0,500}if \(staleCallAction\(action, at\)\) return;\s+if \(action === 'accept'\)/);
});

test('closing the floating call window keeps the call (Android 13+): our close action only puts the window away', () => {
  const activity = java('AppActivity');
  assert.match(activity, /if \(Build\.VERSION\.SDK_INT >= 33\) \{[\s\S]{0,400}CallActionReceiver\.ACTION_HIDE_WINDOW[\s\S]{0,400}builder\.setCloseAction\(/);
  const hide = activity.slice(activity.indexOf('static void hideFloatingWindow()'));
  assert.match(hide, /boolean moved = activity\.moveTaskToBack\(true\);\s+floating = false;/);
  assert.ok(!/hangUp|endOrphanedCall|setCall\(/.test(hide.slice(0, hide.indexOf('static void videoCallChanged'))), 'nothing in it ends the call');
  assert.match(java('CallActionReceiver'), /if \(ACTION_HIDE_WINDOW\.equals\(intent\.getAction\(\)\)\) \{\s+AppActivity\.hideFloatingWindow\(\);\s+return;/);
});

test('the engine is given a way to check the connection, and the call screen passes the realtime probe', () => {
  assert.match(read('src/components/CallOverlay.jsx'), /checkSignaling: \(\) => latest\.current\.client\?\.probe\?\.\(\),/);
});
