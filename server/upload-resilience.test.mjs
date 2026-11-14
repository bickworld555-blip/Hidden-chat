// Voice notes, photos and videos survive a weak or switching mobile connection (src/upload.js): a stalled request is
// dropped and retried, a dropped one is retried, and on mobile data anything over 1 MB goes up in small resumable
// pieces. A fake XMLHttpRequest stands in for the network.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CELLULAR_CHUNK_BYTES, MIB, UPLOAD_CHUNK_BYTES, uploadPlan } from '../src/transfer.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// Each request is decided by the next entry: 'ok' answers 201, 'error' fails, 'stall' never progresses, a number
// answers with that status.
let script = [];
const requests = [];
class FakeXhr {
  constructor() { this.upload = {}; this.headers = {}; requests.push(this); }
  open(method, url) { Object.assign(this, { method, url }); }
  setRequestHeader(name, value) { this.headers[name] = value; }
  abort() { this.aborted = true; this.onabort?.(); }
  send(body) {
    this.body = body;
    const step = script.shift() ?? 'ok';
    if (step === 'stall') return;
    queueMicrotask(() => {
      if (this.aborted) return;
      if (step === 'error') { this.onerror?.(); return; }
      this.upload.onprogress?.({ lengthComputable: true, loaded: body.size });
      this.upload.onload?.();
      this.status = typeof step === 'number' ? step : 201;
      this.responseText = JSON.stringify(this.status === 201 ? { id: `media-${requests.length}`, filename: 'x' } : { error: 'Server busy' });
      this.onload?.();
    });
  }
}
globalThis.XMLHttpRequest = FakeXhr;
globalThis.location = { href: 'https://hiddenmessenger.com/' };
const { onCellular, retryableUpload, uploadFile, SINGLE_ATTEMPTS, STALL_MS } = await import('../src/upload.js');

const voiceNote = () => new File([new Uint8Array(200 * 1024)], 'voice.webm', { type: 'audio/webm' });

test('on mobile data anything over 1 MB goes up resumably in 1 MB pieces; on Wi-Fi as before', () => {
  assert.deepEqual(uploadPlan(5 * MIB, { cellular: true }), { ok: true, chunked: true, chunkBytes: CELLULAR_CHUNK_BYTES, chunks: 5 });
  assert.equal(uploadPlan(MIB, { cellular: true }).chunked, false, 'a 1 MB voice note is one request');
  assert.deepEqual(uploadPlan(5 * MIB), { ok: true, chunked: false, chunkBytes: UPLOAD_CHUNK_BYTES, chunks: 1 });
  assert.equal(onCellular({ type: 'cellular' }), true);
  assert.equal(onCellular({ type: 'wifi', effectiveType: '4g' }), false);
  assert.equal(onCellular({ effectiveType: '3g' }), true, 'a slow link counts too');
  assert.equal(onCellular(null), false);
});

test('what is retried: the network, a stall, the server briefly away; never a refusal or a cancel', () => {
  assert.equal(retryableUpload(new TypeError('Network error during upload.')), true);
  for (const status of [408, 429, 500, 502, 503]) assert.equal(retryableUpload(null, status), true, String(status));
  for (const status of [400, 401, 403, 413]) assert.equal(retryableUpload(null, status), false, String(status));
  assert.equal(retryableUpload(new DOMException('Cancelled', 'AbortError')), false);
});

test('a voice note whose connection drops, then whose server is briefly away, still goes on the third try', async () => {
  requests.length = 0;
  script = ['error', 503, 'ok'];
  const data = await uploadFile(voiceNote(), { receiverId: 'peer', sessionToken: 't', kind: 'voice' });
  assert.equal(requests.length, SINGLE_ATTEMPTS);
  assert.equal(data.id, 'media-3');
});

test('a refusal is not retried', async () => {
  requests.length = 0;
  script = [413];
  await assert.rejects(uploadFile(voiceNote(), { receiverId: 'peer', sessionToken: 't' }), /Server busy/);
  assert.equal(requests.length, 1);
});

test('a request with no bytes leaving for the stall limit is dropped and retried', async () => {
  requests.length = 0;
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    script = ['stall', 'ok'];
    const pending = uploadFile(voiceNote(), { receiverId: 'peer', sessionToken: 't' });
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(STALL_MS);
    assert.ok(requests[0].aborted, 'the stalled request was dropped');
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(5_000);                           // the short wait before the retry
    mock.timers.reset();
    const data = await pending;
    assert.equal(requests.length, 2);
    assert.ok(data.id);
  } finally {
    mock.timers.reset();
  }
});

test('a failed upload stays in the chat with Retry instead of disappearing', () => {
  const chat = read('src/components/ChatWindow.jsx');
  assert.ok(chat.includes("patchUpload(key, { failed: true, preparing: false, sent: 0, error: caught?.message || 'Upload failed.' });"));
  assert.ok(chat.includes('onRetry={() => retryUpload(upload.key)}'));
  assert.ok(chat.includes('preparing ??= prepare ?'), 'a retry does not compress the video again');
  const pending = read('src/components/PendingUpload.jsx');
  assert.ok(pending.includes('aria-label="Retry sending"'));
  assert.ok(pending.includes("'Not sent · Tap to retry'"));
});
