import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import WebSocket from 'ws';
import { createChatServer } from './index.mjs';
import { createPostgresDatabase, postgresOptions, postgresParameters } from './database.mjs';
import { migratePostgres } from '../scripts/migrate-postgres.mjs';
import { IMPORT_TABLES, importSqlite, planImport } from '../scripts/import-sqlite.mjs';

let engine;
const pool = {
  on() {},
  async query(sql, values) {
    if (sql.startsWith('-- Private')) {
      await engine.exec(sql);
      return { rows: [], rowCount: 0 };
    }
    const result = await engine.query(sql, values);
    return { ...result, rowCount: result.affectedRows };
  },
  async end() {},
};
before(async () => {
  engine = new PGlite();
  await engine.exec('CREATE ROLE anon; CREATE ROLE authenticated;');
});
beforeEach(async () => {
  await engine.exec('DROP SCHEMA IF EXISTS relay CASCADE');
  await migratePostgres(pool);
  await engine.exec('SET search_path TO relay');
});
after(async () => { await engine.close(); });

async function startServer(t, database = createPostgresDatabase({ pool })) {
  const directory = mkdtempSync(join(tmpdir(), 'relay-postgres-test-'));
  const service = createChatServer({ port: 0, host: '127.0.0.1', database, dataDirectory: directory });
  t.after(async () => {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const address = await service.listen();
  const url = `http://127.0.0.1:${address.port}`;
  const api = async (path, { session, body, method = 'GET', headers = {} } = {}) => {
    const response = await fetch(url + path, {
      method,
      headers: { ...(session ? { Authorization: 'Bearer ' + session.token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: response.status === 204 ? null : await response.json() };
  };
  const register = async (username) => {
    const response = await api('/api/v1/auth/register', { method: 'POST', body: { username, dob: '1990-01-01', password: 'Correct-Horse-Battery-42!' } });
    assert.equal(response.status, 201);
    return response.data;
  };
  const connect = async (session) => {
    const socket = new WebSocket(url.replace('http:', 'ws:') + '/ws', [`relay.auth.${session.token}`, 'relay.v1']);
    const buffered = [];
    socket.on('message', (raw) => buffered.push(JSON.parse(raw)));
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const wait = async (type, predicate = () => true) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const index = buffered.findIndex((item) => item.type === type && predicate(item));
        if (index >= 0) return buffered.splice(index, 1)[0];
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail(`Missing ${type}; received event types: ${buffered.map((item) => item.type).join(', ')}`);
    };
    await wait('connection:ready');
    return { socket, wait, send: (event) => socket.send(JSON.stringify(event)) };
  };
  return { service, api, register, connect, url };
}

test('schema migration is idempotent, private, RLS-enabled and case-insensitive', async () => {
  await migratePostgres(pool);
  const tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'relay'");
  assert.equal(tables.rows.length, IMPORT_TABLES.length + 1);
  const rls = await pool.query("SELECT relrowsecurity FROM pg_class JOIN pg_namespace n ON n.oid = relnamespace WHERE n.nspname = 'relay' AND relkind = 'r'");
  assert.ok(rls.rows.every((row) => row.relrowsecurity));
  for (const role of ['anon', 'authenticated']) {
    assert.equal((await pool.query(`SELECT has_schema_privilege('${role}', 'relay', 'USAGE') AS allowed`)).rows[0].allowed, false);
  }
  const database = createPostgresDatabase({ pool });
  await database.ready();
  await database.prepare('INSERT INTO users (id, username, name, initials, color, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('one', 'Mixed', 'Name', 'NM', 'blue', Date.now());
  await assert.rejects(database.prepare('INSERT INTO users (id, username, name, initials, color, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('two', 'mixed', 'Name', 'NM', 'blue', Date.now()), { code: '23505' });
});

test('PostgreSQL parameter ownership preserves literals, TLS verification and safe bigint decoding', () => {
  assert.equal(postgresParameters(`SELECT '?', "?", 'it''s ?', ? AS "camelCase"`), `SELECT '?', "?", 'it''s ?', $1 AS "camelCase"`);
  assert.throws(() => postgresParameters("SELECT 'unterminated"), /Unterminated/);
  const options = postgresOptions({ DATABASE_URL: 'postgresql://user:password@localhost:5432/postgres' });
  assert.equal(options.ssl.rejectUnauthorized, true);
  assert.equal(options.options, '-c search_path=relay');
  assert.equal(options.types.getTypeParser(20)('100000000000'), 100000000000);
  assert.throws(() => options.types.getTypeParser(20)('9007199254740992'), /safe integer/);
  assert.throws(() => postgresOptions({ DATABASE_URL: 'postgresql://user:password@localhost/db?sslmode=disable' }), /Remove sslmode/);
  assert.throws(() => postgresOptions({ DATABASE_URL: 'https://localhost' }), /PostgreSQL URI/);
  assert.throws(() => postgresOptions({ DATABASE_URL: 'postgresql://localhost/db', DATABASE_POOL_MAX: '0' }), /POOL_MAX/);
});

test('PostgreSQL public login, profile, contacts, one-use pairing and logout preserve the protocol', async (t) => {
  const { api, register } = await startServer(t);
  const owner = await register('mixed_owner');
  const peer = await register('peer_person');
  assert.equal((await api('/api/v1/auth/register', { method: 'POST', body: { username: 'MIXED_OWNER', dob: '1990-01-01', password: 'Correct-Horse-Battery-42!' } })).status, 409);
  assert.equal((await api('/api/v1/auth/login', { method: 'POST', body: { identity: '@MIXED_OWNER', password: 'Correct-Horse-Battery-42!' } })).data.user.id, owner.user.id);
  assert.equal((await api('/api/v1/me')).status, 401);
  assert.deepEqual((await api('/api/v1/contacts', { session: owner })).data, []);
  await api('/api/v1/me', { session: peer, method: 'PATCH', body: { name: 'Literal %_ Name' } });
  const search = await api('/api/v1/contacts/search?q=%25_', { session: owner });
  assert.equal(search.data[0].id, peer.user.id);
  const linked = await api('/api/v1/contacts', { session: owner, method: 'POST', body: { userId: peer.user.id } });
  assert.equal(linked.data.saved, true);
  assert.equal((await api('/api/v1/contacts', { session: owner })).data[0].disappearSeconds, 0);
  const code = (await api('/api/v1/pairing', { session: owner, method: 'POST', body: {} })).data.code;
  const claims = await Promise.all([1, 2].map(() => api(`/api/v1/pairing/${code}/claim`, { method: 'POST', body: {} })));
  assert.deepEqual(claims.map((item) => item.status).sort(), [200, 410]);
  assert.equal((await api('/api/v1/auth/logout', { session: owner, method: 'POST' })).status, 204);
  assert.equal((await api('/api/v1/me', { session: owner })).status, 401);
});

test('PostgreSQL WebSocket messages retain order, aliases, replies, receipts, reactions and chat settings', async (t) => {
  const { api, register, connect, service } = await startServer(t);
  const owner = await register('message_owner');
  const peer = await register('message_peer');
  const a = await connect(owner);
  const b = await connect(peer);
  for (const id of ['first', 'second']) a.send({ type: 'message:send', message: { id, receiverId: peer.user.id, content: id, ...(id === 'second' ? { replyTo: { id: 'first' } } : {}) } });
  const first = (await a.wait('message:ack')).message;
  const second = (await a.wait('message:ack')).message;
  assert.equal(first.id, 'first');
  assert.equal(first.receiverUsername, peer.user.username);
  assert.equal(second.replyTo.content, 'first');
  await b.wait('message:new', (event) => event.message.id === 'second');
  b.send({ type: 'message:read', messageId: 'first' });
  await a.wait('message:status', (event) => event.status === 'read');
  b.send({ type: 'message:reaction', messageId: 'first', emoji: 'ok' });
  await a.wait('message:reaction');
  const history = (await api(`/api/v1/messages?peerId=${peer.user.id}`, { session: owner })).data;
  assert.equal(history[0].status, 'read');
  assert.equal(history[0].reactions[0].userId, peer.user.id);
  assert.equal(history[1].replyTo.id, 'first');
  a.send({ type: 'chat:disappearing', peerId: peer.user.id, seconds: 86400 });
  await a.wait('chat:disappearing');
  a.send({ type: 'message:send', message: { id: 'timed', receiverId: peer.user.id, content: 'Temporary' } });
  const timed = (await a.wait('message:ack', (event) => event.message.id === 'timed')).message;
  assert.ok(timed.expiresAt);
  assert.equal(await service.expireMessages(Date.parse(timed.expiresAt) + 1), 1);
  const cleared = await api(`/api/v1/chats/${peer.user.id}/clear`, { session: owner, method: 'POST', body: { keepIds: ['first'] } });
  assert.equal(cleared.data.hidden, 2);
  assert.equal((await api(`/api/v1/messages?peerId=${peer.user.id}`, { session: owner })).data.length, 1);
  a.send({ type: 'call:signal', targetId: peer.user.id, callId: 'postgres-call', mode: 'video', signal: { type: 'offer', sdp: 'test' } });
  assert.equal((await b.wait('call:signal', (event) => event.signal.type === 'offer')).from, owner.user.id);
  a.send({ type: 'location:live', action: 'request', peerId: peer.user.id, sessionId: 'postgres-live', durationMs: 900000 });
  await b.wait('location:live', (event) => event.action === 'request');
  b.send({ type: 'location:live', action: 'accept', peerId: owner.user.id, sessionId: 'postgres-live' });
  await a.wait('location:live', (event) => event.action === 'accept');
  a.send({ type: 'location:live', action: 'update', peerId: peer.user.id, sessionId: 'postgres-live', lat: 10, lon: 20 });
  assert.equal((await b.wait('location:live', (event) => event.action === 'update')).lon, 20);
});

test('SQLite import verifies every row across batches, excludes demo and rejects a nonempty destination', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-import-test-'));
  const source = createChatServer({ port: 0, databaseUrl: null, databasePath: join(directory, 'source.sqlite'), dataDirectory: directory, seedDemo: true });
  t.after(async () => { await source.close(); rmSync(directory, { recursive: true, force: true }); });
  await source.listen();
  const insertUser = source.db.prepare('INSERT INTO users(id, username, name, initials, color, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  insertUser.run('real-a', 'real_a', 'A', 'RA', 'blue', 1700000000000);
  insertUser.run('real-b', 'real_b', 'B', 'RB', 'green', 1700000000000);
  for (let index = 0; index < 205; index += 1) {
    source.db.prepare('INSERT INTO messages(id, sender_id, receiver_id, created_at, content, status) VALUES (?, ?, ?, ?, ?, ?)').run(`message-${index}`, 'real-a', 'real-b', new Date().toISOString(), `Exact quotes ' ? ${index}`, 'sent');
  }
  source.db.prepare('INSERT INTO messages(id, sender_id, receiver_id, created_at, content, status) VALUES (?, ?, ?, ?, ?, ?)').run('demo-message', 'ava', 'real-a', new Date().toISOString(), 'Demo', 'sent');
  source.db.prepare('INSERT INTO message_reactions VALUES (?, ?, ?)').run('demo-message', 'real-a', 'ok');
  source.db.prepare('INSERT INTO media VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('large-file', 'real-a', 'real-b', '100gb.bin', 'application/octet-stream', 100000000000, 'large-file.blob', 1700000000000);
  const plan = planImport(source.db);
  assert.equal(plan.find((item) => item.table === 'users').rows, 2);
  assert.equal(plan.find((item) => item.table === 'message_reactions').rows, 0);
  await importSqlite(source.db, pool);
  assert.equal((await pool.query('SELECT count(*)::integer AS total FROM relay.messages')).rows[0].total, 205);
  assert.equal((await pool.query('SELECT byte_size FROM relay.media')).rows[0].byte_size, 100000000000);
  await assert.rejects(importSqlite(source.db, pool), /not empty/);
  assert.equal((await pool.query('SELECT count(*)::integer AS total FROM relay.messages')).rows[0].total, 205);
});

test('PostgreSQL media and profile files preserve content and download authorization', async (t) => {
  const { api, register, url } = await startServer(t);
  const owner = await register('file_owner');
  const peer = await register('file_peer');
  const bytes = Buffer.from('exact file bytes ?');
  const response = await fetch(`${url}/api/v1/media?receiverId=${peer.user.id}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'original.bin' },
    body: bytes,
  });
  assert.equal(response.status, 201);
  const media = await response.json();
  assert.equal(media.byteSize, bytes.length);
  const downloaded = await fetch(`${url}/api/v1/media/${media.id}`, { headers: { Authorization: 'Bearer ' + peer.token } });
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
  const denied = await fetch(`${url}/api/v1/media/${media.id}`);
  assert.equal(denied.status, 401);
  const upload = await api('/api/v1/uploads', { method: 'POST', session: owner, body: { receiverId: peer.user.id, byteSize: bytes.length, filename: 'chunk.bin', contentType: 'application/octet-stream' } });
  const chunk = await fetch(`${url}/api/v1/uploads/${upload.data.uploadId}`, {
    method: 'PUT', headers: { Authorization: 'Bearer ' + owner.token, 'X-Upload-Offset': '0' }, body: bytes,
  });
  assert.equal(chunk.status, 200);
  assert.equal((await api(`/api/v1/uploads/${upload.data.uploadId}/complete`, { method: 'POST', session: owner, body: {} })).status, 201);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
  const avatar = await fetch(`${url}/api/v1/me/avatar`, {
    method: 'PUT', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'image/png' }, body: png,
  });
  assert.equal(avatar.status, 200);
  assert.ok((await avatar.json()).user.avatar);
  const removed = await api('/api/v1/me/avatar', { method: 'DELETE', session: owner });
  assert.equal(removed.data.user.avatar, null);
});

test('an import boundary failure rolls back all earlier tables and rejects schema drift', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-import-failure-'));
  const source = createChatServer({ databaseUrl: null, databasePath: join(directory, 'source.sqlite'), dataDirectory: directory });
  t.after(async () => { await source.close(); rmSync(directory, { recursive: true, force: true }); });
  source.db.prepare('INSERT INTO users(id, username, name, initials, color, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('real', 'real', 'R', 'R', 'blue', 1);
  source.db.prepare('INSERT INTO contacts VALUES (?, ?, ?, ?, ?)').run('real', 'missing-user', 1, 1, 0);
  await assert.rejects(importSqlite(source.db, pool), { code: '23503' });
  assert.equal((await pool.query('SELECT count(*)::integer AS total FROM relay.users')).rows[0].total, 0);
  source.db.exec('DELETE FROM contacts');
  let verifyingUsers = false;
  const corruptReadback = {
    async query(sql, values) {
      if (sql.startsWith('DECLARE relay_import_verify')) verifyingUsers = sql.includes('FROM relay.users ');
      const result = await pool.query(sql, values);
      if (verifyingUsers && sql.startsWith('FETCH FORWARD') && result.rows.length) result.rows[0].name = 'Corrupted readback';
      return result;
    },
  };
  await assert.rejects(importSqlite(source.db, corruptReadback), /Verification failed/);
  assert.equal((await pool.query('SELECT count(*)::integer AS total FROM relay.users')).rows[0].total, 0);
  source.db.exec('ALTER TABLE users ADD COLUMN unsupported TEXT');
  assert.throws(() => planImport(source.db), /differs/);
});

test('missing PostgreSQL schema prevents startup and reports the migration command', async (t) => {
  await engine.exec('DROP SCHEMA relay CASCADE');
  const directory = mkdtempSync(join(tmpdir(), 'relay-missing-schema-'));
  const service = createChatServer({ port: 0, database: createPostgresDatabase({ pool }), dataDirectory: directory });
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  await assert.rejects(service.listen(), /npm run db:migrate/);
  assert.equal(service.server.listening, false);
});
