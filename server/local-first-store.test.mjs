// The phone's local-first store: SQLite encrypted with SQLCipher (config), and what goes into its search index.
import test from 'node:test';
import assert from 'node:assert/strict';
import { androidConfig } from '../scripts/configure-android.mjs';
import { searchableText } from '../src/sqliteMessageDb.js';

test('the Android app keeps its history in SQLite encrypted with SQLCipher', () => {
  const config = androidConfig('https://example.com/');
  assert.equal(config.plugins.CapacitorSQLite.androidIsEncryption, true);
});

test('the search index holds readable words only: text, and an attachment name; never ciphertext', () => {
  assert.equal(searchableText({ content: 'Dinner at eight?' }), 'Dinner at eight?');
  assert.equal(searchableText({ content: 'media:abc:Holiday%20plan.pdf' }), 'Holiday plan.pdf');
  assert.equal(searchableText({ content: 'voice:abc:12' }), '');
  assert.equal(searchableText({ content: 'e2e2:text|{"v":2}' }), '');
  assert.equal(searchableText({ content: 'secret', e2eError: 'missing-key' }), '');
});

test('activating the account that is already active keeps its loaded chats; another account starts empty', async () => {
  const { useChatStore } = await import('../src/store.js');
  const message = { id: 'm1', senderId: 'ava', receiverId: 'me', timestamp: '2026-11-12T10:00:00.000Z', content: 'kept' };
  useChatStore.setState({ userId: 'me', chats: [{ id: 'ava' }], messages: { ava: [message] } });
  useChatStore.getState().setUserId('me'); // e.g. signing out another account echoes back to this one
  assert.deepEqual(useChatStore.getState().messages.ava, [message]);
  useChatStore.getState().setUserId('someone-else');
  assert.deepEqual(useChatStore.getState().messages, {});
});

test('the group list and a group\'s details are kept on the device, per account, for offline display', async () => {
  await import('fake-indexeddb/auto');
  const { cachedGroupDetails, cachedGroups, saveGroupDetails, saveGroups } = await import('../src/groupCache.js');
  assert.equal(await cachedGroups('me'), null, 'nothing kept yet');
  const list = [{ id: 'g1', name: 'Dj', memberCount: 3, lastMessageAt: '2026-11-10T09:00:00.000Z' }];
  await saveGroups('me', list);
  await saveGroupDetails('me', 'g1', { id: 'g1', name: 'Dj', members: [{ id: 'me' }, { id: 'ava' }] });
  assert.deepEqual(await cachedGroups('me'), list);
  assert.equal((await cachedGroupDetails('me', 'g1')).name, 'Dj');
  assert.equal(await cachedGroups('someone-else'), null, 'another account on the device does not see them');
  assert.equal(await cachedGroupDetails('me', 'unknown'), null);
});

test('a full backup reads every message saved on the device, not only the newest ones held in memory', async () => {
  await import('fake-indexeddb/auto');
  const { useChatStore, loadAllSavedMessages } = await import('../src/store.js');
  const messages = Array.from({ length: 6 }, (_, index) => ({ id: `full-${index}`, senderId: 'ava', receiverId: 'full-owner', timestamp: new Date(Date.UTC(2026, 10, 1, 9, index)).toISOString(), content: `m${index}` }));
  const group = [{ id: 'g-1', senderId: 'ava', groupId: 'g1', createdAt: Date.UTC(2026, 10, 1), timestamp: new Date(Date.UTC(2026, 10, 1)).toISOString(), content: 'in the group' }];
  useChatStore.getState().setUserId('full-owner');
  await useChatStore.getState().hydrateMessages('full-owner');
  useChatStore.setState({ chats: [{ id: 'ava' }], messages: { ava: messages, 'group:g1': group } });
  await useChatStore.getState().persistMessages('full-owner');
  assert.equal((await loadAllSavedMessages('full-owner')).ava.length, 6, 'written to the device store');
  // A later start: memory holds only what was loaded (here, nothing yet but a new message), the rest stays on disk.
  useChatStore.getState().setUserId('');
  useChatStore.getState().setUserId('full-owner');
  useChatStore.setState({ chats: [{ id: 'ava' }], messages: { ava: [{ ...messages[5], id: 'full-new', content: 'new' }] } });
  const all = await loadAllSavedMessages('full-owner');
  assert.equal(all.ava.length, 7, 'the six saved earlier and the new one');
  assert.equal(all['group:g1'][0].content, 'in the group');
});

test('restoring keeps group chat history, including the separate group list of older backup files', async () => {
  const { useChatStore } = await import('../src/store.js');
  useChatStore.setState({ userId: 'restorer', chats: [{ id: 'ava' }], messages: {}, callLogs: [] });
  const at = (minute) => new Date(Date.UTC(2026, 10, 1, 9, minute)).toISOString();
  const result = useChatStore.getState().restoreBackup({
    kind: 'chats', chats: [{ id: 'ava' }],
    messages: { ava: [{ id: 'd1', timestamp: at(1), content: 'direct' }], 'group:g1': [{ id: 'g1-a', timestamp: at(2), content: 'group, new format' }] },
    groups: [{ id: 'g2', name: 'Old', messages: [{ id: 'g2-a', createdAt: Date.UTC(2026, 10, 1, 9, 3), content: 'group, old format' }] }],
  });
  assert.equal(result.addedMessages, 3);
  const state = useChatStore.getState();
  assert.equal(state.messages['group:g1'][0].content, 'group, new format');
  assert.equal(state.messages['group:g2'][0].timestamp, at(3));
});
