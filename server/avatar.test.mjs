// Animation Video Call: face-scan calibration, expression mapping, the five characters, the persona store,
// and the call engine's video-filter slot that sends the avatar instead of the camera.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCallEngine } from '../src/callEngine.js';
import { NEUTRAL_EXPRESSION, blendshapeMap, expressionFromResult, headPoseFromMatrix, mouthFromAudioLevel, smoothExpression } from '../src/avatar/expression.js';
import { CALIBRATION_STEPS, CALIBRATION_THRESHOLDS, advanceCalibration, calibrationProgress, createCalibration, currentStep, personalize, profileFromCalibration } from '../src/avatar/calibration.js';
import { CHARACTERS, CHARACTER_GROUPS, characterById, drawAvatar, idleExpression } from '../src/avatar/characters.js';
import { normalizePersona } from '../src/avatar/persona.js';
import { createStats } from '../src/avatar/avatarStream.js';
import { LOCAL_MODEL_URL, MODEL_CACHE, REMOTE_MODEL_URL, WASM_BASE, loadModelBuffer } from '../src/avatar/faceTracker.js';

// --- Expression mapping --------------------------------------------------------------------------------

// Column-major 4x4 rotation about Y (yaw) by `deg`.
function yawMatrix(deg) {
  const r = (deg * Math.PI) / 180; const c = Math.cos(r); const s = Math.sin(r);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}
function pitchMatrix(deg) {
  const r = (deg * Math.PI) / 180; const c = Math.cos(r); const s = Math.sin(r);
  return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
}
const shapes = (map) => Object.entries(map).map(([categoryName, score]) => ({ categoryName, score }));
const face = (cx = 0.5, cy = 0.5, w = 0.35) => [{ x: cx - w / 2, y: cy - w / 2 }, { x: cx + w / 2, y: cy + w / 2 }];

test('landmarker results map to a compact expression; mirroring flips yaw and position', () => {
  assert.deepEqual(headPoseFromMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), { yaw: 0, pitch: 0, roll: 0 });
  assert.ok(Math.abs(Math.abs(headPoseFromMatrix(yawMatrix(30)).yaw) - 30) < 0.5, 'yaw is recovered from the matrix');
  assert.ok(Math.abs(Math.abs(headPoseFromMatrix(pitchMatrix(20)).pitch) - 20) < 0.5, 'pitch is recovered from the matrix');
  assert.deepEqual(headPoseFromMatrix(null), { yaw: 0, pitch: 0, roll: 0 });
  assert.deepEqual(blendshapeMap([{ categoryName: 'jawOpen', score: 1.4 }, { categoryName: 'x', score: -1 }, null]), Object.assign(Object.create(null), { jawOpen: 1, x: 0 }));

  const result = { faceLandmarks: [face(0.3, 0.4)], faceBlendshapes: [{ categories: shapes({ eyeBlinkLeft: 0.9, eyeBlinkRight: 0.1, jawOpen: 0.6, mouthSmileLeft: 0.4, mouthSmileRight: 0.6, browInnerUp: 0.7 }) }], facialTransformationMatrixes: [{ data: yawMatrix(25) }] };
  const mirrored = expressionFromResult(result);
  const plain = expressionFromResult(result, { mirror: false });
  assert.equal(mirrored.present, true);
  assert.equal(mirrored.jawOpen, 0.6);
  assert.equal(mirrored.smile, 0.5);
  assert.equal(mirrored.browUp, 0.7);
  assert.equal(mirrored.yaw, -plain.yaw, 'mirroring flips yaw');
  assert.ok(Math.abs(mirrored.x - 0.7) < 1e-9 && Math.abs(plain.x - 0.3) < 1e-9, 'mirroring flips the horizontal position');
  assert.equal(expressionFromResult({ faceLandmarks: [] }).present, false);
  assert.deepEqual(expressionFromResult(null), { ...NEUTRAL_EXPRESSION });

  const smoothed = smoothExpression({ ...NEUTRAL_EXPRESSION, present: true }, { ...NEUTRAL_EXPRESSION, present: true, jawOpen: 1, smile: 1 });
  assert.ok(smoothed.jawOpen > smoothed.smile, 'mouth responds faster than slow channels so lip-sync stays crisp');
  assert.equal(smoothExpression(null, mirrored).yaw, mirrored.yaw);
  assert.equal(mouthFromAudioLevel(0.5, 0), 0.6);
  assert.equal(mouthFromAudioLevel(0, 0.4), 0.4, 'audio never closes a mouth the tracker sees open');
});

