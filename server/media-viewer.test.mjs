import { connectAccountData } from '../src/accountData.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { clearMediaCache, loadMediaBlob, loadMediaInfo, peekMediaBlob, primeMediaBlob, registerMediaDescriptor } from '../src/media.js';
import { sealForUpload } from '../src/mediaCrypto.js';
import { useChatStore } from '../src/store.js';
import { formatViewerTimestamp } from '../src/time.js';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearMediaCache();
});

function stubMediaServer(bodies) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET' });
    const id = decodeURIComponent(String(url).split('/').pop());
    const body = bodies[id];
    if (!body) return new Response(null, { status: 404 });
    const headers = { 'Content-Type': 'image/png', 'Content-Length': String(body.length) };
    return new Response(init.method === 'HEAD' ? null : body, { status: 200, headers });
  };
  return calls;
}

test('media bytes and details are fetched once and shared by bubble, viewer, and gallery', async () => {
  const calls = stubMediaServer({ photo: new Uint8Array([1, 2, 3, 4]) });
  const first = await loadMediaBlob('photo', 'token-a');
  const progress = [];
  const second = await loadMediaBlob('photo', 'token-a', { onProgress: (value) => progress.push(value) });
  assert.equal(second, first);
  assert.deepEqual(progress, [1]);
  assert.equal(peekMediaBlob('photo', 'token-a'), first);
  assert.deepEqual(new Uint8Array(await first.arrayBuffer()), new Uint8Array([1, 2, 3, 4]));

  await loadMediaInfo('photo', 'token-a');
  const info = await loadMediaInfo('photo', 'token-a');
  assert.deepEqual(info, { contentType: 'image/png', size: 4 });
  assert.deepEqual(calls.map((call) => call.method), ['GET', 'HEAD']);
});

test('an encrypted attachment needs no HEAD round trip: type and size come from its message, bytes in one GET', async () => {
  const plain = new File([new Uint8Array(5000).fill(7)], 'pic.jpg', { type: 'image/jpeg' });
  const { upload, descriptor } = await sealForUpload(plain);
  const cipher = new Uint8Array(await upload.arrayBuffer());
  const calls = stubMediaServer({ enc1: cipher });
  registerMediaDescriptor('enc1', descriptor);
  assert.deepEqual(await loadMediaInfo('enc1', 'token-a'), { contentType: 'image/jpeg', size: 5000 });
  assert.equal(calls.length, 0, 'details without any request');
  const blob = await loadMediaBlob('enc1', 'token-a');
  assert.equal(blob.size, 5000);
  assert.deepEqual(calls.map((call) => call.method), ['GET'], 'one request for the bytes');
});

test('the sender shows what it just uploaded from memory, without reading it back', async () => {
  const calls = stubMediaServer({});
  const plain = new File([new Uint8Array([1, 2, 3])], 'mine.png', { type: 'image/png' });
  primeMediaBlob('mine', 'token-a', plain);
  assert.deepEqual(await loadMediaInfo('mine', 'token-a'), { contentType: 'image/png', size: 3 });
  assert.equal(await loadMediaBlob('mine', 'token-a'), plain);
  assert.equal(calls.length, 0);
  assert.equal(peekMediaBlob('mine', 'token-b'), null, 'per session');
});

test('the media cache is per session and cleared on sign-out', async () => {
  const calls = stubMediaServer({ photo: new Uint8Array([9]) });
  await loadMediaBlob('photo', 'token-a');
  assert.equal(peekMediaBlob('photo', 'token-b'), null, 'another session never sees cached bytes');
  await loadMediaBlob('photo', 'token-b');
  clearMediaCache();
  assert.equal(peekMediaBlob('photo', 'token-a'), null);
  await loadMediaBlob('photo', 'token-a');
  assert.equal(calls.length, 3);
});

test('failed downloads are not cached', async () => {
  const calls = stubMediaServer({});
  await assert.rejects(loadMediaBlob('gone', 'token-a'), /no longer available/);
  await assert.rejects(loadMediaBlob('gone', 'token-a'), /no longer available/);
  assert.equal(calls.length, 2);
});

