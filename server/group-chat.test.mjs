import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exportGroupChat, parseScheduledCall, scheduledCallContent, scheduledCallPreview, senderColor, withDaySeparators } from '../src/groupChat.js';
import { readMutedGroups, setGroupMuted } from '../src/groupPrefs.js';
import { countUnreadConversations, groupRow } from '../src/groupRows.js';
import { previewFor } from '../src/store.js';

test('scheduled calls round-trip through ordinary group message content', () => {
  const at = Date.UTC(2026, 10, 9, 15, 0);
  const content = scheduledCallContent({ title: '  Weekly catch-up ', at, mode: 'video' });
  assert.deepEqual(parseScheduledCall(content), { title: 'Weekly catch-up', at, mode: 'video' });
  assert.equal(parseScheduledCall(scheduledCallContent({ title: 'x', at, mode: 'anything' })).mode, 'audio');
  assert.equal(previewFor(content), '📅 Scheduled video call: Weekly catch-up');
  assert.equal(parseScheduledCall('call-schedule:{not json'), null);
  assert.equal(parseScheduledCall('call-schedule:{"title":5,"at":1}'), null);
  assert.equal(parseScheduledCall('hello'), null);
  assert.equal(scheduledCallPreview('hello'), null);
  assert.throws(() => scheduledCallContent({ title: ' ', at, mode: 'audio' }), /name/);
  assert.throws(() => scheduledCallContent({ title: 'x', at: Number.NaN, mode: 'audio' }), /date/);
});

test('conversation items get one day separator per calendar day', () => {
  const now = new Date(2026, 10, 8, 18, 0);
  const messages = [
    { id: 'a', createdAt: new Date(2026, 10, 7, 9, 0).getTime() },
    { id: 'b', createdAt: new Date(2026, 10, 7, 23, 0).getTime() },
    { id: 'c', createdAt: new Date(2026, 10, 8, 8, 0).getTime() },
  ];
  const items = withDaySeparators(messages, now);
  assert.deepEqual(items.map((item) => item.kind === 'day' ? item.label : item.message.id), ['Yesterday', 'a', 'b', 'Today', 'c']);
});

test('sender colours are stable per member and export names everyone', () => {
  assert.equal(senderColor('member-1'), senderColor('member-1'));
  assert.match(senderColor('member-2'), /^#[0-9a-f]{6}$/);
  const group = { name: 'Team', members: [{ id: 'me', name: 'Me' }, { id: 'ava', name: 'Ava' }] };
  const text = exportGroupChat(group, [
    { senderId: 'ava', createdAt: Date.UTC(2026, 10, 8, 10, 5), content: 'hi' },
    { senderId: 'me', createdAt: Date.UTC(2026, 10, 8, 10, 6), content: 'media:abc:photo.jpg' },
    { senderId: 'gone', createdAt: Date.UTC(2026, 10, 8, 10, 7), content: 'bye' },
  ], 'me');
  assert.equal(text, 'Chat export: Team\n[2026-11-08 10:05 UTC] Ava: hi\n[2026-11-08 10:06 UTC] You: <attachment: photo.jpg>\n[2026-11-08 10:07 UTC] Former member: bye\n');
});

test('muted groups keep a badge but leave the navigation count', () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  assert.deepEqual(setGroupMuted('me', 'g1', true, storage), ['g1']);
  assert.deepEqual(readMutedGroups('me', storage), ['g1']);
  assert.deepEqual(readMutedGroups('someone-else', storage), [], 'mutes are per account');
  const rows = [groupRow({ id: 'g1', name: 'Muted', unread: 4 }, 'me', readMutedGroups('me', storage)), groupRow({ id: 'g2', name: 'Loud', unread: 2 }, 'me', [])];
  assert.equal(rows[0].muted, true);
  assert.equal(rows[0].unread, 4);
  assert.equal(countUnreadConversations([], rows), 1);
  assert.deepEqual(setGroupMuted('me', 'g1', false, storage), []);
  values.set('hm:muted-groups:me', '{broken');
  assert.deepEqual(readMutedGroups('me', storage), []);
});
