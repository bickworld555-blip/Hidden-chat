// Media sharing as on WhatsApp Business (inspected on the phone, 2026-11-14): a send preview with a caption, the
// caption in the photo's own bubble, photos and videos sent together as one album, a tiny preview carried with each
// photo for the receiver, and every picked item uploading at once with its own progress ring.
// Everything new travels inside the end-to-end encryption; the server sees none of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { innerFrom, innerOf, openedFrom } from '../src/e2e/client.js';
import { cleanThumb, THUMB_MAX_CHARS } from '../src/mediaThumb.js';
import { quoteView, resolveQuote } from '../src/replies.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const THUMB = `data:image/jpeg;base64,${'A'.repeat(800)}`;

test('caption, album and thumbnail ride inside the encryption and come out on the other side', () => {
  const inner = innerOf('emedia:abc', { caption: '  Dinner 🍲  ', album: { id: 'album12345', i: 1, n: 3 }, thumb: THUMB });
  assert.deepEqual({ cp: inner.cp, al: inner.al, th: inner.th }, { cp: 'Dinner 🍲', al: { id: 'album12345', i: 1, n: 3 }, th: THUMB });
  const opened = openedFrom(innerFrom(JSON.parse(JSON.stringify(inner))), null);
  assert.equal(opened.caption, 'Dinner 🍲');
  assert.deepEqual(opened.album, { id: 'album12345', i: 1, n: 3 });
  assert.equal(opened.thumb, THUMB);
});

test('what is not a caption, an album or a small JPEG preview is dropped', () => {
  assert.equal(innerOf('x', { caption: 'a'.repeat(5000) }).cp.length, 1024);
  for (const album of [{ id: 'short', i: 0, n: 2 }, { id: 'album12345', i: 3, n: 3 }, { id: 'album12345', i: 0, n: 1 }, { id: 'album12345', i: 0, n: 99 }, 'album']) {
    assert.equal(innerOf('x', { album }).al, undefined, JSON.stringify(album));
  }
  assert.equal(cleanThumb('data:image/png;base64,AAAA'), '', 'JPEG only');
  assert.equal(cleanThumb(`data:image/jpeg;base64,${'A'.repeat(THUMB_MAX_CHARS)}`), '', 'small only');
  assert.equal(cleanThumb('javascript:alert(1)'), '');
  assert.equal(innerFrom({ c: 'x', th: 'https://tracker.example/pixel.jpg' }).th, undefined, 'never a remote image');
});

test('the caption and the preview never travel next to the ciphertext', () => {
  const messaging = read('src/e2e/messaging.js');
  assert.match(messaging, /caption: _caption, album: _album, thumb: _thumb, \.\.\.rest \} = message;/, 'stripped from what the server receives');
  const groups = read('src/components/GroupsView.jsx');
  assert.match(groups, /rawGroupRequest\(token, path, \{ \.\.\.options, extras: undefined, body: \{ \.\.\.options\.body, content \} \}\), extras\)/);
});

test('a reply to a photo shows its preview and caption in the quote', () => {
  const messages = [{ id: 'p1', senderId: 'me', content: 'emedia:abc', thumb: THUMB, caption: 'Sunset' }];
  const view = quoteView(resolveQuote({ id: 'p1' }, messages), 'me', 'Ava');
  assert.equal(view.thumb, THUMB);
  assert.match(view.text, /Sunset$/);
  assert.equal(quoteView(resolveQuote({ id: 'p1' }, [{ ...messages[0], deleted: true }]), 'me', 'Ava').thumb, undefined);
});

test('chats send through the preview: caption in the bubble, albums, parallel uploads that keep their order', () => {
  const chat = read('src/components/ChatWindow.jsx');
  assert.ok(chat.includes('<MediaComposer files={composer.files}'), 'gallery and documents open the send preview');
  assert.match(chat, /const UPLOAD_PARALLEL = 3;/);
  assert.ok(chat.includes('sendOrderRef.current.then(() => job)'), 'messages go out in the order picked');
  assert.ok(chat.includes('{uploads.map((upload) => <PendingUpload key={upload.key}'), 'every item shows its own progress at once');
  assert.equal(/if \(caption\) sendContent\(caption\)/.test(chat), false, 'a caption is no longer a separate message');
  assert.ok(chat.includes('const albumId = visual >= 2 && !viewOnce'), 'photos and videos picked together form an album');
  assert.ok(chat.includes('isMedia && album?.length > 1 ? <MediaAlbum'), 'an album draws as one bubble');
  assert.equal(/disabled=\{busy\}/.test(chat), false, 'sending media never blocks typing or recording');
  const composer = read('src/components/MediaComposer.jsx');
  for (const label of ['Add a caption…', 'Turn on view once', 'HD media upload quality', 'Add more', 'Discard']) assert.ok(composer.includes(label), label);
});