// --- Calibration ----------------------------------------------------------------------------------------

const look = (yaw = 0, pitch = 0, blink = 0) => ({ ...NEUTRAL_EXPRESSION, present: true, yaw, pitch, blinkLeft: blink, blinkRight: blink });
function hold(state, expression, ms = CALIBRATION_THRESHOLDS.holdMs + 50, step = 50) {
  for (let t = 0; t < ms; t += step) state = advanceCalibration(state, expression, step);
  return state;
}

test('the face scan walks centre → left → right → up → down → blink, learns the turn direction and builds a profile', () => {
  assert.deepEqual(CALIBRATION_STEPS.map((step) => step.id), ['center', 'left', 'right', 'up', 'down', 'blink']);
  let state = createCalibration();
  assert.equal(currentStep(state).id, 'center');
  state = hold(state, look(0, 0));
  assert.equal(currentStep(state).id, 'left');
  // This tracker reports a left turn as negative yaw; the scan must accept it and remember the sign.
  state = hold(state, look(-28, 0));
  assert.equal(currentStep(state).id, 'right');
  assert.equal(state.profile.yawSign, -1);
  state = hold(state, look(-30, 0));
  assert.equal(currentStep(state).id, 'right', 'turning the same way again does not count as right');
  state = hold(state, look(26, 0));
  assert.equal(currentStep(state).id, 'up');
  state = hold(state, look(0, 18));
  assert.equal(state.profile.pitchSign, 1);
  state = hold(state, look(0, -16));
  assert.equal(currentStep(state).id, 'blink');
  assert.ok(calibrationProgress(state) > 0.8 && calibrationProgress(state) < 1);
  for (const blink of [0.9, 0.1, 0.8, 0.1]) state = advanceCalibration(state, look(0, 0, blink), 40);
  assert.equal(state.done, true);
  assert.equal(calibrationProgress(state), 1);
  const profile = profileFromCalibration(state);
  assert.deepEqual([profile.yawSign, profile.pitchSign], [-1, 1]);
  assert.ok(profile.yawRange >= 28 && profile.pitchRange >= 16 && profile.blinkMax >= 0.9);

  const personal = personalize(look(-14, 9, 0.45), profile);
  assert.ok(personal.turn > 0, 'a left turn becomes a positive turn after personalisation');
  assert.ok(Math.abs(personal.blinkLeft - 0.5) < 0.01, 'blinks are scaled to the person');

  // Losing the face resets the hold but not the progress; a brief hold does not complete a step.
  let partial = hold(createCalibration(), look(0, 0), 200);
  assert.equal(partial.heldMs, 200);
  partial = advanceCalibration(partial, { ...NEUTRAL_EXPRESSION }, 50);
  assert.deepEqual([partial.heldMs, partial.stepIndex], [0, 0]);
  assert.equal(advanceCalibration(state, look(), 50), state, 'a finished scan is inert');
});

// --- Characters and renderer ---------------------------------------------------------------------------

// Records canvas calls so the renderer can be checked without a browser.
function recordingContext() {
  const calls = [];
  const noop = () => {};
  const ctx = new Proxy({}, {
    get(target, prop) {
      if (prop === 'calls') return calls;
      if (prop === 'createLinearGradient') return () => ({ addColorStop: noop });
      if (typeof prop === 'string') return (...args) => { calls.push([prop, ...args]); };
      return undefined;
    },
    set() { return true; },
  });
  return ctx;
}

