// Large-file transfer: resumable chunked uploads streamed to disk, and download links the browser streams to disk.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatServer } from './index.mjs';
import { MAX_TRANSFER_BYTES, PREVIEW_LIMIT_BYTES, UPLOAD_CHUNK_BYTES, uploadPlan } from '../src/transfer.js';
import { MAX_UPLOAD_BYTES } from '../src/media.js';

let service;
let directory;
let baseUrl;
let counter = 0;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-transfer-'));
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'transfer.sqlite') });
  const address = await service.listen();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
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

const auth = (session, extra = {}) => ({ Authorization: 'Bearer ' + session.token, ...extra });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function startUpload(session, receiver, body) {
  return fetch(`${baseUrl}/api/v1/uploads`, { method: 'POST', headers: auth(session, { 'Content-Type': 'application/json' }), body: JSON.stringify({ receiverId: receiver.user.id, ...body }) });
}

function putChunk(session, uploadId, offset, bytes) {
  return fetch(`${baseUrl}/api/v1/uploads/${uploadId}`, { method: 'PUT', headers: auth(session, { 'Content-Type': 'application/octet-stream', 'X-Upload-Offset': String(offset) }), body: bytes });
}

test('a file larger than one chunk is uploaded in resumable pieces and downloads byte-for-byte', async () => {
  const sender = await register('sender');
  const receiver = await register('receiver');
  const file = randomBytes(UPLOAD_CHUNK_BYTES * 2 + 12345);

  const created = await startUpload(sender, receiver, { filename: 'disk image.bin', contentType: '', byteSize: file.length });
  assert.equal(created.status, 201);
  const upload = await created.json();
  assert.equal(upload.chunkBytes, UPLOAD_CHUNK_BYTES);
  assert.equal(upload.received, 0);
  assert.equal(upload.contentType, 'application/octet-stream');

  // Wrong offset: the server reports where it actually is instead of corrupting the file.
  const wrong = await putChunk(sender, upload.uploadId, 10, file.subarray(10, 20));
  assert.equal(wrong.status, 409);
  assert.equal((await wrong.json()).received, 0);

  let offset = 0;
  while (offset < file.length) {
    const end = Math.min(offset + UPLOAD_CHUNK_BYTES, file.length);
    const response = await putChunk(sender, upload.uploadId, offset, file.subarray(offset, end));
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    offset = end;
    assert.equal(body.received, offset);
    // Resume status matches what was written.
    const status = await (await fetch(`${baseUrl}/api/v1/uploads/${upload.uploadId}`, { headers: auth(sender) })).json();
    assert.equal(status.received, offset);
  }
  // A chunk past the end is refused.
  const extra = await putChunk(sender, upload.uploadId, offset, Buffer.from('x'));
  assert.equal(extra.status, 413);

  const completed = await fetch(`${baseUrl}/api/v1/uploads/${upload.uploadId}/complete`, { method: 'POST', headers: auth(sender) });
  assert.equal(completed.status, 201);
  const media = await completed.json();
  assert.deepEqual(media, { id: upload.uploadId, filename: 'disk image.bin', contentType: 'application/octet-stream', byteSize: file.length });
  assert.equal((await fetch(`${baseUrl}/api/v1/uploads/${upload.uploadId}`, { headers: auth(sender) })).status, 404, 'the upload row is gone once it is media');

  const head = await fetch(`${baseUrl}/api/v1/media/${media.id}`, { method: 'HEAD', headers: auth(receiver) });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get('content-length')), file.length);
  const download = await fetch(`${baseUrl}/api/v1/media/${media.id}`, { headers: auth(receiver) });
  assert.equal(download.status, 200);
  assert.equal(sha(Buffer.from(await download.arrayBuffer())), sha(file));
});

