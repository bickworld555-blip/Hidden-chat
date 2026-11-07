import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createChatServer } from './index.mjs';
import { contentDisposition, MAX_FILENAME_CHARS, resolveContentType, sanitizeFilename } from './media.mjs';
import { canOpenInBrowser, fileTypeLabel, formatFileSize, mediaKind, mediaPreviewLabel, parseMediaRef } from '../src/media.js';

let service;
let directory;
let baseUrl;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-file-test-'));
  service = createChatServer({ port: 0, databasePath: join(directory, 'test.sqlite') });
  const address = await service.listen();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function createSession(username) {
  const response = await fetch(`${baseUrl}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, dob: '1990-04-12', password: 'Correct-Horse-Battery-42!' }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

async function upload(sender, receiver, { name, type, body }) {
  const response = await fetch(`${baseUrl}/api/v1/media?receiverId=${receiver.user.id}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${sender.token}`,
      ...(type === undefined ? {} : { 'Content-Type': type }),
      'X-File-Name': encodeURIComponent(name),
    },
    body,
  });
  assert.equal(response.status, 201, await response.clone().text());
  return response.json();
}

// Decodes the RFC 8187 filename* parameter the way browsers do when saving.
function savedFilename(disposition) {
  const match = /filename\*=UTF-8''([^;]+)/.exec(disposition ?? '');
  assert.ok(match, `filename* missing from ${disposition}`);
  return decodeURIComponent(match[1]);
}

test('any file format round-trips with its original bytes, name, and type', async () => {
  const sender = await createSession('filesender');
  const receiver = await createSession('filereceiver');
  const binary = Buffer.from(Array.from({ length: 4096 }, (_, index) => (index * 37) % 256));
  const cases = [
    { name: 'photo.PNG', type: 'image/png', expected: 'image/png' },
    { name: 'report (final) – v2.pdf', type: 'application/pdf', expected: 'application/pdf' },
    { name: "app-release's.apk", type: '', expected: 'application/vnd.android.package-archive' },
    { name: 'archive.tar.gz', type: 'application/octet-stream', expected: 'application/gzip' },
    { name: 'notes.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', expected: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    { name: 'clip.mp4', type: 'video/mp4', expected: 'video/mp4' },
    { name: 'song.mp3', type: 'audio/mpeg', expected: 'audio/mpeg' },
    { name: 'data.custom-ext', type: undefined, expected: 'application/octet-stream' },
    { name: 'বাংলা ফাইল 📄.zip', type: 'application/zip', expected: 'application/zip' },
  ];

  for (const item of cases) {
    const stored = await upload(sender, receiver, { ...item, body: binary });
    assert.equal(stored.filename, item.name);
    assert.equal(stored.contentType, item.expected, item.name);
    assert.equal(stored.byteSize, binary.length);

    for (const viewer of [sender, receiver]) {
      const download = await fetch(`${baseUrl}/api/v1/media/${stored.id}`, { headers: { Authorization: `Bearer ${viewer.token}` } });
      assert.equal(download.status, 200);
      assert.equal(download.headers.get('content-type').split(';')[0], item.expected, item.name);
      assert.equal(savedFilename(download.headers.get('content-disposition')), item.name);
      assert.match(download.headers.get('content-disposition'), /^attachment;/);
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), binary, `${item.name} bytes changed`);
    }
  }
});

test('HEAD reports type and size without sending the file body', async () => {
  const sender = await createSession('headsender');
  const receiver = await createSession('headreceiver');
  const body = Buffer.alloc(12345, 7);
  const stored = await upload(sender, receiver, { name: 'installer.apk', type: '', body });

  const head = await fetch(`${baseUrl}/api/v1/media/${stored.id}`, { method: 'HEAD', headers: { Authorization: `Bearer ${receiver.token}` } });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-type'), 'application/vnd.android.package-archive');
  assert.equal(head.headers.get('content-length'), String(body.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);

  const outsider = await createSession('headoutsider');
  const denied = await fetch(`${baseUrl}/api/v1/media/${stored.id}`, { method: 'HEAD', headers: { Authorization: `Bearer ${outsider.token}` } });
  assert.equal(denied.status, 404);
});

test('scriptable types are never served inline and downloads are sandboxed', async () => {
  const sender = await createSession('inlinesender');
  const receiver = await createSession('inlinereceiver');
  const html = await upload(sender, receiver, { name: 'page.html', type: 'text/html', body: Buffer.from('<script>alert(1)</script>') });
  const pdf = await upload(sender, receiver, { name: 'doc.pdf', type: 'application/pdf', body: Buffer.from('%PDF-1.4') });

  const htmlInline = await fetch(`${baseUrl}/api/v1/media/${html.id}?inline=1`, { headers: { Authorization: `Bearer ${receiver.token}` } });
  assert.match(htmlInline.headers.get('content-disposition'), /^attachment;/);
  assert.match(htmlInline.headers.get('content-security-policy'), /sandbox/);
  assert.equal(htmlInline.headers.get('x-content-type-options'), 'nosniff');

  const pdfInline = await fetch(`${baseUrl}/api/v1/media/${pdf.id}?inline=1`, { headers: { Authorization: `Bearer ${receiver.token}` } });
  assert.match(pdfInline.headers.get('content-disposition'), /^inline;/);
});

test('rejects malformed declared types by falling back to the extension', async () => {
  const sender = await createSession('typesender');
  const receiver = await createSession('typereceiver');
  const stored = await upload(sender, receiver, { name: 'sheet.xlsx', type: 'not a type', body: Buffer.from('x') });
  assert.equal(stored.contentType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
});

test('filenames are sanitized and long names keep their extension', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), '.._.._etc_passwd');
  assert.equal(sanitizeFilename('a\u0000b\nc.txt'), 'a_b_c.txt');
  assert.equal(sanitizeFilename('   '), 'attachment');

  const long = `${'very long name '.repeat(20)}.apk`;
  const shortened = sanitizeFilename(long);
  assert.ok(Array.from(shortened).length <= MAX_FILENAME_CHARS);
  assert.ok(shortened.endsWith('.apk'), shortened);

  const emoji = `${'📄'.repeat(200)}.pdf`;
  const emojiShortened = sanitizeFilename(emoji);
  assert.ok(emojiShortened.endsWith('.pdf'));
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(emojiShortened), 'no split surrogate pairs');
});

test('content type resolution and disposition encoding', () => {
  assert.equal(resolveContentType('image/PNG; charset=binary', 'x.bin'), 'image/png');
  assert.equal(resolveContentType('', 'Setup.EXE'), 'application/vnd.microsoft.portable-executable');
  assert.equal(resolveContentType(undefined, 'noextension'), 'application/octet-stream');
  const header = contentDisposition("it's (1) *final*.pdf");
  assert.equal(savedFilename(header), "it's (1) *final*.pdf");
  assert.ok(!/filename\*=UTF-8''[^;]*['()*]/.test(header), 'RFC 8187 value must escape reserved characters');
  assert.match(contentDisposition('ফাইল.zip'), /filename="____\.zip"/);
});

test('client media helpers classify by server type and label by name', () => {
  assert.deepEqual(parseMediaRef('media:abc:my:file.txt'), { id: 'abc', filename: 'my:file.txt' });
  assert.equal(parseMediaRef('hello'), null);
  assert.equal(mediaKind('image/png'), 'image');
  assert.equal(mediaKind('image/svg+xml'), 'file');
  assert.equal(mediaKind('video/mp4'), 'video');
  assert.equal(mediaKind('audio/mpeg'), 'audio');
  assert.equal(mediaKind('application/vnd.android.package-archive'), 'file');
  assert.equal(canOpenInBrowser('application/pdf'), true);
  assert.equal(canOpenInBrowser('text/html'), false);
  assert.equal(canOpenInBrowser('image/svg+xml'), false);
  assert.equal(fileTypeLabel('release.apk'), 'APK');
  assert.equal(fileTypeLabel('README'), 'FILE');
  assert.equal(formatFileSize(0), '0 B');
  assert.equal(formatFileSize(1536), '1.5 KB');
  assert.equal(formatFileSize(10 * 1024 * 1024), '10 MB');
  assert.equal(mediaPreviewLabel('media:1:holiday.JPG'), '📷 Photo');
  assert.equal(mediaPreviewLabel('media:1:clip.mov'), '🎥 Video');
  assert.equal(mediaPreviewLabel('media:1:app.apk'), '📄 app.apk');
});
