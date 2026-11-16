// Group calls on one phone: one microphone and one camera shared by every pair connection (src/callMedia.js), lighter
// video once three or more are in the call (src/callQuality.js), and a call that goes on while anyone is left.
// Found live: in a three-person video call each phone opened the camera and microphone once per other person;
// Android gave the camera to one connection (the other's picture froze) and one voice went silent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCallMediaSource } from '../src/callMedia.js';
import { GROUP_VIDEO_CAP, VIDEO_LEVELS, videoEncodingFor } from '../src/callQuality.js';

// A stand-in for a capture: tracks with a source; clones share it, and the source counts as open while any is live.
function fakeDevices() {
  const captures = [];
  let serial = 0;
  const track = (kind, source) => {
    const item = {
      id: `t${(serial += 1)}`, kind, source, readyState: 'live',
      stop() { item.readyState = 'ended'; },
      clone() { return track(kind, source); },
    };
    source.tracks.push(item);
    return item;
  };
  const capture = async (constraints) => {
    const tracks = [];
    if (constraints.audio) tracks.push(track('audio', { kind: 'audio', constraints: constraints.audio, tracks: [] }));
    if (constraints.video) tracks.push(track('video', { kind: 'video', constraints: constraints.video, tracks: [] }));
    captures.push({ constraints, tracks });
    return { getTracks: () => tracks, getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'), getVideoTracks: () => tracks.filter((t) => t.kind === 'video') };
  };
  const openSources = () => [...new Set(captures.flatMap((c) => c.tracks.map((t) => t.source)))].filter((source) => source.tracks.some((t) => t.readyState === 'live'));
  return { capture, captures, openSources };
}
const stream = (tracks) => ({ tracks, getTracks: () => tracks, getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'), getVideoTracks: () => tracks.filter((t) => t.kind === 'video') });

test('three connections at once share one microphone and one camera capture; each gets its own copies', async () => {
  const devices = fakeDevices();
  const media = createCallMediaSource({ capture: devices.capture, createStream: stream });
  const front = { facingMode: 'user', width: { ideal: 1280 } };
  // A group call's connections start together (the newcomer calls everyone at once).
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => media.get({ audio: { echoCancellation: true }, video: front })));
  assert.equal(devices.captures.length, 1, 'the camera and microphone are opened once');
  const ids = [a, b, c].flatMap((s) => s.getTracks().map((t) => t.id));
  assert.equal(new Set(ids).size, 6, 'each connection has its own audio and video track');
  assert.ok([a, b, c].every((s) => s.getAudioTracks().length === 1 && s.getVideoTracks().length === 1));
  // Muting or switching off one copy (what each engine does) leaves the others alone; ending one call's pair too.
  a.getAudioTracks()[0].stop();
  assert.equal(b.getAudioTracks()[0].readyState, 'live');
  // Turning video on later (audio call upgraded) captures only the camera, still once.
  const audioOnly = await media.get({ audio: { echoCancellation: true }, video: false });
  assert.equal(audioOnly.getVideoTracks().length, 0);
  assert.equal(devices.captures.length, 1);
});

test('switching camera closes the open one first (phones cannot open two), then every connection copies the new one', async () => {
  const devices = fakeDevices();
  const media = createCallMediaSource({ capture: devices.capture, createStream: stream });
  const front = { facingMode: 'user' };
  const back = { facingMode: 'environment' };
  const [a, b] = await Promise.all([media.get({ audio: true, video: front }), media.get({ audio: true, video: front })]);
  // Every connection flips (CallOverlay flipCamera on all engines), one after another through the source.
  const [a2, b2] = await Promise.all([media.get({ video: back, audio: false }), media.get({ video: back, audio: false })]);
  assert.equal(devices.captures.length, 2, 'the back camera is opened once');
  assert.deepEqual(devices.captures[1].constraints, { audio: false, video: back });
  assert.equal(a.getVideoTracks()[0].readyState, 'ended', 'the front camera copies were closed first');
  assert.equal(b.getVideoTracks()[0].readyState, 'ended');
  assert.equal(a.getAudioTracks()[0].readyState, 'live', 'the microphone is untouched');
  assert.equal(devices.openSources().filter((source) => source.kind === 'video').length, 1, 'never two cameras open');
  assert.notEqual(a2.getVideoTracks()[0].id, b2.getVideoTracks()[0].id);
  // The call ends: everything closes.
  media.stop();
  assert.equal(devices.openSources().length, 0);
  await assert.rejects(media.get({ audio: true }), /closed/);
});

test('a group call sends lighter video on each connection; one-to-one and a shared screen keep full quality', () => {
  const high = VIDEO_LEVELS[0];
  assert.deepEqual(videoEncodingFor(high, { roomSize: 2 }), { maxBitrate: high.maxBitrate, maxFramerate: high.maxFramerate, scale: high.scale });
  const group = videoEncodingFor(high, { roomSize: 3 });
  assert.deepEqual(group, { maxBitrate: GROUP_VIDEO_CAP.maxBitrate, maxFramerate: GROUP_VIDEO_CAP.maxFramerate, scale: GROUP_VIDEO_CAP.scale });
  assert.ok(GROUP_VIDEO_CAP.maxBitrate <= 500_000 && GROUP_VIDEO_CAP.scale >= 2, 'about 360p from a 720p camera');
  // A weak network can still lower it further.
  const low = VIDEO_LEVELS.at(-1);
  assert.ok(videoEncodingFor(low, { roomSize: 4 }).maxBitrate <= low.maxBitrate);
  assert.equal(videoEncodingFor(high, { roomSize: 4, screenSharing: true }).scale, 1);
});

test('the call screen: shared capture for every engine, room size on every engine, and the call goes on while anyone is left', () => {
  const overlay = readFileSync(new URL('../src/components/CallOverlay.jsx', import.meta.url), 'utf8');
  assert.match(overlay, /getUserMedia: \(constraints\) => mediaSource\(\)\.get\(constraints\),/);
  assert.ok(!/navigator\.mediaDevices\.getUserMedia\(constraints\)[\s\S]{0,40}\n\s*\},\n\s*enumerateDevices/.test(overlay), 'no engine opens the devices itself');
  assert.match(overlay, /mediaSourceRef\.current\?\.stop\(\);/, 'released when the call screen goes');
  assert.match(overlay, /engine\.setRoomSize\?\.\(roomSizeRef\.current\);/);
  assert.match(overlay, /const terminal = primaryEnded && !othersInCall;/);
  assert.match(overlay, /status: going \? 'connected' : next\.status/, 'the app keeps the call open (a newcomer is taken, nothing logged as ended)');
  assert.match(overlay, /const participants = \[userId, \.\.\.peopleInCall\(\)\];/, 'an invitee never rings someone who left');
  const engine = readFileSync(new URL('../src/callEngine.js', import.meta.url), 'utf8');
  assert.match(engine, /videoEncodingFor\(VIDEO_LEVELS\[quality\.level\] \?\? VIDEO_LEVELS\[0\], \{ roomSize, screenSharing: state\.screenSharing \}\)/);
});
