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
