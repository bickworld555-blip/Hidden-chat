// In-call extras: quick reactions, noise cancellation, the camera flash, and the "Add people" ordering.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { CALL_REACTIONS, createCallEngine } from '../src/callEngine.js';
import { FREQUENT_LIMIT, matchesContact, rankCallContacts } from '../src/callRoom.js';
import { createChatServer } from './index.mjs';

function fakeTrack(kind, label = kind, capabilities = {}) {
  return {
    kind, label, id: `${label}-${Math.random()}`, enabled: true, readyState: 'live', onended: null,
    constraints: {}, applied: [],
    getSettings: () => ({ deviceId: label }),
    getCapabilities: () => capabilities,
    getConstraints() { return this.constraints; },
    async applyConstraints(next) { this.applied.push(next); this.constraints = next; },
    stop() { this.readyState = 'ended'; },
  };
}
class FakeStream {
  constructor(tracks = []) { this.tracks = tracks; }
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks.filter((track) => track.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter((track) => track.kind === 'video'); }
  addTrack(track) { this.tracks.push(track); }
  removeTrack(track) { this.tracks = this.tracks.filter((item) => item !== track); }
}
class FakeConnection {
  constructor() { this.signalingState = 'stable'; this.connectionState = 'new'; this.iceConnectionState = 'new'; this.senders = []; this.localDescription = null; }
  addTrack(track, stream) { const sender = { track, stream, getParameters: () => ({ encodings: [{}] }), setParameters: async () => {}, async replaceTrack(next) { this.track = next; } }; this.senders.push(sender); return sender; }
  getSenders() { return this.senders; }
  getTransceivers() { return []; }
  async createOffer() { return { type: 'offer', sdp: 'v=0\r\nfake' }; }
  async createAnswer() { return { type: 'answer', sdp: 'v=0\r\nfake' }; }
  async setLocalDescription(description) { this.localDescription = description; this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable'; }
  async setRemoteDescription() { this.signalingState = 'stable'; }
  async addIceCandidate() {}
  close() { this.connectionState = 'closed'; }
  connect() { this.connectionState = 'connected'; this.onconnectionstatechange?.(); }
}

async function connectedCall({ torch = false } = {}) {
  const connections = [];
  const sent = [];
  const tracks = {};
  const snapshots = [];
  const engine = createCallEngine({
    callId: 'extras', direction: 'outgoing', mode: 'video',
    rtc: { RTCPeerConnection: class extends FakeConnection { constructor() { super(); connections.push(this); } }, RTCIceCandidate: class { constructor(init) { Object.assign(this, init); } }, MediaStream: FakeStream },
    getUserMedia: async () => {
      tracks.audio = fakeTrack('audio');
      tracks.camera = fakeTrack('video', 'camera', torch ? { torch: true } : {});
      return new FakeStream([tracks.audio, tracks.camera]);
    },
    send: (payload) => { sent.push(payload.signal); return true; },
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  });
  await engine.start();
  engine.deliver({ type: 'answer', sdp: 'v=0\r\nfake' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  connections[0].connect();
  await new Promise((resolve) => setTimeout(resolve, 10));
  return { engine, sent, tracks, snapshots };
}

test('quick reactions go to the peer, arrive as a fresh snapshot each time, and unknown emoji are ignored', async () => {
  const { engine, sent, snapshots } = await connectedCall();
  assert.deepEqual(CALL_REACTIONS, ['👍', '❤️', '😂', '😮', '😢', '🙏']);
  assert.equal(engine.sendReaction('❤️'), true);
  assert.deepEqual(sent.at(-1), { type: 'reaction', emoji: '❤️' });
  assert.equal(engine.sendReaction('💩'), false, 'only the six quick reactions');
  engine.deliver({ type: 'reaction', emoji: '😂' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const first = snapshots.at(-1).remoteReaction;
  assert.equal(first.emoji, '😂');
  await new Promise((resolve) => setTimeout(resolve, 5));
  engine.deliver({ type: 'reaction', emoji: '😂' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.notEqual(snapshots.at(-1).remoteReaction, first, 'the same emoji twice still shows twice');
  const before = snapshots.at(-1).remoteReaction;
  engine.deliver({ type: 'reaction', emoji: '<script>' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(snapshots.at(-1).remoteReaction, before);
  engine.dispose();
});

test('noise cancellation toggles suppression on the live microphone track', async () => {
  const { engine, tracks, snapshots } = await connectedCall();
  assert.equal(snapshots.at(-1).noiseSuppression, true);
  assert.equal(await engine.setNoiseSuppression(false), true);
  assert.equal(tracks.audio.applied.at(-1).noiseSuppression, false);
  assert.equal(tracks.audio.applied.at(-1).echoCancellation, true, 'echo cancellation stays on');
  assert.equal(snapshots.at(-1).noiseSuppression, false);
  await engine.setNoiseSuppression(true);
  assert.equal(tracks.audio.applied.at(-1).noiseSuppression, true);
  engine.dispose();
});

test('the flash is offered only when the camera supports it', async () => {
  const plain = await connectedCall();
  assert.equal(plain.engine.torchAvailable(), false);
  assert.equal(await plain.engine.setTorch(true), false);
  plain.engine.dispose();
  const { engine, tracks, snapshots } = await connectedCall({ torch: true });
  assert.equal(engine.torchAvailable(), true);
  assert.equal(await engine.setTorch(true), true);
  assert.deepEqual(tracks.camera.applied.at(-1), { advanced: [{ torch: true }] });
  assert.equal(snapshots.at(-1).torch, true);
  engine.dispose();
});

test('"Add people" lists frequently contacted people first, then everyone else alphabetically', () => {
  const now = Date.parse('2026-11-09T12:00:00Z');
  const day = 86_400_000;
  const people = ['zara', 'amir', 'bina', 'old', 'nobody'].map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1), username: id }));
  const messages = {
    bina: Array.from({ length: 3 }, (_, index) => ({ timestamp: new Date(now - index * day).toISOString() })),
    zara: [{ timestamp: new Date(now - day).toISOString() }],
    old: Array.from({ length: 50 }, () => ({ timestamp: new Date(now - 90 * day).toISOString() })),
  };
  const callLogs = [{ peerId: 'zara', timestamp: new Date(now - 2 * day).toISOString() }];
  const { frequent, others } = rankCallContacts(people, { messages, callLogs, now });
  assert.deepEqual(frequent.map((person) => person.id), ['zara', 'bina'], 'a recent call outweighs a few messages; old chats do not count');
  assert.deepEqual(others.map((person) => person.id), ['amir', 'nobody', 'old']);
  const many = Array.from({ length: 12 }, (_, index) => ({ id: `p${index}`, name: `P${index}` }));
  const busy = Object.fromEntries(many.map((person) => [person.id, [{ timestamp: new Date(now).toISOString() }]]));
  assert.equal(rankCallContacts(many, { messages: busy, now }).frequent.length, FREQUENT_LIMIT);
  assert.equal(matchesContact({ name: 'Emam Mama', username: 'emam2' }, 'mama'), true);
  assert.equal(matchesContact({ name: 'Emam Mama', username: 'emam2' }, 'EMAM2'), true);
  assert.equal(matchesContact({ name: 'Joy', username: 'joy' }, 'rana'), false);
});

let service;
let directory;
let baseUrl;
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-call-extras-'));
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite') });
  baseUrl = `http://127.0.0.1:${(await service.listen()).port}`;
});
after(async () => {
  await service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

test('the server relays only the six quick reactions', async () => {
  const register = async (username) => (await fetch(`${baseUrl}/api/v1/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, dob: '1990-04-12', password: 'Correct-Horse-Battery-42!' }) })).json();
  const a = await register('reacta');
  const b = await register('reactb');
  await fetch(`${baseUrl}/api/v1/contacts`, { method: 'POST', headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: b.user.id }) });
  const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/ws', [`relay.auth.${a.token}`, 'relay.v1']);
  const events = [];
  socket.on('message', (raw) => events.push(JSON.parse(raw.toString())));
  await new Promise((resolve) => socket.once('open', resolve));
  const errorAfter = async (signal) => {
    const count = events.filter((event) => event.type === 'error').length;
    socket.send(JSON.stringify({ type: 'call:signal', targetId: b.user.id, callId: 'no-call', mode: 'video', signal }));
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const errors = events.filter((event) => event.type === 'error');
      if (errors.length > count) return errors.at(-1).message;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    return null;
  };
  assert.match(await errorAfter({ type: 'reaction', emoji: '💣' }), /invalid/);
  // A valid reaction passes validation (with no such call it is simply not delivered).
  assert.doesNotMatch(String(await errorAfter({ type: 'reaction', emoji: '👍' })), /invalid/);
  socket.close();
});
