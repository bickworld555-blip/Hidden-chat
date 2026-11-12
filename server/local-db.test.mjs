// The phone's local database, run for real: the same schema, migrations and queries as the Android app
// (src/sqliteMessageDb.js), on Node's built-in SQLite through an adapter shaped like the Capacitor plugin's
// connection. SQLCipher's encryption is the plugin's; everything else here is the app's own SQL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pluginLikeConnection } from './sqliteTestDb.mjs';
import { MIGRATIONS, SCHEMA_VERSION, alignSearchIndex, createRecordTables, createSqliteMessageDb, migrate } from '../src/sqliteMessageDb.js';

const tablesOf = async (connection) => (await connection.query("SELECT name FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name")).values.map((row) => row.name);
const versionOf = async (connection) => (await connection.query('PRAGMA user_version')).values[0].user_version;

test('a new phone gets the whole schema, recorded as the newest version', async () => {
  const connection = pluginLikeConnection();
  assert.deepEqual(await migrate(connection), { from: 0, to: SCHEMA_VERSION });
  assert.equal(await versionOf(connection), SCHEMA_VERSION);
  for (const name of ['messages', 'messages_chat', 'messages_owner_ts', 'media', 'cache', 'kv', 'prefs']) assert.ok((await tablesOf(connection)).includes(name), name);
  assert.deepEqual(await migrate(connection), { from: SCHEMA_VERSION, to: SCHEMA_VERSION }, 'running it again changes nothing');
});

test('a phone from before versions were recorded keeps every message through the upgrade', async () => {
  const connection = pluginLikeConnection();
  // Version 1 as it shipped: the tables, no version recorded (user_version 0), with history in it.
  await connection.execute(`${MIGRATIONS[0].statements.join(';\n')};`, true);
  await connection.run("INSERT INTO messages(owner, chat, id, ts, status, body) VALUES ('me', 'ava', 'm1', 1, 'read', '{\"id\":\"m1\",\"content\":\"kept\"}')");
  await connection.run("INSERT INTO media(id, local_file_path, stored_at) VALUES ('f1', 'media/f1.bin', 1)");
  assert.equal(await versionOf(connection), 0);
  assert.deepEqual(await migrate(connection), { from: 0, to: SCHEMA_VERSION });
  assert.equal((await connection.query('SELECT body FROM messages')).values[0].body, '{"id":"m1","content":"kept"}');
  assert.equal((await connection.query('SELECT count(*) AS n FROM media')).values[0].n, 1);
});

test('a step that fails leaves the database exactly as it was, and the next start can try again', async () => {
  const connection = pluginLikeConnection();
  await migrate(connection, MIGRATIONS.slice(0, 2));
  assert.equal(await versionOf(connection), 2);
  const broken = [...MIGRATIONS, { version: SCHEMA_VERSION + 1, statements: ['CREATE TABLE extra_ok (x)', 'CREATE TABLE messages (dup)'] }];
  await assert.rejects(migrate(connection, broken));
  assert.equal(await versionOf(connection), SCHEMA_VERSION, 'the good steps before it are kept');
  assert.equal((await tablesOf(connection)).includes('extra_ok'), false, 'nothing of the failed step is left half-done');
  // A database from a newer app is left alone (every step only adds).
  await connection.execute(`PRAGMA user_version = ${SCHEMA_VERSION + 5};`, false);
  assert.deepEqual(await migrate(connection), { from: SCHEMA_VERSION + 5, to: SCHEMA_VERSION + 5 });
});

test('records and settings: JSON in, the same out; many at once are all-or-nothing', async () => {
  const connection = pluginLikeConnection();
  await migrate(connection);
  const tables = createRecordTables(async () => connection);
  await tables.kvSet('relay:contacts:me', [{ id: 'ava', name: 'Ava' }]);
  assert.deepEqual(await tables.kvGet('relay:contacts:me'), [{ id: 'ava', name: 'Ava' }]);
  assert.equal(await tables.kvGet('missing'), undefined);
  await tables.kvPutMany([['a', 1], ['b', { c: true }]]);
  assert.deepEqual([await tables.kvGet('a'), await tables.kvGet('b')], [1, { c: true }]);
  await tables.kvDelete('a');
  assert.equal(await tables.kvGet('a'), undefined);
  await assert.rejects(tables.kvPutMany([['x', 1], ['y', undefined]]), 'a bad row (no value) fails the whole batch');
  assert.equal(await tables.kvGet('x'), undefined, '…and nothing of it is kept');
  await tables.prefsPutMany([['relay:theme', 'dark'], ['hm:language', 'bn']]);
  await tables.prefsSet('relay:theme', 'light');
  await tables.prefsDelete('hm:language');
  assert.deepEqual(await tables.prefsAll(), [['relay:theme', 'light']]);
});

// --- 100,000 messages ---------------------------------------------------------------------------------------

