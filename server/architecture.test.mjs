// Phase 2 architecture: reliable call ending (socket + HTTP), the end-to-end encryption foundation (identity
// keys, cipher slot, safety numbers, call fingerprints), Opus voice notes with voice processing and pause/resume,
// on-device media encryption, and the upload priority queue with its Android foreground service.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createChatServer } from './index.mjs';
import { endCallOverHttp, ownedCallIds } from '../src/callEnd.js';
import { VOICE_BITRATE, appliedVoiceProcessing, createRecordingClock, pickVoiceFormat, voiceAudioConstraints, voiceRecorderOptions } from '../src/voiceRecording.js';
import { UPLOAD_PRIORITY, createUploadQueue, uploadPriority } from '../src/uploadQueue.js';
import { ENCRYPTED_MEDIA_ENABLED, MEDIA_CHUNK_BYTES, decryptMedia, encodeEncryptedMediaRef, encryptMedia, parseEncryptedMediaRef } from '../src/mediaCrypto.js';
import { PLAINTEXT_CIPHER, callFingerprints, createKeyDirectory, getIdentity, getMessageCipher, isEncryptedContent, openIncoming, publishIdentity, safetyNumber, sealOutgoing, setMessageCipher } from '../src/e2ee.js';
import { previewFor } from '../src/store.js';