test('an interrupted chunk keeps the durable prefix and the upload resumes from the reported offset', async () => {
  const sender = await register('sender');
  const receiver = await register('receiver');
  const file = randomBytes(UPLOAD_CHUNK_BYTES + 4096);
  const upload = await (await startUpload(sender, receiver, { filename: 'video.mkv', contentType: 'video/x-matroska', byteSize: file.length })).json();

  // The client sends a chunk and then dies mid-stream.
  const controller = new AbortController();
  const stream = new ReadableStream({
    start(controllerStream) {
      controllerStream.enqueue(file.subarray(0, 1024));
      setTimeout(() => controller.abort(), 60);
    },
  });
  await fetch(`${baseUrl}/api/v1/uploads/${upload.uploadId}`, { method: 'PUT', duplex: 'half', signal: controller.signal, headers: auth(sender, { 'Content-Type': 'application/octet-stream', 'X-Upload-Offset': '0' }), body: stream }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 150));

  const status = await (await fetch(`${baseUrl}/api/v1/uploads/${upload.uploadId}`, { headers: auth(sender) })).json();
  assert.ok(status.received >= 0 && status.received <= 1024, `partial bytes are reported (${status.received})`);

  let offset = status.received;
  while (offset < file.length) {
    const end = Math.min(offset + UPLOAD_CHUNK_BYTES, file.length);
    const response = await putChunk(sender, upload.uploadId, offset, file.subarray(offset, end));
    assert.equal(response.status, 200);
    offset = (await response.json()).received;
  }
  const completed = await fetch(`${baseUrl}/api/v1/uploads/${upload.uploadId}/complete`, { method: 'POST', headers: auth(sender) });
  assert.equal(completed.status, 201);
  const download = await fetch(`${baseUrl}/api/v1/media/${upload.uploadId}`, { headers: auth(sender) });
  assert.equal(sha(Buffer.from(await download.arrayBuffer())), sha(file), 'the resumed file is intact');
});