function seed(connection, { messages, chats }) {
  const insert = connection.raw.prepare('INSERT INTO messages(owner, chat, id, ts, status, body) VALUES (?, ?, ?, ?, ?, ?)');
  const fts = connection.raw.prepare('INSERT INTO messages_fts(text, owner, id) VALUES (?, ?, ?)');
  connection.raw.exec('BEGIN');
  for (let index = 0; index < messages; index += 1) {
    const chat = `chat-${index % chats}`;
    const id = `m-${index}`;
    const content = index % 1000 === 0 ? `needle ${index} haystack` : `message number ${index} in ${chat}`;
    const body = JSON.stringify({ id, senderId: index % 2 ? 'me' : chat, receiverId: index % 2 ? chat : 'me', timestamp: new Date(1_700_000_000_000 + index * 1000).toISOString(), content, status: 'read' });
    insert.run('me', chat, id, 1_700_000_000_000 + index * 1000, 'read', body);
    fts.run(content, 'me', id);
  }
  connection.raw.exec('COMMIT');
}

test('100,000 messages: opening, scrolling back, searching and saving stay fast', async () => {
  const connection = pluginLikeConnection();
  await migrate(connection);
  connection.raw.exec('CREATE VIRTUAL TABLE messages_fts USING fts5(text, owner UNINDEXED, id UNINDEXED)');
  // Seeded the way older app versions indexed (rows not keyed by rowid), then upgraded as a phone is at start-up.
  seed(connection, { messages: 100_000, chats: 200 });
  const store = createSqliteMessageDb({ connect: async () => connection, fts: () => true });
  const time = async (work) => { const started = performance.now(); const result = await work(); return { result, ms: performance.now() - started }; };
  const rebuilt = await time(() => alignSearchIndex(connection));
  console.log(`  one-time search index rebuild of 100,000: ${rebuilt.ms.toFixed(0)} ms`);
  assert.equal(rebuilt.result, true);
  assert.equal(await alignSearchIndex(connection), false, 'only once');

  assert.equal(await store.count('me'), 100_000);
  const wide = await time(() => store.loadRecent('me', 500));
  console.log(`  start-up with a 500-per-chat window: ${Object.values(wide.result.messages).reduce((sum, list) => sum + list.length, 0)} messages in ${wide.ms.toFixed(0)} ms`);
  const opened = await time(() => store.loadRecent('me', 50));
  const loadedCount = Object.values(opened.result.messages).reduce((sum, list) => sum + list.length, 0);
  console.log(`  start-up window: ${loadedCount} messages from 200 chats in ${opened.ms.toFixed(0)} ms`);
  assert.equal(Object.keys(opened.result.messages).length, 200);
  assert.equal(opened.result.messages['chat-7'].length, 50);
  assert.ok(opened.result.more.has('chat-7'), 'older messages are known to exist');
  assert.equal(opened.result.messages['chat-7'].at(-1).id, 'm-99807', 'the newest message of the chat is last');

  const older = await time(() => store.loadOlder('me', 'chat-7', 1_700_000_000_000 + 99_807 * 1000 - 50 * 200 * 1000, 50));
  console.log(`  scroll back one page: ${older.ms.toFixed(1)} ms`);
  assert.equal(older.result.messages.length, 50);

  const found = await time(() => store.search('me', 'needle'));
  console.log(`  search over 100,000: ${found.result.length} hits in ${found.ms.toFixed(1)} ms`);
  assert.equal(found.result.length, 100);
  assert.ok(found.result.every((row) => /^m-\d*000$|^m-0$/.test(row.id)), 'the rebuilt index points at the right messages');

  const saved = await time(() => store.apply('me', { puts: Array.from({ length: 500 }, (_, index) => ({ chat: 'chat-1', message: { id: `new-${index}`, timestamp: new Date().toISOString(), content: `fresh ${index}` } })) }));
  console.log(`  saving 500 new messages: ${saved.ms.toFixed(0)} ms`);
  assert.equal(await store.count('me'), 100_500);
  assert.equal((await store.search('me', 'fresh', 1000)).length, 500, 'new messages are searchable at once');
  // Edited, deleted, cleared: the index follows.
  await store.apply('me', { puts: [{ chat: 'chat-1', message: { id: 'new-1', timestamp: new Date().toISOString(), content: 'changed words' } }], deletes: ['new-2'] });
  assert.deepEqual((await store.search('me', 'changed')).map((row) => row.id), ['new-1']);
  assert.equal((await store.search('me', 'fresh', 1000)).some((row) => row.id === 'new-1' || row.id === 'new-2'), false);
  const cleared = await time(() => store.apply('me', { clearChats: ['chat-3'] }));
  console.log(`  clearing a chat of 500: ${cleared.ms.toFixed(0)} ms`);
  assert.equal((await store.search('me', 'chat-3', 5000)).some((row) => row.chat === 'chat-3'), false, 'nothing of the cleared chat is found');
  const count = async (table) => Number((await connection.query(`SELECT count(*) AS n FROM ${table}`)).values[0].n);
  assert.equal(await count('messages_fts'), await count('messages'), 'one index row per message, none left over');

  // Generous bounds for a slow CI machine; the phone's SQLCipher adds encryption on top of these.
  assert.ok(opened.ms < 3000, `start-up window took ${opened.ms} ms`);
  assert.ok(older.ms < 200 && found.ms < 500 && saved.ms < 3000 && cleared.ms < 3000 && rebuilt.ms < 60000);
});