test('ten human characters (five men, five women) plus five fun ones render for any expression, and the mouth/eyes follow jaw and blink', () => {
  assert.equal(CHARACTERS.length, 15);
  assert.equal(CHARACTERS.filter((c) => c.group === 'male').length, 5);
  assert.equal(CHARACTERS.filter((c) => c.group === 'female').length, 5);
  assert.equal(CHARACTERS.filter((c) => c.group === 'fun').length, 5);
  assert.deepEqual(CHARACTER_GROUPS.map((group) => group.id), ['male', 'female', 'fun']);
  assert.equal(new Set(CHARACTERS.map((c) => c.id)).size, 15);
  assert.equal(new Set(CHARACTERS.map((c) => c.name)).size, 15);
  assert.equal(new Set(CHARACTERS.map((c) => `${c.shape}/${c.hairStyle}/${c.skin}`)).size, 15, 'each looks different');
  assert.equal(CHARACTERS[0].group, 'male', 'a person is the default, not a creature');
  // Facial hair is part of the face: a beard is drawn and moves with the jaw (more ellipse work when open).
  const bearded = characterById('kofi');
  const shut = recordingContext(); drawAvatar(shut, bearded, { ...look(), jawOpen: 0 }, 240);
  const talking = recordingContext(); drawAvatar(talking, bearded, { ...look(), jawOpen: 1 }, 240);
  const ellipseArgs = (ctx) => JSON.stringify(ctx.calls.filter(([name]) => name === 'ellipse'));
  assert.notEqual(ellipseArgs(shut), ellipseArgs(talking));
  assert.equal(characterById('momo').name, 'Momo');
  assert.equal(characterById('nope'), null);

  for (const character of CHARACTERS) {
    for (const expression of [NEUTRAL_EXPRESSION, idleExpression(1234), look(40, -20, 1), { ...look(), jawOpen: 1, smile: 1, browUp: 1, cheekPuff: 1 }]) {
      const ctx = recordingContext();
      assert.doesNotThrow(() => drawAvatar(ctx, character, expression, 240));
      assert.ok(ctx.calls.some(([name]) => name === 'fill'), `${character.name} draws something`);
    }
  }
  const closed = recordingContext();
  drawAvatar(closed, CHARACTERS[0], { ...look(), jawOpen: 0 }, 240);
  const open = recordingContext();
  drawAvatar(open, CHARACTERS[0], { ...look(), jawOpen: 1 }, 240);
  const rects = (ctx) => ctx.calls.filter(([name]) => name === 'fillRect').length;
  assert.ok(rects(open) > rects(closed), 'an open mouth shows teeth (extra fillRect)');
  const blinking = recordingContext();
  drawAvatar(blinking, CHARACTERS[0], look(0, 0, 1), 240);
  const awake = recordingContext();
  drawAvatar(awake, CHARACTERS[0], look(0, 0, 0), 240);
  const strokes = (ctx) => ctx.calls.filter(([name]) => name === 'stroke').length;
  assert.ok(strokes(blinking) > strokes(awake), 'closed eyes are drawn as lines');
  const idle = idleExpression(3400);
  assert.equal(idle.present, false);
  assert.ok(idle.blinkLeft > 0.5, 'the idle loop blinks now and then');
});

test('persona normalisation and avatar stats', () => {
  assert.equal(normalizePersona(null), null);
  assert.equal(normalizePersona({ characterId: 'ghost' }), null, 'unknown characters are dropped');
  assert.deepEqual(normalizePersona({ characterId: 'bean', profile: { yawSign: -1, pitchSign: 5, yawRange: 999, pitchRange: 1, blinkMax: 'x' }, calibratedAt: 'now' }), { characterId: 'bean', profile: { yawSign: -1, pitchSign: 1, yawRange: 60, pitchRange: 10, blinkMax: 0.8 }, calibratedAt: 'now' });
  assert.deepEqual(normalizePersona({ characterId: 'sunny' }), { characterId: 'sunny', profile: null, calibratedAt: null });
  const box = createStats();
  for (let i = 0; i < 30; i += 1) box.record(1000 + i * 33.3, 12, true);
  box.record(2001, 12, true);
  assert.ok(box.stats.fps >= 29 && box.stats.fps <= 32, `fps ~30 (${box.stats.fps})`);
  assert.equal(box.stats.latencyMs, 12);
  assert.equal(box.stats.tracking, true);
});