const PASSWORD = 'Correct-Horse-Battery-42!';
const root = new URL('../', import.meta.url);
const source = (path) => readFile(new URL(path, root), 'utf8');
let service;
let directory;
let baseUrl;
let counter = 0;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-arch-'));
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), pushSender: null });
  baseUrl = `http://127.0.0.1:${(await service.listen()).port}`;
});
after(async () => {
  await service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function api(path, { session, method = 'GET', body } = {}) {
  const response = await fetch(baseUrl + path, { method, headers: { ...(session ? { Authorization: `Bearer ${session.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
async function register(prefix) {
  counter += 1;
  const { status, body } = await api('/api/v1/auth/register', { method: 'POST', body: { username: `${prefix}${counter}`, dob: '1990-04-12', password: PASSWORD } });
  assert.equal(status, 201);
  return body;
}
function connect(session) {
  const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/ws', [`relay.auth.${session.token}`, 'relay.v1']);
  socket.events = [];
  socket.on('message', (raw) => socket.events.push(JSON.parse(raw.toString())));
  return new Promise((resolve, reject) => { socket.once('open', () => resolve(socket)); socket.once('error', reject); });
}
function until(check, label, timeout = 4000) {
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
async function contacts() {
  const a = await register('archa');
  const b = await register('archb');
  await api('/api/v1/contacts', { session: a, method: 'POST', body: { userId: b.user.id } });
  await api('/api/v1/contacts', { session: b, method: 'POST', body: { userId: a.user.id } });
  return { a, b };
}

test('calls end over HTTP as well as the socket: either side, idempotent, never lost to a dropped socket', async () => {
  const { a, b } = await contacts();
  const outsider = await register('archo');
  const caller = await connect(a);
  const callee = await connect(b);
  await until(() => callee.events.some((event) => event.type === 'connection:ready'), 'ready');
  const callId = `arch-call-${Date.now()}`;
  caller.send(JSON.stringify({ type: 'call:signal', targetId: b.user.id, callId, mode: 'audio', signalId: 'x1', signal: { type: 'offer', sdp: 'v=0' } }));
  await until(() => callee.events.some((event) => event.callId === callId && event.signal?.type === 'offer'), 'offer');
  assert.equal((await api(`/api/v1/calls/${callId}/end`, { session: outsider, method: 'POST' })).status, 404, 'only the two people in the call');
  // The caller's socket has "dropped": the hang-up still reaches the callee through HTTP.
  assert.equal((await api(`/api/v1/calls/${callId}/end`, { session: a, method: 'POST' })).status, 204);
  await until(() => callee.events.some((event) => event.callId === callId && event.signal?.type === 'end'), 'callee hears the end');
  assert.equal((await api(`/api/v1/calls/${callId}/end`, { session: a, method: 'POST' })).status, 404, 'a second end is harmless');
  caller.close();
  callee.close();

  const requests = [];
  assert.equal(await endCallOverHttp('c-1', 'tok', async (url, init) => { requests.push({ url, init }); return { status: 204 }; }), true);
  assert.deepEqual([requests[0].url, requests[0].init.method, requests[0].init.keepalive, requests[0].init.headers.Authorization], ['/api/v1/calls/c-1/end', 'POST', true, 'Bearer tok']);
  assert.equal(await endCallOverHttp('c-1', 'tok', async () => { throw new Error('offline'); }), false);
  assert.deepEqual(ownedCallIds('main', [{ callId: 'pair-2' }, { callId: 'main' }]), ['main', 'pair-2'], 'group pairs end too');
  const overlay = await source('src/components/CallOverlay.jsx');
  assert.ok(overlay.includes('for (const callId of ownedCallIds(call.id, extrasRef.current.entries())) endCallOverHttp(callId, latest.current.sessionToken);'));
  const server = await source('server/index.mjs');
  assert.ok(server.includes("callTimeoutMs = process.env.CALL_RING_TIMEOUT_MS === undefined ? 60_000"), 'unanswered calls stop ringing after a minute by default');
  const nativeDecline = await source('android/app/src/main/java/io/github/bickworld555/hiddenchat/PushRegistration.java');
  assert.ok(nativeDecline.includes('"/end"'), 'the phone declines through the same endpoint');
});

test('identity keys: one public key per account, private key stays on the device, key changes are announced', async () => {
  const { a, b } = await contacts();
  const memory = new Map();
  const storage = { get: async (key) => memory.get(key), set: async (key, value) => { memory.set(key, value); } };
  const identity = await getIdentity({ storage });
  assert.equal(identity.privateKey.extractable, false, 'the private key cannot be exported');
  assert.equal((await getIdentity({ storage })).publicKey, identity.publicKey, 'made once, then reused');
  const fetchImpl = (path, init) => fetch(baseUrl + path, init);
  assert.equal(await publishIdentity(a.token, { identity, fetchImpl }), true);
  const watcher = await connect(b);
  await until(() => watcher.events.some((event) => event.type === 'connection:ready'), 'ready');
  const fetched = await api(`/api/v1/users/${a.user.id}/identity-key`, { session: b });
  assert.deepEqual([fetched.body.publicKey, fetched.body.algorithm], [identity.publicKey, 'ECDH-P256']);
  const directoryCache = createKeyDirectory({ fetchImpl });
  assert.equal((await directoryCache.keyFor(a.user.id, b.token)).publicKey, identity.publicKey);

  const other = await getIdentity({ storage: { get: async () => null, set: async () => {} } });
  assert.equal(await publishIdentity(a.token, { identity: other, fetchImpl }), true);
  await until(() => watcher.events.some((event) => event.type === 'identity:changed' && event.userId === a.user.id), 'security code changed');
  assert.equal((await api('/api/v1/me/identity-key', { session: a, method: 'PUT', body: { publicKey: 'short', algorithm: 'ECDH-P256' } })).status, 400);
  assert.equal((await api('/api/v1/me/identity-key', { session: a, method: 'PUT', body: { publicKey: identity.publicKey, algorithm: 'RSA' } })).status, 400);
  assert.equal((await api(`/api/v1/users/${b.user.id}/identity-key`, { session: a })).status, 404, 'no key published yet');
  watcher.close();

  const ab = await safetyNumber(identity.publicKey, other.publicKey);
  assert.equal(ab, await safetyNumber(other.publicKey, identity.publicKey), 'the same on both phones');
  assert.match(ab, /^(\d{5} ){11}\d{5}$/);
});

test('message cipher slot: plain by default, a registered cipher seals and opens; envelopes never show as text', async () => {
  assert.equal(getMessageCipher(), PLAINTEXT_CIPHER);
  assert.equal(await sealOutgoing('peer', 'hello'), 'hello');
  assert.equal(await openIncoming('peer', 'hello'), 'hello');
  setMessageCipher({ id: 'test', encrypt: async (_p, text) => `e2e1:${Buffer.from(text).toString('base64')}`, decrypt: async (_p, content) => Buffer.from(content.slice(5), 'base64').toString() });
  const sealed = await sealOutgoing('peer', 'secret');
  assert.ok(isEncryptedContent(sealed));
  assert.equal(await openIncoming('peer', sealed), 'secret');
  setMessageCipher(PLAINTEXT_CIPHER);
  assert.throws(() => setMessageCipher({}), /encrypt\(\) and decrypt\(\)/);
  assert.equal(previewFor('e2e1:abcd'), '🔒 Message');
  const sdp = 'v=0\r\na=fingerprint:SHA-256 ab:cd:ef\r\nm=audio\r\na=fingerprint:sha-256 01:02\r\n';
  assert.deepEqual(callFingerprints(sdp), ['sha-256 01:02', 'sha-256 AB:CD:EF']);
  const java = await source('android/app/src/main/java/io/github/bickworld555/hiddenchat/MessagePreview.java');
  assert.ok(java.includes('if (content.startsWith("e2e1:")) return "🔒 Message";'));
});

test('voice notes: Opus at a voice bitrate, noise suppression / echo cancellation / auto gain, pause-aware length', () => {
  const constraints = voiceAudioConstraints({ echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: true });
  assert.deepEqual(constraints.audio.noiseSuppression, { ideal: true });
  assert.deepEqual(constraints.audio.autoGainControl, { ideal: true });
  assert.deepEqual(constraints.audio.echoCancellation, { ideal: true });
  assert.deepEqual(constraints.audio.channelCount, { ideal: 1 });
  assert.equal(constraints.video, false);
  assert.equal(voiceAudioConstraints({ noiseSuppression: false }).audio.noiseSuppression, undefined, 'not asked where unknown');
  const chrome = { isTypeSupported: (type) => type.startsWith('audio/webm') };
  assert.equal(pickVoiceFormat(chrome), 'audio/webm;codecs=opus');
  assert.equal(pickVoiceFormat({ isTypeSupported: () => true }), 'audio/ogg;codecs=opus');
  assert.equal(pickVoiceFormat(undefined), '');
  assert.deepEqual(voiceRecorderOptions(chrome), { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: VOICE_BITRATE });
  assert.deepEqual(appliedVoiceProcessing({ getSettings: () => ({ noiseSuppression: true, autoGainControl: false }) }), { echoCancellation: false, noiseSuppression: true, autoGainControl: false });

  let now = 0;
  const clock = createRecordingClock(() => now);
  clock.start();
  now = 4000;
  clock.pause();
  now = 60_000; // a long pause does not count
  assert.equal(clock.elapsed(), 4);
  clock.resume();
  now = 63_500;
  assert.equal(clock.elapsed(), 7.5);
  clock.pause();
  clock.pause();
  assert.equal(clock.elapsed(), 7.5, 'pausing twice is harmless');
});

test('voice recorder uses the voice settings and the pause-aware clock', async () => {
  const bar = await source('src/components/VoiceRecorderBar.jsx');
  assert.ok(bar.includes('navigator.mediaDevices.getUserMedia(voiceAudioConstraints('));
  assert.ok(bar.includes('new MediaRecorder(stream, voiceRecorderOptions(MediaRecorder))'));
  assert.match(bar, /recorder\.pause\(\);\s*session\.clock\.pause\(\);/);
  assert.match(bar, /recorder\.resume\(\);\s*session\.clock\.resume\(\);/);
  assert.ok(!bar.includes('resumedAt'), 'one clock, no hand-kept timestamps');
});

test('encrypted media: per-file key, chunked AES-GCM, integrity checked; tampering or truncation is refused', async () => {
  assert.equal(ENCRYPTED_MEDIA_ENABLED, false, 'prepared, not switched on yet');
  const bytes = new Uint8Array(MEDIA_CHUNK_BYTES * 2 + 12345).map((_, index) => (index * 31) % 251);
  const file = new Blob([bytes], { type: 'video/mp4' });
  const { blob, descriptor } = await encryptMedia(file);
  assert.equal(blob.size, bytes.length + 3 * 16, 'three chunks, each with its tag');
  assert.notDeepEqual(new Uint8Array(await blob.slice(0, 32).arrayBuffer()), bytes.slice(0, 32));
  const plain = await decryptMedia(blob, descriptor);
  assert.deepEqual(new Uint8Array(await plain.arrayBuffer()), bytes);
  assert.equal(plain.type, 'video/mp4');

  const tampered = new Uint8Array(await blob.arrayBuffer());
  tampered[100] ^= 1;
  await assert.rejects(decryptMedia(new Blob([tampered]), descriptor), /does not match/);
  const cut = blob.slice(0, MEDIA_CHUNK_BYTES + 16);
  await assert.rejects(decryptMedia(cut, { ...descriptor, encSha256: descriptor.encSha256 }), /does not match/);
  await assert.rejects(decryptMedia(blob, { ...descriptor, key: (await encryptMedia(new Blob(['x']))).descriptor.key }));

  const empty = await encryptMedia(new Blob([]));
  assert.equal((await decryptMedia(empty.blob, empty.descriptor)).size, 0);
  const ref = encodeEncryptedMediaRef('m1', descriptor, 'Holiday clip.mp4');
  assert.deepEqual(parseEncryptedMediaRef(ref), { mediaId: 'm1', descriptor, filename: 'Holiday clip.mp4' });
  assert.equal(previewFor(ref), '🎥 Video');
  assert.equal(parseEncryptedMediaRef('media:m1:x.mp4'), null);
});

test('uploads: priority queue (voice and small first), limited concurrency, overall progress', async () => {
  assert.equal(uploadPriority({ kind: 'voice', size: 9e9 }), UPLOAD_PRIORITY.HIGH);
  assert.equal(uploadPriority({ size: 1024 }), UPLOAD_PRIORITY.HIGH);
  assert.equal(uploadPriority({ size: 10 * 1024 * 1024 }), UPLOAD_PRIORITY.NORMAL);
  assert.equal(uploadPriority({ size: 500 * 1024 * 1024 }), UPLOAD_PRIORITY.LOW);

  const states = [];
  const started = [];
  const finishers = {};
  const queue = createUploadQueue({ concurrency: 1, onChange: (state) => states.push(state) });
  const task = (name, size, priority) => queue.enqueue((report) => {
    started.push(name);
    report(size / 2);
    return new Promise((resolve) => { finishers[name] = () => resolve(name); });
  }, { label: name, size, priority });
  const big = task('big.mp4', 1000, UPLOAD_PRIORITY.LOW);
  const doc = task('doc.pdf', 100, UPLOAD_PRIORITY.NORMAL);
  const voice = task('voice.ogg', 10, UPLOAD_PRIORITY.HIGH);
  await until(() => started.length === 1, 'first starts');
  assert.deepEqual(started, ['big.mp4'], 'the first one was alone, so it started');
  assert.equal(queue.state().count, 3);
  finishers['big.mp4']();
  assert.equal(await big, 'big.mp4');
  await until(() => started.length === 2, 'next');
  assert.equal(started[1], 'voice.ogg', 'then the voice note jumps the queue');
  finishers['voice.ogg']();
  await voice;
  await until(() => started.length === 3, 'last');
  finishers['doc.pdf']();
  await doc;
  await until(() => queue.state().count === 0, 'empty');
  assert.equal(states.at(-1).count, 0, 'the last report says the queue is empty (stops the Android service)');
  assert.ok(states.some((state) => state.progress > 0 && state.progress < 1));
  await assert.rejects(queue.enqueue(async () => { throw new Error('nope'); }), /nope/);
  assert.equal(queue.state().count, 0, 'a failed upload leaves the queue');
});

test('uploads go through the queue and keep an Android "Sending…" foreground service while running', async () => {
  const upload = await source('src/upload.js');
  assert.ok(upload.includes('const uploadQueue = createUploadQueue({ concurrency: 2, onChange: reportUploads });'));
  assert.ok(upload.includes("nativeSetUploads({ count: state.count, label: state.label, progress: Math.round(state.progress * 100) });"));
  const manifest = await source('android/app/src/main/AndroidManifest.xml');
  assert.match(manifest, /android:name="\.UploadService"\s+android:exported="false"\s+android:foregroundServiceType="dataSync"/);
  const service = await source('android/app/src/main/java/io/github/bickworld555/hiddenchat/UploadService.java');
  assert.ok(service.includes('ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(), type);'));
  assert.ok(service.includes('public void onTimeout(int startId, int fgsType)'), 'Android 15 dataSync time budget handled');
  assert.match(service, /if \(count == 0\) \{\s*if \(service != null\) service\.finish\(\);/);
  const plugin = await source('android/app/src/main/java/io/github/bickworld555/hiddenchat/HiddenNativePlugin.java');
  assert.ok(plugin.includes('UploadService.update(getContext(), call.getInt("count", 0), call.getString("label", ""), call.getInt("progress", 0));'));
});