test('upload limits and ownership are enforced and abandoned uploads are discarded', async () => {
  const sender = await register('sender');
  const receiver = await register('receiver');
  const stranger = await register('stranger');
  assert.equal((await startUpload(sender, receiver, { filename: 'x', byteSize: 0 })).status, 400);
  assert.equal((await startUpload(sender, receiver, { filename: 'x', byteSize: MAX_TRANSFER_BYTES + 1 })).status, 413);
  const huge = await startUpload(sender, receiver, { filename: 'archive.7z', contentType: 'application/x-7z-compressed', byteSize: MAX_TRANSFER_BYTES });
  assert.equal(huge.status, 201, 'a 100 GB file can start uploading');
  const { uploadId } = await huge.json();
  assert.equal((await fetch(`${baseUrl}/api/v1/uploads/${uploadId}`, { headers: auth(stranger) })).status, 404, 'another user cannot see it');
  assert.equal((await putChunk(stranger, uploadId, 0, Buffer.from('nope'))).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/v1/uploads/${uploadId}/complete`, { method: 'POST', headers: auth(sender) })).status, 409, 'incomplete uploads cannot complete');

  service.db.prepare('UPDATE uploads SET updated_at = ? WHERE id = ?').run(Date.now() - 2 * 24 * 60 * 60 * 1000, uploadId);
  await service.discardStaleUploads();
  assert.equal((await fetch(`${baseUrl}/api/v1/uploads/${uploadId}`, { headers: auth(sender) })).status, 404);

  const cancelled = await (await startUpload(sender, receiver, { filename: 'c.bin', byteSize: 10 })).json();
  assert.equal((await fetch(`${baseUrl}/api/v1/uploads/${cancelled.uploadId}`, { method: 'DELETE', headers: auth(sender) })).status, 204);
  assert.equal((await fetch(`${baseUrl}/api/v1/uploads/${cancelled.uploadId}`, { headers: auth(sender) })).status, 404);

  const plan = uploadPlan(MAX_TRANSFER_BYTES);
  assert.deepEqual(plan, { ok: true, chunked: true, chunks: Math.ceil(MAX_TRANSFER_BYTES / UPLOAD_CHUNK_BYTES) });
  assert.deepEqual(uploadPlan(UPLOAD_CHUNK_BYTES), { ok: true, chunked: false, chunks: 1 });
  assert.deepEqual(uploadPlan(MAX_TRANSFER_BYTES + 1), { ok: false, reason: 'too-large' });
  assert.equal(MAX_UPLOAD_BYTES, MAX_TRANSFER_BYTES, 'the browser advertises the same limit as the server');
  assert.ok(PREVIEW_LIMIT_BYTES < MAX_TRANSFER_BYTES);
});

test('download links stream to disk without a header, honour range resume, and expire', async () => {
  const sender = await register('sender');
  const receiver = await register('receiver');
  const stranger = await register('stranger');
  const file = randomBytes(70000);
  const stored = await (await fetch(`${baseUrl}/api/v1/media?receiverId=${receiver.user.id}`, { method: 'POST', headers: auth(sender, { 'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent('report final.pdf') }), body: file })).json();

  assert.equal((await fetch(`${baseUrl}/api/v1/media/${stored.id}/link`, { method: 'POST', headers: auth(stranger) })).status, 404, 'only participants get links');
  const linkResponse = await fetch(`${baseUrl}/api/v1/media/${stored.id}/link`, { method: 'POST', headers: auth(receiver) });
  assert.equal(linkResponse.status, 200);
  const link = await linkResponse.json();
  assert.match(link.url, new RegExp(`^/api/v1/media/${stored.id}\\?dl=[A-Za-z0-9_-]+$`));
  assert.equal(link.filename, 'report final.pdf');
  assert.equal(link.byteSize, file.length);

  const plain = await fetch(baseUrl + link.url);
  assert.equal(plain.status, 200);
  assert.match(plain.headers.get('content-disposition'), /^attachment; filename="report final.pdf"/);
  assert.equal(plain.headers.get('accept-ranges'), 'bytes');
  assert.equal(sha(Buffer.from(await plain.arrayBuffer())), sha(file));

  const tail = await fetch(baseUrl + link.url, { headers: { Range: 'bytes=65536-' } });
  assert.equal(tail.status, 206, 'browser download managers resume with ranges');
  assert.equal(Buffer.compare(Buffer.from(await tail.arrayBuffer()), file.subarray(65536)), 0);

  const inline = await fetch(baseUrl + link.url + '&inline=1');
  assert.match(inline.headers.get('content-disposition'), /^inline;/);

  assert.equal((await fetch(`${baseUrl}/api/v1/media/${stored.id}?dl=forged-token`)).status, 401);
  const other = await (await fetch(`${baseUrl}/api/v1/media?receiverId=${receiver.user.id}`, { method: 'POST', headers: auth(sender, { 'X-File-Name': 'other.bin' }), body: randomBytes(10) })).json();
  assert.equal((await fetch(`${baseUrl}/api/v1/media/${other.id}${link.url.slice(link.url.indexOf('?'))}`)).status, 401, 'a link is bound to one file');
  assert.equal((await fetch(`${baseUrl}/api/v1/media/${stored.id}`)).status, 401, 'no header and no link is still refused');
});

// --- The browser upload client against the real server ------------------------------------------

import { uploadFile, uploadSizeError } from '../src/upload.js';

// uploadFile uses same-origin paths; route them to the test server and let a hook break chosen requests.
function withClientFetch(breaker = () => false) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = (input, init = {}) => {
    const url = typeof input === 'string' && input.startsWith('/') ? baseUrl + input : input;
    seen.push({ method: init.method ?? 'GET', url: String(url) });
    if (breaker(seen[seen.length - 1], seen.length)) return Promise.reject(new TypeError('Failed to fetch'));
    return original(url, init);
  };
  return { seen, restore: () => { globalThis.fetch = original; } };
}

test('uploadFile streams a multi-chunk file with progress, survives a dropped request, and the receiver gets identical bytes', async () => {
  const sender = await register('sender');
  const receiver = await register('receiver');
  const bytes = randomBytes(UPLOAD_CHUNK_BYTES * 2 + 777);
  const file = new File([bytes], 'backup.tar', { type: '' });
  let putCount = 0;
  const { seen, restore } = withClientFetch((call) => call.method === 'PUT' && ++putCount === 2);
  try {
    const progress = [];
    const result = await uploadFile(file, { receiverId: receiver.user.id, sessionToken: sender.token, onProgress: (sent, total) => progress.push([sent, total]) });
    assert.equal(result.byteSize, bytes.length);
    assert.equal(result.filename, 'backup.tar');
    assert.equal(result.contentType, 'application/x-tar');
    assert.deepEqual(progress.at(-1), [bytes.length, bytes.length]);
    assert.ok(progress.every(([sent], index) => index === 0 || sent >= progress[index - 1][0]), 'progress never goes backwards');
    assert.ok(seen.some((call) => call.method === 'GET' && call.url.includes('/api/v1/uploads/')), 'the client asked the server where to resume');
    const download = await fetch(`${baseUrl}/api/v1/media/${result.id}`, { headers: auth(receiver) });
    assert.equal(sha(Buffer.from(await download.arrayBuffer())), sha(bytes));
  } finally {
    restore();
  }
});

test('uploadFile sends small files in one request and rejects empty or oversized files before any request', async () => {
  const sender = await register('sender');
  const receiver = await register('receiver');
  const { seen, restore } = withClientFetch();
  try {
    const small = new File([randomBytes(2048)], 'note.txt', { type: 'text/plain' });
    const result = await uploadFile(small, { receiverId: receiver.user.id, sessionToken: sender.token });
    assert.equal(result.byteSize, 2048);
    assert.deepEqual(seen.map((call) => call.method), ['POST']);
    await assert.rejects(uploadFile(new File([], 'empty.bin'), { receiverId: receiver.user.id, sessionToken: sender.token }), /is empty/);
    assert.equal(seen.length, 1, 'no request for an empty file');
    assert.match(uploadSizeError('huge.iso', MAX_TRANSFER_BYTES + 1), /larger than 100 GB/);
    assert.equal(uploadSizeError('ok.iso', MAX_TRANSFER_BYTES), '');
  } finally {
    restore();
  }
});

test('cancelling an upload stops sending and frees the partial file on the server', async () => {
  const sender = await register('sender');
  const receiver = await register('receiver');
  const file = new File([randomBytes(UPLOAD_CHUNK_BYTES * 3)], 'cancel.bin');
  const controller = new AbortController();
  let uploadId = '';
  const { restore } = withClientFetch((call, count) => {
    const match = call.url.match(/\/api\/v1\/uploads\/([^/?]+)$/);
    if (match && call.method === 'PUT') {
      uploadId = match[1];
      if (count >= 3) controller.abort();
    }
    return false;
  });
  try {
    await assert.rejects(uploadFile(file, { receiverId: receiver.user.id, sessionToken: sender.token, signal: controller.signal }), (error) => error.name === 'AbortError');
    assert.ok(uploadId, 'the upload had started');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal((await fetch(`${baseUrl}/api/v1/uploads/${uploadId}`, { headers: auth(sender) })).status, 404, 'the partial upload is discarded');
  } finally {
    restore();
  }
});

test('the chat UI uploads through the resumable client and downloads stream to disk instead of into memory', async () => {
  const { readFile } = await import('node:fs/promises');
  const read = async (path) => (await readFile(new URL(path, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const chatWindow = await read('../src/components/ChatWindow.jsx');
  const renderer = await read('../src/components/MediaRenderer.jsx');
  const viewer = await read('../src/components/MediaViewer.jsx');
  assert.ok(chatWindow.includes("import { uploadFile, uploadSizeError } from '../upload.js'"));
  assert.ok(chatWindow.includes('signal: controller.signal') && chatWindow.includes('{uploads.map((upload) => <PendingUpload key={upload.key} upload={upload} onCancel={() => cancelUpload(upload.key)} />)}'), 'uploads show progress inline in the chat and can be cancelled');
  assert.doesNotMatch(chatWindow, /MAX_UPLOAD_BYTES \/ \(1024 \* 1024\)/, 'no hardcoded megabyte cap remains');
  assert.doesNotMatch(renderer + viewer, /saveBlob\(/, 'attachments are never buffered into memory to save them');
  assert.ok(renderer.includes('downloadWithProgress(id, filename, sessionToken)') && viewer.includes('downloadWithProgress(ref?.id, filename, sessionToken)'), 'downloads go through the progress manager');
  assert.ok(renderer.includes('canPreviewSize(info?.size ?? 0)'), 'previews are skipped above the preview limit');
  assert.ok(renderer.includes("requestMediaLink(id, sessionToken, { inline: true })"), 'large media streams with range requests');
});
