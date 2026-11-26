// The native-bubble media classifier shared by the web→native projection (src/App.jsx nativeMessageProjection) and the
// native MessagePreview.kindOf. Phase 5 added sticker/view-once so their raw ref (not just the chat-list preview label)
// reaches the native store; a truthy kind here is the precondition for nativeMessageProjection to carry mediaSource.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeMediaKind } from '../src/nativeMediaKind.js';

test('stickers classify as sticker so the raw ref reaches the native bubble', () => {
  assert.equal(nativeMediaKind('sticker:moods/yay'), 'sticker');
  assert.equal(nativeMediaKind('sticker:hearts/love'), 'sticker');
});

test('view-once (sealed and opened markers) classify as viewonce', () => {
  assert.equal(nativeMediaKind('viewonce:emedia:key:iv:photo.jpg'), 'viewonce');
  // An opened view-once keeps the prefix removed by the consume flow (content becomes "media-opened:"), which is not a
  // viewonce ref any more — only the still-sealed form is a viewonce bubble.
  assert.equal(nativeMediaKind('media-opened:'), '');
});

test('voice notes classify as voice in both states', () => {
  assert.equal(nativeMediaKind('voice:emedia:k:iv:clip.m4a'), 'voice');
  assert.equal(nativeMediaKind('voice-opened:'), 'voice');
});

test('emedia/media are classified by extension', () => {
  assert.equal(nativeMediaKind('emedia:key:iv:photo.jpg'), 'photo');
  assert.equal(nativeMediaKind('emedia:key:iv:clip.mp4'), 'video');
  assert.equal(nativeMediaKind('emedia:key:iv:sticker.gif'), 'gif');
  assert.equal(nativeMediaKind('emedia:key:iv:song.mp3'), 'audio');
  assert.equal(nativeMediaKind('emedia:key:iv:report.pdf'), 'doc');
  assert.equal(nativeMediaKind('media:key:photo.png'), 'photo');
});

test('plain text and non-strings are not media', () => {
  assert.equal(nativeMediaKind('hello world'), '');
  assert.equal(nativeMediaKind(''), '');
  assert.equal(nativeMediaKind(null), '');
  assert.equal(nativeMediaKind(undefined), '');
  assert.equal(nativeMediaKind(42), '');
});