test('viewer subtitle names the day like WhatsApp', () => {
  const now = new Date('2026-11-06T12:00:00Z');
  const today = new Date(2026, 10, 6, 12, 0);
  assert.equal(formatViewerTimestamp(new Date(2026, 10, 6, 2, 5), today), 'Today, 2:05 am');
  assert.equal(formatViewerTimestamp(new Date(2026, 10, 5, 23, 59), today), 'Yesterday, 11:59 pm');
  assert.equal(formatViewerTimestamp(new Date(2026, 2, 4, 14, 30), today), '4 March, 2:30 pm');
  assert.equal(formatViewerTimestamp(new Date(2025, 11, 31, 9, 0), today), '31 December 2025, 9:00 am');
  assert.equal(formatViewerTimestamp('not a date', now), '');
});

test('stars follow the account list and survive server history merges', async () => {
  const store = useChatStore;
  const message = { id: 'm1', senderId: 'peer', receiverId: '', timestamp: '2026-11-06T02:05:00Z', content: 'media:abc:photo.png', status: 'delivered' };
  store.setState({ userId: '', messages: { peer: [message] } });
  store.getState().applyCloudStars({ m1: 'peer' });
  assert.equal(store.getState().messages.peer[0].starred, true);
  store.getState().mergeHistory('peer', [{ ...message, status: 'read' }]);
  assert.equal(store.getState().messages.peer[0].starred, true, 'history from the server keeps the account star');
  assert.equal(store.getState().messages.peer[0].status, 'read');
  store.getState().applyCloudStars({});
  assert.equal(store.getState().messages.peer[0].starred, false, 'unstarred on another device');
  // Signing out forgets the account list (src/accountData.js).
  await connectAccountData(null);
});

test('media viewer exposes the WhatsApp header, menu, and reply/reaction bar', () => {
  const viewer = readFileSync(join(srcDir, 'components', 'MediaViewer.jsx'), 'utf8');
  for (const label of ['Edit', 'All media', 'Show in chat', 'Share', 'Save', 'Rotate', 'Delete']) {
    assert.ok(viewer.includes(`label: '${label}'`), `menu offers ${label}`);
  }
  for (const control of ['aria-label="Back"', "'Unstar' : 'Star'", 'aria-label="Forward"', 'aria-label="More options"', 'placeholder="Reply"', 'aria-label="Add reaction"']) {
    assert.ok(viewer.includes(control), `viewer renders ${control}`);
  }
  assert.ok(viewer.includes('createPortal('), 'viewer escapes the chat layout');
  assert.ok(viewer.includes('navigator.share'), 'Share uses the system share sheet when available');
  assert.match(readFileSync(join(srcDir, 'reactions.js'), 'utf8'), /VIEWER_REACTIONS = \['❤️', '🙏'\]/);

  const chat = readFileSync(join(srcDir, 'components', 'ChatWindow.jsx'), 'utf8');
  assert.ok(chat.includes('onOpenMedia={() => setViewerMessageId(message.id)}'), 'tapping media opens the viewer');
  assert.ok(chat.includes('onReply={(text) => replyFromViewer(viewerMessage, text)}'), 'viewer replies quote the media message');
  assert.ok(chat.includes('onReact={(emoji) => reactTo(viewerMessage, emoji)}'), 'viewer reactions use the chat reaction path');
  assert.ok(chat.includes('data-message-id={message.id}'), 'Show in chat can locate the message');
  assert.ok(!readFileSync(join(srcDir, 'components', 'MediaRenderer.jsx'), 'utf8').includes('function MediaViewer'), 'the old bubble-local viewer is gone');

  const css = readFileSync(join(srcDir, 'styles.css'), 'utf8');
  assert.match(css, /\.wa-viewer \{[^}]*z-index: 990/, 'viewer sits below modals (1000) so Forward/Delete dialogs appear over it');
  assert.ok(!css.includes('.wa-media-viewer'), 'superseded viewer styles are removed');
});
