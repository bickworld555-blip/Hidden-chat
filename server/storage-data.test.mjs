// Settings › Storage and data: Manage storage (stored files by chat), Network usage (counters by kind), Media
// auto-download (rules per connection), and App language's "device's language" choice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LARGE_ITEM_BYTES, OTHER_ROW_ID, attachmentOf, sortItems, storageBreakdown } from '../src/storageUsage.js';
import { addUsage, emptyUsage, normalizeUsage, transportBytes, usageTotals } from '../src/networkUsage.js';
import { allowsAutoDownload, autoDownloadKind, networkFromConnection } from '../src/autoDownload.js';
import { deviceLanguage } from '../src/i18n.js';

const MB = 1024 * 1024;

test('manage storage: stored files by chat, largest first; a shared file counts once; the rest is Other', () => {
  const stored = [
    { id: 'p1', size: 2 * MB, contentType: 'image/jpeg', storedAt: 1 },
    { id: 'v1', size: 40 * MB, contentType: 'video/mp4', storedAt: 2 },
    { id: 'a1', size: 30_000, contentType: 'audio/ogg', storedAt: 3 },
    { id: 's1', size: 6 * MB, contentType: 'image/jpeg', storedAt: 4 },
  ];
  const chats = [
    { id: 'ava', name: 'Ava', kind: 'chat', messages: [{ content: 'hello', at: 1 }, { content: 'media:p1:beach.jpg', at: 5 }, { content: 'voice:a1:12', at: 6 }] },
    { id: 'group:g', name: 'Hikers', kind: 'group', messages: [{ content: 'media:v1:trail.mp4', at: 7 }, { content: 'media:p1:beach.jpg', at: 8 }, { content: 'media:gone:x.pdf', at: 9 }] },
  ];
  const { total, rows, large } = storageBreakdown({ stored, chats });
  assert.equal(total, 48 * MB + 30_000);
  assert.deepEqual(rows.map((row) => [row.id, row.bytes]), [['group:g', 40 * MB], [OTHER_ROW_ID, 6 * MB], ['ava', 2 * MB + 30_000]]);
  assert.deepEqual(rows.find((row) => row.id === 'ava').items.map((item) => [item.name, item.voice]), [['beach.jpg', false], ['Voice message', true]]);
  assert.deepEqual(large.map((item) => item.id), ['v1', 's1'], `over ${LARGE_ITEM_BYTES} bytes, largest first`);
  assert.equal(attachmentOf('just text'), null);
});

test('manage storage: a chat sorts by largest, newest or oldest', () => {
  const items = [{ id: 'a', size: 5, at: 3 }, { id: 'b', size: 9, at: 1 }, { id: 'c', size: 1, at: 2 }];
  assert.deepEqual(sortItems(items, 'largest').map((item) => item.id), ['b', 'a', 'c']);
  assert.deepEqual(sortItems(items, 'newest').map((item) => item.id), ['a', 'c', 'b']);
  assert.deepEqual(sortItems(items, 'oldest').map((item) => item.id), ['b', 'c', 'a']);
});

test('network usage: counters by kind, totals, damaged values repaired, unknown kinds ignored', () => {
  let usage = emptyUsage(100);
  usage = addUsage(usage, 'media', { sent: 2000, received: 500 });
  usage = addUsage(usage, 'calls', { sent: 10, received: 20, outgoing: 1 });
  usage = addUsage(usage, 'messages', { sent: 300, countSent: 1 });
  usage = addUsage(usage, 'calls', { sent: -5, received: Number.NaN });
  assert.equal(addUsage(usage, 'bogus', { sent: 1 }), usage);
  assert.deepEqual(usageTotals(usage), { sent: 2310, received: 520 });
  assert.equal(usage.calls.outgoing, 1);
  assert.equal(usage.messages.countSent, 1);
  const repaired = normalizeUsage({ since: 5, media: { sent: '7', received: -1 }, junk: { sent: 9 } });
  assert.equal(repaired.since, 5);
  assert.deepEqual(repaired.media, { sent: 7, received: 0 });
  assert.equal(repaired.junk, undefined);
});

