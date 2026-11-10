// Stage A client formats: orders, view once / video notes / made stickers, sender-made link previews, envelopes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeOrder, encodeOrderStatus, orderPreview, orderStatusIn, parseOrder, parseOrderStatus } from '../src/orders.js';
import { extrasPreview, isCustomSticker, isVideoNote, isViewOnceMedia } from '../src/mediaExtras.js';
import { previewFromHtml, sanitizePreview } from '../src/linkPreviewParse.js';
import { parseRouting, routingFor, STRUCTURED, withRoutedMedia } from '../src/e2e/envelope.js';

test('orders: totals are recomputed, statuses follow the seller (and a buyer may cancel while pending)', () => {
  const content = encodeOrder([{ item: { id: 'i1', name: 'Tea', price: 2.5, currency: 'USD' }, qty: 3 }, { item: { id: 'i2', name: 'Cake', price: 4 }, qty: 0 }], 'No sugar');
  const order = parseOrder(content);
  assert.deepEqual(order.items, [{ id: 'i1', name: 'Tea', price: 2.5, qty: 3 }]);
  assert.equal(order.total, 7.5);
  const forged = content.replace('"total":7.5', '"total":0.01');
  assert.equal(parseOrder(forged).total, 7.5, 'a claimed total is never trusted');
  assert.equal(encodeOrder([{ item: { id: 'x', name: 'x', price: 1 }, qty: 0 }]), null);
  assert.equal(orderPreview(content), '🛒 Order · 3 items');
  const messages = [
    { id: 'o1', senderId: 'buyer', content },
    { id: 's1', senderId: 'stranger', content: encodeOrderStatus('o1', 'delivered') },
  ];
  assert.equal(orderStatusIn(messages, 'o1', 'seller', 'buyer'), 'pending', 'only the seller updates an order');
  messages.push({ id: 's2', senderId: 'seller', content: encodeOrderStatus('o1', 'accepted') });
  assert.equal(orderStatusIn(messages, 'o1', 'seller', 'buyer'), 'accepted');
  messages.push({ id: 's3', senderId: 'buyer', content: encodeOrderStatus('o1', 'cancelled') });
  assert.equal(orderStatusIn(messages, 'o1', 'seller', 'buyer'), 'accepted', 'too late to cancel once accepted');
  assert.equal(parseOrderStatus(encodeOrderStatus('o1', 'bogus')), null);
  assert.ok(STRUCTURED.test(content) && STRUCTURED.test(encodeOrderStatus('o1', 'paid')), 'orders are not editable text');
});

test('view once photos, video notes and made stickers route as attachments; view once is marked once', () => {
  assert.equal(routingFor('viewonce:emedia:abc:desc:photo.jpg'), 'media:abc:once');
  assert.deepEqual(parseRouting('media:abc:once'), { kind: 'media', mediaId: 'abc', once: true });
  assert.equal(routingFor('vnote:emedia:v1:desc:video-note.webm'), 'media:v1');
  assert.equal(routingFor('csticker:emedia:s1:desc:sticker.webp'), 'media:s1');
  assert.equal(withRoutedMedia('viewonce:emedia:old:desc:a.jpg', { mediaId: 'copy' }), 'viewonce:emedia:copy:desc:a.jpg');
  assert.ok(isViewOnceMedia('viewonce:media:a:b.mp4') && isVideoNote('vnote:media:a:b') && isCustomSticker('csticker:media:a:b'));
  assert.equal(extrasPreview('viewonce:media:a:clip.mp4'), '① Video');
  assert.equal(extrasPreview('viewonce:media:a:pic.jpg'), '① Photo');
  assert.equal(extrasPreview('media-opened:'), '① Opened');
  assert.equal(routingFor('reaction:🔥'), 'other');
  assert.equal(routingFor('vote:[1]'), 'other');
});

test('link previews: built from the page, sanitized before they travel inside a message', () => {
  const html = '<html><head><title>T</title><meta property="og:title" content="Hello &amp; welcome"><meta property="og:image" content="/img.png"></head></html>';
  const preview = previewFromHtml('https://example.com/post', 'https://example.com/post', html);
  assert.equal(preview.title, 'Hello & welcome');
  assert.equal(preview.image, 'https://example.com/img.png');
  const clean = sanitizePreview({ ...preview, thumbnail: 'data:image/jpeg;base64,AAAA', evil: '<script>' });
  assert.equal(clean.thumbnail, 'data:image/jpeg;base64,AAAA');
  assert.equal(clean.evil, undefined, 'unknown fields are dropped');
  assert.equal('image' in clean, false, 'remote image URLs never travel (recipients would fetch them)');
  assert.equal(sanitizePreview({ ...preview, thumbnail: 'https://tracker.example/pixel.gif' }).thumbnail, '', 'only small inline thumbnails');
  assert.equal(sanitizePreview(null), null);
});