test('the face model is read locally, then from the cache, then downloaded once and cached', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const stores = new Map();
  const cacheStorage = { open: async () => ({ match: async (url) => stores.get(url) ?? null, put: async (url, response) => { stores.set(url, response); } }) };
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === LOCAL_MODEL_URL) return { ok: false, headers: new Headers() };
    return new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } });
  };
  const sources = [];
  const first = await loadModelBuffer({ fetchImpl, cacheStorage, onProgress: (p) => sources.push(p.source) });
  assert.deepEqual([...first], [1, 2, 3]);
  assert.deepEqual(sources, ['network']);
  const second = await loadModelBuffer({ fetchImpl, cacheStorage, onProgress: (p) => sources.push(p.source) });
  assert.deepEqual([...second], [1, 2, 3]);
  assert.deepEqual(sources, ['network', 'cache'], 'the second load does not touch the network');
  assert.equal(calls.filter((url) => url === REMOTE_MODEL_URL).length, 1);
  const local = await loadModelBuffer({ fetchImpl: async () => new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } }), cacheStorage: null, onProgress: (p) => sources.push(p.source) });
  assert.deepEqual([...local], [1, 2, 3]);
  assert.equal(sources.at(-1), 'local');
  assert.ok(WASM_BASE.startsWith('/') && MODEL_CACHE.startsWith('relay-'), 'the runtime is served by this app');
});

// --- Engine: the filter slot --------------------------------------------------------------------------

