import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countUnreadConversations, groupPreviewText, groupRow, mergeGroupRows, unreadBadge } from '../src/groupRows.js';
import { initialTabFromUrl, registerServiceWorker } from '../src/pwa.js';

test('group previews name the sender like a messenger chat list', () => {
  assert.equal(groupPreviewText({ lastContent: 'hi all', lastSenderId: 'me', lastSenderName: 'Me' }, 'me'), 'You: hi all');
  assert.equal(groupPreviewText({ lastContent: 'hi all', lastSenderId: 'ava', lastSenderName: 'Ava' }, 'me'), 'Ava: hi all');
  assert.equal(groupPreviewText({ lastContent: 'hi all', lastSenderId: 'gone', lastSenderName: null }, 'me'), 'hi all');
  assert.equal(groupPreviewText({ lastContent: null }, 'me'), 'No messages yet');
  assert.match(groupPreviewText({ lastContent: 'media:abc:photo.jpg', lastSenderId: 'ava', lastSenderName: 'Ava' }, 'me'), /^Ava: /);
});

test('group rows carry the server unread count and a capped badge', () => {
  const row = groupRow({ id: 'g1', name: 'Team', unread: '3', lastMessageAt: Date.UTC(2026, 10, 8), lastContent: 'x', lastSenderId: 'a', lastSenderName: 'A' }, 'me');
  assert.equal(row.kind, 'group');
  assert.equal(row.unread, 3);
  assert.equal(row.lastActivityAt, new Date(Date.UTC(2026, 10, 8)).toISOString());
  assert.equal(unreadBadge(7), '7');
  assert.equal(unreadBadge(1000), '999+');
});

test('groups merge into the chat list by recency after pinned chats', () => {
  const chats = [
    { id: 'pinned', lastActivityAt: '2026-01-01T00:00:00.000Z' },
    { id: 'new', lastActivityAt: '2026-11-08T10:00:00.000Z' },
    { id: 'old', lastActivityAt: '2026-11-01T10:00:00.000Z' },
    { id: 'empty', lastActivityAt: null },
  ];
  const groups = [{ id: 'g', kind: 'group', lastActivityAt: '2026-11-05T10:00:00.000Z' }];
  assert.deepEqual(mergeGroupRows(chats, groups, { leadingIds: ['pinned'] }).map((row) => row.id), ['pinned', 'new', 'g', 'old', 'empty']);
  assert.equal(countUnreadConversations([{ unread: 2 }, { unread: 0 }], [{ unread: 5 }]), 2);
});

test('manifest shortcuts select a bottom-navigation tab and the service worker stays out of the Android shell', () => {
  assert.equal(initialTabFromUrl('https://hiddenmessenger.com/?tab=calls'), 'calls');
  assert.equal(initialTabFromUrl('https://hiddenmessenger.com/?tab=evil'), 'chats');
  assert.equal(initialTabFromUrl('not a url'), 'chats');
  const listeners = [];
  const win = { isSecureContext: true, addEventListener: (type, listener) => listeners.push(type, listener) };
  const nav = { serviceWorker: { register: async () => ({}) } };
  assert.equal(registerServiceWorker({ navigator: nav, window: win, production: true }), true);
  assert.equal(listeners[0], 'load');
  assert.equal(registerServiceWorker({ navigator: nav, window: win, production: false }), false);
  assert.equal(registerServiceWorker({ navigator: nav, window: { ...win, isSecureContext: false }, production: true }), false);
  assert.equal(registerServiceWorker({ navigator: nav, window: { ...win, Capacitor: { isNativePlatform: () => true } }, production: true }), false);
});
