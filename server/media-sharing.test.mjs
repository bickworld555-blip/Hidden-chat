// Media sharing as on WhatsApp Business (inspected on the phone, 2026-11-14): a send preview with a caption, the
// caption in the photo's own bubble, photos and videos sent together as one album, a tiny preview carried with each
// photo for the receiver, and every picked item uploading at once with its own progress ring.
// Everything new travels inside the end-to-end encryption; the server sees none of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { innerFrom, innerOf, openedFrom } from '../src/e2e/client.js';
import { cleanDuration, cleanPoster, cleanThumb, POSTER_MAX_CHARS, THUMB_MAX_CHARS } from '../src/mediaThumb.js';
import { formatVideoLength } from '../src/media.js';
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
  assert.match(messaging, /caption: _caption, album: _album, thumb: _thumb, poster: _poster, duration: _duration, \.\.\.rest \} = message;/, 'stripped from what the server receives');
  const groups = read('src/components/GroupsView.jsx');
  assert.match(groups, /rawGroupRequest\(token, path, \{ \.\.\.options, extras: undefined, body: \{ \.\.\.options\.body, content \} \}\), extras\)/);
});

test('a video carries its sharp poster frame and length inside the encryption', () => {
  const POSTER = `data:image/jpeg;base64,${'B'.repeat(12000)}`;
  const inner = innerOf('emedia:vid', { thumb: THUMB, poster: POSTER, duration: 42 });
  assert.deepEqual({ th: inner.th, pv: inner.pv, du: inner.du }, { th: THUMB, pv: POSTER, du: 42 });
  const opened = openedFrom(innerFrom(JSON.parse(JSON.stringify(inner))), null);
  assert.deepEqual({ poster: opened.poster, duration: opened.duration, thumb: opened.thumb }, { poster: POSTER, duration: 42, thumb: THUMB });
  assert.equal(cleanPoster(`data:image/jpeg;base64,${'A'.repeat(POSTER_MAX_CHARS)}`), '', 'bounded size');
  assert.equal(cleanPoster('https://tracker.example/frame.jpg'), '', 'never a remote image');
  for (const bad of [0, -3, 1.5, '42', 24 * 3600 + 1]) assert.equal(cleanDuration(bad), 0, String(bad));
  assert.equal(innerFrom({ c: 'x', pv: 'data:image/png;base64,AAAA', du: 'long' }).pv, undefined);
  assert.deepEqual([formatVideoLength(42), formatVideoLength(605), formatVideoLength(3725)], ['0:42', '10:05', '1:02:05']);
});

test('uploading photos and videos show themselves at full brightness with progress on the bottom edge', () => {
  const pending = read('src/components/PendingUpload.jsx');
  const css = read('src/styles.css');
  assert.ok(!/filter: brightness(.55)/.test(css), 'no darkened preview');
  assert.ok(!css.includes('.pending-upload-overlay'), 'no centred overlay');
  assert.match(css, /.pending-upload-bar { position: absolute; inset: auto 0 0 0;/, 'progress strip along the bottom edge');
  assert.ok(pending.includes("upload.kind === 'image' ? upload.previewUrl : upload.poster"), 'a video shows its own frame');
  assert.ok(!pending.includes('<video'), 'no black <video> placeholder while uploading');
  const chat = read('src/components/ChatWindow.jsx');
  assert.ok(chat.includes("const previewJob = previewKind === 'video' ? videoPreview(blob) : null;"), 'the frame is taken as soon as the video is queued');
  assert.ok(chat.includes("previewJob && kind === 'media'"), 'view once videos and video notes carry no poster');
  const renderer = read('src/components/MediaRenderer.jsx');
  assert.ok(renderer.includes('<img className="wa-video-frame" src={poster}'), 'the receiver sees the same frame');
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

test('a picked video is compressed from the phone\'s own copy, never copied across the bridge as base64 first', () => {
  const compress = read('src/videoCompress.js');
  const picked = compress.indexOf('plugin.compressPickedVideo(');
  const copy = compress.indexOf('toBase64(file.slice(');
  assert.ok(picked > 0 && copy > picked, 'the zero-copy path is tried first; the base64 copy is only the fallback');
  const java = read('android/app/src/main/java/io/github/bickworld555/hiddenchat/PickedFiles.java');
  assert.match(java, /new BridgeWebChromeClient\(bridge\)/, 'Capacitor\'s own chooser, wrapped');
  assert.match(java, /remember\(context, uris\);\s*\} catch \(RuntimeException ignored\) \{[^}]*\}\s*callback\.onReceiveValue\(uris\);/, 'the pick always reaches the web view');
  const plugin = read('android/app/src/main/java/io/github/bickworld555/hiddenchat/HiddenNativePlugin.java');
  assert.match(plugin, /VideoCompressor\.compress\(getContext\(\), uri, output,/, 'the encoder reads the content:// URI directly');
  assert.ok(read('android/app/src/main/java/io/github/bickworld555/hiddenchat/AppActivity.java').includes('PickedFiles.install(getBridge())'));
});

test('sending does not wait for the local copy, and the sender\'s bubble reads from memory', () => {
  const chat = read('src/components/ChatWindow.jsx');
  assert.ok(chat.includes('primeMediaBlob(data.id, sessionToken, plainFile);'));
  assert.ok(/storeMedia\(data\.id, file, \{[^}]*\}\)\.catch\(\(\) => \{\}\);/.test(chat), 'the device copy is written alongside, not awaited');
  assert.ok(!/await storeMedia\(data\.id, file/.test(chat));
});
