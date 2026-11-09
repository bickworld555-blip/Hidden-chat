// WhatsApp parity: PDF page counts on document cards, "Open with" on the phone, status rings in the chat list,
// the status viewer header, and the round quick-forward button beside media.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { pdfPageCount } from './pdfPages.mjs';
import { statusRingsFrom } from '../src/store.js';

const root = new URL('../', import.meta.url);
const source = (path) => readFile(new URL(path, root), 'utf8');

test('PDF page count: plain page tree, compressed object streams, and not-a-PDF', () => {
  const plain = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R >> endobj\n%%EOF', 'latin1');
  assert.equal(pdfPageCount(plain), 2);
  // A nested /Pages node has a smaller count; the root's is the document's.
  const nested = Buffer.from('%PDF-1.4\n2 0 obj << /Type /Pages /Count 7 /Kids [5 0 R] >> endobj\n5 0 obj << /Count 3 /Type /Pages /Parent 2 0 R >> endobj\n', 'latin1');
  assert.equal(pdfPageCount(nested), 7);
  const objectStream = deflateSync(Buffer.from('<< /Type /Catalog /Pages 2 0 R >> << /Type /Pages /Kids [3 0 R] /Count 1 >>', 'latin1'));
  const compressed = Buffer.concat([
    Buffer.from('%PDF-1.5\n7 0 obj << /Type /ObjStm /N 2 /First 10 /Filter /FlateDecode /Length ' + objectStream.length + ' >>\nstream\n', 'latin1'),
    objectStream,
    Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1'),
  ]);
  assert.equal(pdfPageCount(compressed), 1);
  assert.equal(pdfPageCount(Buffer.from('PK\u0003\u0004 not a pdf', 'latin1')), null);
  assert.equal(pdfPageCount(Buffer.from('%PDF-1.7\n% no page tree', 'latin1')), null);
});

test('document cards read "1 page • 0.94 MB • PDF" and open with the phone\'s chooser', async () => {
  const server = await source('server/index.mjs');
  assert.ok(server.includes("if (pages) response.set('X-Page-Count', String(pages));"));
  assert.ok(server.includes("'Access-Control-Expose-Headers': 'Content-Disposition, Content-Length, X-Page-Count'"));
  const renderer = await source('src/components/MediaRenderer.jsx');
  assert.ok(renderer.includes("return [pages ? `${pages} page${pages === 1 ? '' : 's'}` : '', size, label].filter(Boolean).join(' • ');"));
  assert.ok(renderer.includes('openMediaOnPhone({ id, filename, contentType, sessionToken })'));
  const plugin = await source('android/app/src/main/java/io/github/bickworld555/hiddenchat/HiddenNativePlugin.java');
  assert.match(plugin, /public void openMedia\(PluginCall call\)[\s\S]*?FileProvider\.getUriForFile[\s\S]*?Intent\.ACTION_VIEW[\s\S]*?FLAG_GRANT_READ_URI_PERMISSION[\s\S]*?Intent\.createChooser\(view, "Open with"\)/);
  const manifest = await source('android/app/src/main/AndroidManifest.xml');
  assert.match(manifest, /<queries>\s*<intent>\s*<action android:name="android\.intent\.action\.VIEW" \/>\s*<data android:mimeType="\*\/\*" \/>/, 'Android 11+ can only see document apps that the manifest asks about');
  const paths = await source('android/app/src/main/res/xml/file_paths.xml');
  assert.ok(paths.includes('<cache-path'), 'the cached copy is shareable through the FileProvider');
});

test('status rings: green for a status I have not seen, grey once seen, none without a status', async () => {
  assert.deepEqual(statusRingsFrom({ others: [
    { user: { id: 'ava' }, statuses: [{ id: 1 }], allSeen: false },
    { user: { id: 'ben' }, statuses: [{ id: 2 }], allSeen: true },
    { user: { id: 'cy' }, statuses: [], allSeen: false },
  ] }), { ava: 'new', ben: 'seen' });
  assert.deepEqual(statusRingsFrom(null), {});
  const list = await source('src/components/ChatsList.jsx');
  assert.ok(list.includes("statusRings?.[chat.id] ? `has-status status-${statusRings[chat.id]}` : ''"));
  const css = await source('src/styles.css');
  assert.ok(css.includes('.wa-row-avatar-wrap.has-status > .avatar { box-shadow: 0 0 0 2px var(--wa-bg, #fff), 0 0 0 4px #25d366; }'));
});

test('status viewer header: the photo stays round (only the name column stretches)', async () => {
  const view = await source('src/components/UpdatesView.jsx');
  assert.ok(view.includes('<span className="status-viewer-title">'));
  const css = await source('src/styles.css');
  assert.ok(!css.includes('.status-viewer-head > span {'), 'the avatar is a span too and must not be stretched');
  assert.ok(css.includes('.status-viewer-head .avatar { flex: none; }'));
  // Full screen above the tab bar (z-index 100), rendered at the page root rather than inside the Updates panel.
  assert.ok(css.includes('.status-viewer { position: fixed; inset: 0; z-index: 200;') && css.includes('.status-compose { position: fixed; inset: 0; z-index: 200;'));
  assert.ok(view.includes('{viewing && createPortal(') && view.includes('{composing && createPortal('));
});

test('a round forward button sits beside photos, videos, documents and voice notes', async () => {
  const chat = await source('src/components/ChatWindow.jsx');
  assert.ok(chat.includes('&& (isMedia || (isVoice && !voice?.viewOnce));'), 'not for view once voice notes');
  assert.ok(chat.includes('forward: (message) => setForwardSource([message]),'));
  const css = await source('src/styles.css');
  assert.ok(css.includes('.message-line.mine .wa-quick-forward { order: -1; }'), 'left of your own bubbles');
});