test('network usage: call bytes from WebRTC stats (transport entries, else the selected candidate pair)', () => {
  const report = (stats) => ({ forEach: (fn) => stats.forEach(fn) });
  assert.deepEqual(transportBytes(report([{ type: 'transport', bytesSent: 100, bytesReceived: 250 }, { type: 'candidate-pair', selected: true, state: 'succeeded', bytesSent: 999 }])), { sent: 100, received: 250 });
  assert.deepEqual(transportBytes(report([{ type: 'candidate-pair', nominated: true, state: 'succeeded', bytesSent: 40, bytesReceived: 60 }, { type: 'candidate-pair', state: 'failed', bytesSent: 5 }])), { sent: 40, received: 60 });
  assert.deepEqual(transportBytes(null), { sent: 0, received: 0 });
});

test('media auto-download: WhatsApp defaults per connection; voice always; nothing while offline', () => {
  const rules = { mobile: ['photos'], wifi: ['photos', 'audio', 'videos', 'documents'], roaming: [] };
  assert.equal(autoDownloadKind('image/png'), 'photos');
  assert.equal(autoDownloadKind('video/mp4'), 'videos');
  assert.equal(autoDownloadKind('audio/mpeg'), 'audio');
  assert.equal(autoDownloadKind('application/pdf'), 'documents');
  assert.equal(allowsAutoDownload({ kind: 'photos', network: 'mobile', rules }), true);
  assert.equal(allowsAutoDownload({ kind: 'videos', network: 'mobile', rules }), false);
  assert.equal(allowsAutoDownload({ kind: 'documents', network: 'wifi', rules }), true);
  assert.equal(allowsAutoDownload({ kind: 'photos', network: 'roaming', rules }), false);
  assert.equal(allowsAutoDownload({ kind: 'audio', network: 'roaming', rules, voice: true }), true, 'voice messages always');
  assert.equal(allowsAutoDownload({ kind: 'audio', network: 'none', rules, voice: true }), false);
  assert.equal(networkFromConnection({ type: 'cellular' }), 'mobile');
  assert.equal(networkFromConnection({ type: 'wifi' }), 'wifi');
  assert.equal(networkFromConnection(undefined), 'wifi', 'computers without the API');
  assert.equal(networkFromConnection({ type: 'wifi' }, false), 'none');
});

test('prefetch and the photo bubble follow the auto-download rules; the native side reports roaming', () => {
  const media = readFileSync(new URL('../src/media.js', import.meta.url), 'utf8');
  assert.match(media, /if \(!\(await mayAutoDownload\(info\?\.contentType, \{ voice \}\)\)\) return false;/);
  const renderer = readFileSync(new URL('../src/components/MediaRenderer.jsx', import.meta.url), 'utf8');
  assert.match(renderer, /\(await isStoredLocally\(id\)\) \|\| \(await mayAutoDownload\(info\?\.contentType\)\)/);
  const plugin = readFileSync(new URL('../android/app/src/main/java/io/github/bickworld555/hiddenchat/HiddenNativePlugin.java', import.meta.url), 'utf8');
  assert.match(plugin, /NET_CAPABILITY_NOT_ROAMING\) \? "mobile" : "roaming"/);
  const manifest = readFileSync(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8');
  assert.match(manifest, /android\.permission\.ACCESS_NETWORK_STATE/);
});

test('app language: the device language when the app has it, else English', () => {
  assert.equal(deviceLanguage('bn-BD'), 'bn');
  assert.equal(deviceLanguage('es-419'), 'es');
  assert.equal(deviceLanguage('fr-FR'), 'en');
  assert.equal(deviceLanguage(undefined), 'en');
});
