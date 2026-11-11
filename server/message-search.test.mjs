// Search across chats (src/messageSearch.js): kinds for the filters, what text matches, newest first.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { messageKind, searchAllMessages, searchableText, snippet } from '../src/messageSearch.js';

const at = (minute) => new Date(Date.UTC(2026, 10, 11, 10, minute)).toISOString();
const msg = (id, content, minute, extra = {}) => ({ id, content, timestamp: at(minute), senderId: 'a', ...extra });

test('messages are classed for the Photos, Videos, Links, Documents, Audio and Polls filters', () => {
  assert.equal(messageKind(msg('1', 'media:abc:photo.jpg', 1)), 'photos');
  assert.equal(messageKind(msg('2', 'media:abc:clip.mp4', 1)), 'videos');
  assert.equal(messageKind(msg('3', 'media:abc:report.pdf', 1)), 'docs');
  assert.equal(messageKind(msg('4', 'see https://example.com', 1)), 'links');
  assert.equal(messageKind(msg('5', 'poll:{"question":"Lunch?","options":["A","B"]}', 1)), 'polls');
  assert.equal(messageKind(msg('6', 'hello', 1)), 'text');
  assert.equal(messageKind(msg('7', 'hello', 1, { deleted: true })), 'other');
  assert.equal(searchableText(msg('8', '*Sale* _today_', 1)), 'Sale today', 'formatting markers do not get in the way');
});

test('search finds text across chats and groups, newest first; a filter alone lists that kind', () => {
  const sources = [
    { key: 'p1', name: 'Ava', messages: [msg('a1', 'Order the *sourdough*', 1), msg('a2', 'https://example.com/menu', 5)] },
    { key: 'g1', name: 'Bakers', isGroup: true, messages: [msg('g1', 'More sourdough tomorrow', 3)] },
  ];
  assert.deepEqual(searchAllMessages(sources, { query: 'SOURDOUGH' }).map((result) => result.message.id), ['g1', 'a1']);
  assert.deepEqual(searchAllMessages(sources, { filter: 'links' }).map((result) => [result.key, result.message.id]), [['p1', 'a2']]);
  assert.deepEqual(searchAllMessages(sources, { query: 'menu', filter: 'links' }).length, 1);
  assert.deepEqual(searchAllMessages(sources, {}), [], 'nothing without a query or filter');
  const part = snippet('We will bake more sourdough tomorrow morning', 'sourdough');
  assert.deepEqual([part.match, part.before.endsWith('more '), part.after.startsWith(' tomorrow')], ['sourdough', true, true]);
});