function fakeTrack(kind, label = kind) {
  return { kind, label, id: `${label}-${Math.random()}`, enabled: true, readyState: 'live', onended: null, getSettings: () => ({ deviceId: label }), stop() { this.readyState = 'ended'; } };
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
  constructor() { this.signalingState = 'stable'; this.connectionState = 'new'; this.iceConnectionState = 'new'; this.senders = []; this.offers = 0; }
  addTrack(track, stream) { const sender = { track, stream, getParameters: () => ({ encodings: [{}] }), setParameters: async () => {}, async replaceTrack(next) { this.track = next; } }; this.senders.push(sender); return sender; }
  getSenders() { return this.senders; }
  getTransceivers() { return []; }
  async createOffer() { this.offers += 1; return { type: 'offer', sdp: 'v=0\r\nfake' }; }
  async createAnswer() { return { type: 'answer', sdp: 'v=0\r\nfake' }; }
  async setLocalDescription(description) { this.localDescription = description; this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable'; }
  async setRemoteDescription(description) { this.remoteDescription = description; this.signalingState = 'stable'; }
  async addIceCandidate() {}
  close() { this.connectionState = 'closed'; }
  connect() { this.connectionState = 'connected'; this.onconnectionstatechange?.(); }
}
async function connectedCall(mode) {
  const connections = []; const sent = []; const cameras = []; const screens = [];
  const engine = createCallEngine({
    callId: 'avatar', direction: 'outgoing', mode,
    rtc: { RTCPeerConnection: class extends FakeConnection { constructor() { super(); connections.push(this); } }, RTCIceCandidate: class { constructor(init) { Object.assign(this, init); } }, MediaStream: FakeStream },
    getUserMedia: async (constraints) => { const tracks = constraints.audio === false ? [] : [fakeTrack('audio')]; if (constraints.video) { const camera = fakeTrack('video', 'camera'); cameras.push(camera); tracks.push(camera); } return new FakeStream(tracks); },
    getDisplayMedia: async () => { const screen = fakeTrack('video', 'screen'); screens.push(screen); return new FakeStream([screen]); },
    send: (payload) => { sent.push(payload.signal); return true; },
  });
  await engine.start();
  engine.deliver({ type: 'answer', sdp: 'v=0\r\nfake' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  connections[0].connect();
  return { engine, connection: connections[0], sent, cameras, screens };
}
// A scripted filter: records its inputs and hands out a fresh "avatar" track.
function scriptedFilterFactory(log) {
  return () => {
    const output = fakeTrack('video', 'avatar');
    const filter = { inputs: [], output, stopped: false, async start(track) { this.inputs.push(track); return output; }, async setInput(track) { this.inputs.push(track); }, stop() { this.stopped = true; } };
    log.push(filter);
    return filter;
  };
}

test('a video filter sends the avatar in place of the camera, keeps the camera as its input, and is announced', async () => {
  const { engine, connection, sent, cameras } = await connectedCall('video');
  const filters = [];
  const sender = connection.getSenders().find((item) => item.track.kind === 'video');
  assert.equal(await engine.setVideoFilter(scriptedFilterFactory(filters)), true);
  assert.equal(engine.state.videoFilter, true);
  assert.equal(filters.length, 1);
  assert.equal(filters[0].inputs[0], cameras[0], 'the camera feeds the filter');
  assert.equal(sender.track, filters[0].output, 'the peer receives the avatar track without renegotiation');
  assert.equal(connection.offers, 1);
  assert.equal(cameras[0].readyState, 'live', 'the camera keeps running');
  assert.deepEqual(engine.state.localStream.getVideoTracks(), [filters[0].output], 'the self view shows the avatar');
  assert.deepEqual(sent.at(-1), { type: 'media', video: true, audio: true, screen: false, avatar: true });

  engine.setCameraOff(true);
  assert.equal(filters[0].output.enabled, false);
  assert.equal(cameras[0].enabled, false, 'camera off also pauses the filter input');
  engine.setCameraOff(false);

  // Flipping the camera swaps the filter's input; the peer keeps the same avatar track.
  await engine.flipCamera();
  assert.equal(filters[0].inputs.length, 2);
  assert.equal(filters[0].inputs[1], cameras[1]);
  assert.equal(sender.track, filters[0].output);
  assert.equal(cameras[0].readyState, 'ended');

  // Screen sharing pauses the filter; stopping the share restarts it on the reopened camera.
  await engine.startScreenShare();
  assert.equal(filters[0].stopped, true);
  assert.equal(engine.state.videoFilter, false);
  assert.equal(cameras[1].readyState, 'ended');
  await engine.stopScreenShare();
  assert.equal(filters.length, 2, 'a fresh filter instance after sharing');
  assert.equal(filters[1].inputs[0], cameras[2]);
  assert.equal(sender.track, filters[1].output);
  assert.equal(engine.state.videoFilter, true);

  // Turning the avatar off puts the camera back on the wire.
  assert.equal(await engine.setVideoFilter(null), true);
  assert.equal(filters[1].stopped, true);
  assert.equal(filters[1].output.readyState, 'ended');
  assert.equal(sender.track, cameras[2]);
  assert.deepEqual(engine.state.localStream.getVideoTracks(), [cameras[2]]);
  assert.deepEqual(sent.at(-1), { type: 'media', video: true, audio: true, screen: false, avatar: false });

  await engine.setVideoFilter(scriptedFilterFactory(filters));
  engine.hangUp();
  assert.equal(filters[2].stopped, true, 'hanging up stops the filter');
  assert.equal(cameras[2].readyState, 'ended', 'and releases the camera');
});

test('a filter requested during a voice call starts when video is added; a failing filter leaves the camera on', async () => {
  const voice = await connectedCall('audio');
  const filters = [];
  assert.equal(await voice.engine.setVideoFilter(scriptedFilterFactory(filters)), false, 'nothing to filter yet');
  assert.equal(filters.length, 0);
  await voice.engine.upgradeToVideo();
  assert.equal(filters.length, 1, 'the remembered filter starts with the camera');
  assert.equal(voice.engine.state.videoFilter, true);
  const sender = voice.connection.getSenders().find((item) => item.track?.kind === 'video');
  assert.equal(sender.track, filters[0].output);

  const broken = await connectedCall('video');
  const camera = broken.cameras[0];
  assert.equal(await broken.engine.setVideoFilter(() => ({ async start() { throw new Error('No GPU'); }, stop() {} })), false);
  assert.equal(broken.engine.state.videoFilter, false);
  assert.equal(broken.engine.state.error, 'No GPU');
  assert.equal(broken.connection.getSenders().find((item) => item.track?.kind === 'video').track, camera, 'the camera is still what the peer sees');
  const peer = await connectedCall('video');
  peer.engine.deliver({ type: 'media', video: true, audio: true, screen: false, avatar: true });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(peer.engine.state.remoteAvatar, true, 'the receiving side knows it is looking at an avatar');
});

test('the UI wires the scan, the character choice, the Animation Video Call switch and the in-call toggle', async () => {
  const read = async (path) => (await readFile(new URL(path, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const studio = await read('../src/components/AvatarStudio.jsx');
  const tools = await read('../src/components/ToolsView.jsx');
  const overlay = await read('../src/components/CallOverlay.jsx');
  const app = await read('../src/App.jsx');
  const stream = await read('../src/avatar/avatarStream.js');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const styles = await read('../src/styles.css');

  assert.ok(studio.includes('advanceCalibration(calibrationRef.current, expression, dt)') && studio.includes('CALIBRATION_STEPS.map(') && studio.includes('profileFromCalibration(next)'), 'the studio drives the scan steps from live tracking');
  assert.ok(studio.includes('CHARACTER_GROUPS.map((group)') && studio.includes('CHARACTERS.filter((character) => character.group === group.id)') && studio.includes('<CharacterPreview') && studio.includes('savePersona({ characterId: selected.id'), 'every character previews live, grouped, and the choice is saved');
  assert.ok(studio.includes('Nothing from the scan is uploaded'), 'privacy note');
  assert.ok(tools.includes('<strong>Animation Video Call</strong>') && tools.includes('setAvatarCallsEnabled(!avatarCalls)') && tools.includes('<strong>Call screen animations</strong>') && tools.includes('<strong>Your avatar</strong>'), 'settings: the avatar switch, the renamed motion switch and the avatar row');
  assert.ok(overlay.includes('engine.setVideoFilter?.(factory)') && overlay.includes('engine.setVideoFilter?.(null)') && overlay.includes('createAvatarFilter({') && overlay.includes('loadFaceTracker()'), 'the call applies the avatar filter to every pair engine');
  assert.ok(overlay.includes("aria-label={avatarOn ? 'Turn off cartoon avatar' : 'Turn on cartoon avatar'}") && overlay.includes('<AvatarStudio') && overlay.includes('is using a cartoon avatar') && overlay.includes('fps ·'), 'in-call toggle, studio hand-off, peer badge and the fps/latency badge');
  assert.ok(app.includes('<AvatarStudio onClose={() => setAvatarStudioOpen(false)} />') && app.includes('onAvatarStudio={() => setAvatarStudioOpen(true)}'), 'settings open the studio');
  assert.ok(stream.includes('requestVideoFrameCallback') && stream.includes('canvas.captureStream(fps)') && stream.includes('desynchronized: true'), 'per-frame rendering into a captured canvas track');
  assert.equal(pkg.scripts.prebuild, 'node scripts/sync-mediapipe.mjs');
  assert.ok(pkg.dependencies['@mediapipe/tasks-vision']);
  assert.ok(styles.includes('.avatar-studio {') && styles.includes('.avatar-choice.is-selected'));
});
