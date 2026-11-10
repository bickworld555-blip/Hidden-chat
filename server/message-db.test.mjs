// The device's message store (src/messageDb.js) over a real IndexedDB implementation (fake-indexeddb): one row per
// message, indexed by chat and time; saves write only what changed; start-up reads a window; older pages on demand.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { createMessageDb, diffMessages, snapshotOf } from '../src/messageDb.js';

function freshIndexedDb() {
  const factory = new IDBFactory();
  factory.IDBKeyRange = IDBKeyRange;
  return factory;
}

const message = (id, chat, minute, extra = {}) => ({ id, senderId: chat, receiverId: 'me', timestamp: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(), content: `m${id}`, ...extra });

test('rows are sealed per message and read back by chat, newest window first, older pages on demand', async () => {
  const sealedNames = [];
  const db = createMessageDb({
    indexedDB: freshIndexedDb(),
    seal: async (name, value) => { sealedNames.push(name); return { sealed: JSON.stringify(value) }; },
    open: async (_name, record) => JSON.parse(record.sealed),
  });
  const alice = Array.from({ length: 12 }, (_, index) => ({ chat: 'alice', message: message(`a${index}`, 'alice', index) }));
  const bob = Array.from({ length: 3 }, (_, index) => ({ chat: 'bob', message: message(`b${index}`, 'bob', 100 + index) }));
  await db.apply('me', { puts: [...alice, ...bob] });
  await db.apply('other-account', { puts: [{ chat: 'alice', message: message('x1', 'alice', 5) }] });
  assert.equal(await db.count('me'), 15);
  assert.ok(sealedNames.includes('msg:me:a0'), 'each row is sealed under its own name');

  const recent = await db.loadRecent('me', 5);
  assert.deepEqual(recent.messages.alice.map((item) => item.id), ['a7', 'a8', 'a9', 'a10', 'a11'], 'newest five, oldest first');
  assert.deepEqual(recent.messages.bob.map((item) => item.id), ['b0', 'b1', 'b2']);
  assert.deepEqual([...recent.more], ['alice'], 'only alice has older rows');
  assert.equal(recent.messages.x1, undefined, 'another account’s rows are not mixed in');

  const page = await db.loadOlder('me', 'alice', Date.parse(recent.messages.alice[0].timestamp), 5);
  assert.deepEqual(page.messages.map((item) => item.id), ['a2', 'a3', 'a4', 'a5', 'a6']);
  assert.equal(page.more, true);
  const last = await db.loadOlder('me', 'alice', Date.parse(page.messages[0].timestamp), 5);
  assert.deepEqual(last.messages.map((item) => item.id), ['a0', 'a1']);
  assert.equal(last.more, false);
});

test('saving writes only changed messages; deletions and cleared chats remove rows, kept ones are rewritten', async () => {
  const db = createMessageDb({ indexedDB: freshIndexedDb() });
  const first = { alice: [message('a1', 'alice', 1), message('a2', 'alice', 2)], bob: [message('b1', 'bob', 3)] };
  let diff = diffMessages(new Map(), first);
  assert.equal(diff.puts.length, 3);
  await db.apply('me', diff);
  let saved = snapshotOf(first);

  // One new message and one reaction: exactly two rows written, nothing else touched.
  const second = { ...first, alice: [first.alice[0], { ...first.alice[1], reactions: [{ userId: 'me', emoji: '👍' }] }, message('a3', 'alice', 4)] };
  diff = diffMessages(saved, second);
  assert.deepEqual(diff.puts.map((item) => item.message.id), ['a2', 'a3']);
  assert.deepEqual([diff.deletes, diff.clearChats], [[], []]);
  await db.apply('me', diff);
  saved = snapshotOf(second);
  assert.deepEqual((await db.loadRecent('me')).messages.alice.find((item) => item.id === 'a2').reactions, [{ userId: 'me', emoji: '👍' }]);

  // Deleting a message removes its row; deleting a chat removes all of it, including rows never loaded.
  await db.apply('me', { puts: [{ chat: 'bob', message: message('b0', 'bob', 0) }] });
  const third = { alice: second.alice.filter((item) => item.id !== 'a1') };
  diff = diffMessages(saved, third);
  assert.deepEqual([diff.deletes, diff.clearChats], [['a1'], ['bob']]);
  await db.apply('me', diff);
  saved = snapshotOf(third);
  const after = (await db.loadRecent('me')).messages;
  assert.deepEqual(Object.keys(after), ['alice']);
  assert.deepEqual(after.alice.map((item) => item.id), ['a2', 'a3']);

  // Clear chat keeping one starred message: the chat's rows go, the kept one is written back.
  const kept = { alice: [third.alice[1]] };
  diff = diffMessages(saved, kept, new Set(['alice']));
  assert.deepEqual(diff.clearChats, ['alice']);
  assert.deepEqual(diff.puts.map((item) => item.message.id), ['a3']);
  await db.apply('me', diff);
  assert.deepEqual((await db.loadRecent('me')).messages.alice.map((item) => item.id), ['a3']);
});
