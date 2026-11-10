import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { after, before, beforeEach, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import WebSocket from 'ws';
import { createChatServer } from './index.mjs';
import { DATABASE_SCHEMA_VERSION, createPostgresDatabase, migratePostgres, postgresOptions, postgresParameters } from './database.mjs';
import { IMPORT_TABLES, importSqlite, planImport } from '../scripts/import-sqlite.mjs';
import { checkGroupAttachments, checkGroupContract } from './group-contract.mjs';

let engine;
const pool = {
  on() {},
  async query(sql, values) {
    // Migration files are multi-statement scripts; everything else is a single parameterised query.
    if (sql.startsWith('--')) {
      await engine.exec(sql);
      return { rows: [], rowCount: 0 };
    }
    const result = await engine.query(sql, values);
    return { ...result, rowCount: result.affectedRows };
  },
  async end() {},
  async connect() { return { query: (...args) => pool.query(...args), release() {} }; },
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
  return { service, api, register, connect, url, directory };
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

test('upgrading a version 1 database preserves data and adds private group tables', async () => {
  await engine.exec('DROP SCHEMA relay CASCADE');
  await engine.exec(readFileSync(new URL('../supabase/migrations/001_relay.sql', import.meta.url), 'utf8'));
  await engine.exec("INSERT INTO relay.users(id, username, name, initials, color, created_at) VALUES ('existing', 'existing', 'Existing', 'EX', 'blue', 1)");
  await engine.exec("INSERT INTO relay.media(id, sender_id, receiver_id, filename, content_type, byte_size, disk_name, created_at) VALUES ('old', 'existing', 'existing', 'old.bin', 'application/octet-stream', 3, 'old.blob', 1)");
  assert.equal(await migratePostgres(pool), false);
  assert.equal((await pool.query('SELECT version FROM relay.schema_version WHERE singleton = 1')).rows[0].version, DATABASE_SCHEMA_VERSION);
  assert.equal((await pool.query("SELECT name FROM relay.users WHERE id = 'existing'")).rows[0].name, 'Existing');
  assert.deepEqual((await pool.query("SELECT receiver_id, group_id FROM relay.media WHERE id = 'old'")).rows[0], { receiver_id: 'existing', group_id: null });
  const tables = await pool.query("SELECT relname, relrowsecurity FROM pg_class JOIN pg_namespace n ON n.oid = relnamespace WHERE n.nspname = 'relay' AND relname IN ('groups', 'group_members', 'group_messages', 'group_reports')");
  assert.equal(tables.rows.length, 4);
  assert.ok(tables.rows.every((row) => row.relrowsecurity));
  await assert.rejects(pool.query("INSERT INTO relay.media(id, sender_id, receiver_id, group_id, filename, content_type, byte_size, disk_name, created_at) VALUES ('bad', 'existing', NULL, NULL, 'f', 't', 1, 'bad.blob', 1)"), { code: '23514' });
  assert.equal(await migratePostgres(pool), false);
});

test('a version 2 database upgrades to the current version with its groups intact', async () => {
  await engine.exec('DROP SCHEMA relay CASCADE');
  await engine.exec(readFileSync(new URL('../supabase/migrations/001_relay.sql', import.meta.url), 'utf8'));
  await engine.exec(`BEGIN;\n${readFileSync(new URL('../supabase/migrations/002_groups.sql', import.meta.url), 'utf8')}\nCOMMIT;`);
  await engine.exec("INSERT INTO relay.users(id, username, name, initials, color, created_at) VALUES ('owner', 'owner', 'Owner', 'OW', 'blue', 1)");
  await engine.exec("INSERT INTO relay.groups(id, name, created_by, created_at) VALUES ('g1', 'Kept', 'owner', 1)");
  await engine.exec("INSERT INTO relay.group_members(group_id, user_id, role, auto_delete, joined_at) VALUES ('g1', 'owner', 'admin', 1, 1)");
  assert.equal((await pool.query('SELECT version FROM relay.schema_version WHERE singleton = 1')).rows[0].version, 2);
  assert.equal(await migratePostgres(pool), false);
  assert.equal((await pool.query('SELECT version FROM relay.schema_version WHERE singleton = 1')).rows[0].version, DATABASE_SCHEMA_VERSION);
  assert.deepEqual((await pool.query("SELECT auto_delete, last_read_at, cleared_at FROM relay.group_members WHERE group_id = 'g1'")).rows[0], { auto_delete: 1, last_read_at: 0, cleared_at: 0 });
});

test('a version 3 database gains last seen, session times and poll votes', async () => {
  await engine.exec('DROP SCHEMA relay CASCADE');
  await engine.exec(readFileSync(new URL('../supabase/migrations/001_relay.sql', import.meta.url), 'utf8'));
  for (const file of ['002_groups.sql', '003_group_media.sql']) {
    await engine.exec(`BEGIN;\n${readFileSync(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8')}\nCOMMIT;`);
  }
  await engine.exec("INSERT INTO relay.users(id, username, name, initials, color, created_at) VALUES ('old', 'old', 'Old', 'OL', 'blue', 1)");
  await engine.exec("INSERT INTO relay.sessions(token_hash, user_id, device_id, device_name) VALUES ('h', 'old', 'd', 'Browser')");
  assert.equal(await migratePostgres(pool), false);
  assert.deepEqual((await pool.query("SELECT last_seen_at, last_seen_privacy FROM relay.users WHERE id = 'old'")).rows[0], { last_seen_at: null, last_seen_privacy: 'everyone' });
  assert.deepEqual((await pool.query("SELECT device_name, created_at FROM relay.sessions WHERE token_hash = 'h'")).rows[0], { device_name: 'Browser', created_at: null });
  await assert.rejects(pool.query("UPDATE relay.users SET last_seen_privacy = 'friends' WHERE id = 'old'"), { code: '23514' });
  await pool.query("INSERT INTO relay.poll_votes(message_id, user_id, option_index, voted_at) VALUES ('m', 'old', 0, 1)");
  await assert.rejects(pool.query("INSERT INTO relay.poll_votes(message_id, user_id, option_index, voted_at) VALUES ('m', 'old', 12, 1)"), { code: '23514' });
  assert.equal((await pool.query("SELECT relrowsecurity FROM pg_class JOIN pg_namespace n ON n.oid = relnamespace WHERE n.nspname = 'relay' AND relname = 'poll_votes'")).rows[0].relrowsecurity, true);
});

test('a conflicting group migration rolls back and leaves the existing version intact', async () => {
  await engine.exec('DROP SCHEMA relay CASCADE');
  await engine.exec(readFileSync(new URL('../supabase/migrations/001_relay.sql', import.meta.url), 'utf8'));
  await engine.exec('CREATE TABLE relay.groups (original TEXT)');
  await assert.rejects(migratePostgres(pool), { code: '42P07' });
  assert.equal((await pool.query('SELECT version FROM relay.schema_version WHERE singleton = 1')).rows[0].version, 1);
  assert.equal((await pool.query("SELECT to_regclass('relay.group_members') AS name")).rows[0].name, null);
});

test('PostgreSQL group text messages enforce roles and member expiration', async (t) => {
  await checkGroupContract(await startServer(t));
});

test('PostgreSQL group attachments are member-scoped and purged with their last reference', async (t) => {
  const started = await startServer(t);
  await checkGroupAttachments({ ...started, mediaDirectory: join(started.directory, 'media') });
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

test('DATABASE_SSL_CA accepts PEM text from hosting panels or a PEM file path', (t) => {
  const certificate = rootCertificates[0];
  const fingerprint = new X509Certificate(certificate).fingerprint256;
  const trusted = (value) => {
    const { ca } = postgresOptions({ DATABASE_URL: 'postgresql://localhost/db', DATABASE_SSL_CA: value }).ssl;
    return new X509Certificate(ca).fingerprint256;
  };
  assert.equal(trusted(certificate), fingerprint);
  assert.equal(trusted(certificate.trim().replace(/\n/g, '\\n')), fingerprint);
  assert.equal(trusted(certificate.trim().replace(/\n/g, ' ')), fingerprint);
  const directory = mkdtempSync(join(tmpdir(), 'relay-ca-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'supabase-ca.crt');
  writeFileSync(path, certificate.replace(/\n/g, '\r\n'));
  assert.equal(trusted(path), fingerprint);
  assert.equal(trusted(` ${path} `), fingerprint);
  assert.equal(postgresOptions({ DATABASE_URL: 'postgresql://localhost/db', DATABASE_SSL_CA: '' }).ssl.ca, undefined);
  assert.throws(() => trusted(join(directory, 'missing.crt')), /DATABASE_SSL_CA file could not be read \(ENOENT\)/);
  assert.throws(() => trusted('-----BEGIN CERTIFICATE-----\nnot base64!\n-----END CERTIFICATE-----'), /malformed PEM/);
  writeFileSync(path, 'not a certificate');
  assert.throws(() => trusted(path), /does not contain a PEM certificate/);
});

test('an untrusted database TLS chain prevents startup with the DATABASE_SSL_CA remedy', async (t) => {
  const tlsError = Object.assign(new Error('self-signed certificate in certificate chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' });
  const failing = { on() {}, async query() { throw tlsError; }, async end() {} };
  const directory = mkdtempSync(join(tmpdir(), 'relay-untrusted-tls-'));
  const service = createChatServer({ port: 0, database: createPostgresDatabase({ pool: failing }), dataDirectory: directory });
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  await assert.rejects(service.listen(), (error) => /DATABASE_SSL_CA/.test(error.message) && error.cause === tlsError);
  assert.equal(service.server.listening, false);
});

test('database outages during requests are logged with their reason and reported as unavailable', async (t) => {
  let outage = null;
  const flaky = { ...pool, async query(...args) { if (outage) throw outage; return pool.query(...args); } };
  const { url } = await startServer(t, createPostgresDatabase({ pool: flaky }));
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  t.after(() => { console.error = originalError; });
  for (const [error, expected] of [
    [Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:5432'), { code: 'ECONNREFUSED' }), /ECONNREFUSED - connect ECONNREFUSED 10\.0\.0\.1:5432/],
    [Object.assign(new Error('self-signed certificate in certificate chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }), /SELF_SIGNED_CERT_IN_CHAIN - .*DATABASE_SSL_CA/],
    [Object.assign(new Error('password authentication failed for user "postgres"'), { code: '28P01' }), /28P01 - password authentication failed/],
  ]) {
    outage = error;
    logged.length = 0;
    const response = await fetch(`${url}/api/v1/ready`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'The service is temporarily unavailable. Please retry shortly.' });
    assert.match(logged.join('\n'), /API request failed: GET \/api\/v1\/ready/);
    assert.match(logged.join('\n'), expected);
  }
  outage = Object.assign(new Error('duplicate key value violates unique constraint: Key (handle)=(secret)'), { code: '23505' });
  logged.length = 0;
  const failed = await fetch(`${url}/api/v1/ready`);
  assert.deepEqual(await failed.json(), { error: 'The server could not complete this request. Please retry.' });
  assert.doesNotMatch(logged.join('\n'), /secret/);
  outage = null;
  assert.equal((await fetch(`${url}/api/v1/ready`)).status, 200);
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
  source.db.prepare('INSERT INTO media(id, sender_id, receiver_id, filename, content_type, byte_size, disk_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('large-file', 'real-a', 'real-b', '100gb.bin', 'application/octet-stream', 100000000000, 'large-file.blob', 1700000000000);
  source.db.prepare('INSERT INTO groups(id, name, created_by, created_at) VALUES (?, ?, ?, ?)').run('group-a', 'Example', 'real-a', 1);
  const addMember = source.db.prepare('INSERT INTO group_members(group_id, user_id, role, auto_delete, joined_at) VALUES (?, ?, ?, ?, ?)');
  addMember.run('group-a', 'real-a', 'admin', 0, 1);
  addMember.run('group-a', 'real-b', 'member', 1, 2);
  source.db.prepare('INSERT INTO group_messages(id, group_id, sender_id, created_at, content, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run('group-message', 'group-a', 'real-b', 3, 'Group text', 86400003);
  source.db.prepare('INSERT INTO media(id, sender_id, group_id, filename, content_type, byte_size, disk_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('group-file', 'real-a', 'group-a', 'g.png', 'image/png', 4, 'group-file.blob', 1700000000001);
  source.db.prepare('INSERT INTO group_reports VALUES (?, ?, ?, ?, ?)').run('report-1', 'group-a', 'real-b', 'Spam', 5);
  source.db.prepare('INSERT INTO groups(id, name, created_by, created_at) VALUES (?, ?, ?, ?)').run('demo-group', 'Demo', 'ava', 1);
  addMember.run('demo-group', 'real-a', 'member', 0, 1);
  source.db.prepare('INSERT INTO group_messages(id, group_id, sender_id, created_at, content, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run('demo-group-message', 'demo-group', 'real-a', 3, 'Excluded', null);
  source.db.prepare('INSERT INTO media(id, sender_id, group_id, filename, content_type, byte_size, disk_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('demo-file', 'real-a', 'demo-group', 'd.png', 'image/png', 4, 'demo-file.blob', 1700000000002);
  const plan = planImport(source.db);
  assert.equal(plan.find((item) => item.table === 'users').rows, 2);
  assert.equal(plan.find((item) => item.table === 'media').rows, 2, 'demo-group media is excluded');
  assert.equal(plan.find((item) => item.table === 'group_reports').rows, 1);
  assert.equal(plan.find((item) => item.table === 'message_reactions').rows, 0);
  assert.equal(plan.find((item) => item.table === 'groups').rows, 1);
  assert.equal(plan.find((item) => item.table === 'group_members').rows, 2);
  assert.equal(plan.find((item) => item.table === 'group_messages').rows, 1);
  await importSqlite(source.db, pool);
  assert.equal((await pool.query('SELECT count(*)::integer AS total FROM relay.messages')).rows[0].total, 205);
  assert.equal((await pool.query("SELECT byte_size FROM relay.media WHERE id = 'large-file'")).rows[0].byte_size, 100000000000);
  assert.deepEqual((await pool.query("SELECT id, receiver_id, group_id FROM relay.media WHERE id = 'group-file'")).rows[0], { id: 'group-file', receiver_id: null, group_id: 'group-a' });
  assert.equal((await pool.query('SELECT count(*)::integer AS total FROM relay.group_reports')).rows[0].total, 1);
  assert.deepEqual((await pool.query('SELECT group_id, sender_id, content, expires_at FROM relay.group_messages')).rows[0], {
    group_id: 'group-a', sender_id: 'real-b', content: 'Group text', expires_at: 86400003,
  });
  assert.equal((await pool.query("SELECT auto_delete FROM relay.group_members WHERE user_id = 'real-b'")).rows[0].auto_delete, 1);
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

test('startup migration creates a missing schema once and refuses an unsupported one', async (t) => {
  await engine.exec('DROP SCHEMA relay CASCADE');
  const logged = [];
  const originalLog = console.log;
  console.log = (...args) => logged.push(args.join(' '));
  t.after(() => { console.log = originalLog; });
  const start = async () => {
    const directory = mkdtempSync(join(tmpdir(), 'relay-auto-migrate-'));
    const service = createChatServer({ port: 0, host: '127.0.0.1', database: createPostgresDatabase({ pool }), dataDirectory: directory, migrate: true });
    t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
    return service;
  };
  const first = await start();
  const address = await first.listen();
  assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/v1/ready`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/v1/auth/availability?username=fresh`)).status, 200);
  assert.deepEqual(logged, ['Created the Hidden Messenger database schema.']);
  await first.close();
  logged.length = 0;
  await (await start()).listen();
  assert.deepEqual(logged, []);
  await engine.exec('UPDATE relay.schema_version SET version = 99');
  const unsupported = await start();
  await assert.rejects(unsupported.listen(), /unsupported/);
  assert.equal(unsupported.server.listening, false);
  assert.equal((await pool.query('SELECT version FROM relay.schema_version')).rows[0].version, 99);
});

test('production requires PostgreSQL, a fixed port and exact HTTPS origins', async (t) => {
  const original = { NODE_ENV: process.env.NODE_ENV, RELAY_ALLOWED_ORIGINS: process.env.RELAY_ALLOWED_ORIGINS };
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.NODE_ENV = 'production';
  process.env.RELAY_ALLOWED_ORIGINS = 'https://chat.example.com';
  const database = createPostgresDatabase({ pool });
  assert.throws(() => createChatServer({ databaseUrl: null }), /Production requires DATABASE_URL/);
  assert.throws(() => createChatServer({ database, port: 0 }), /fixed nonzero PORT/);
  assert.throws(() => createChatServer({ database, seedDemo: true }), /Demo seeding/);
  assert.throws(() => createChatServer({ database, allowedOrigins: '' }), /RELAY_ALLOWED_ORIGINS/);
  for (const allowedOrigins of ['http://chat.example.com', 'https://chat.example.com/path', 'https://user:password@chat.example.com']) {
    assert.throws(() => createChatServer({ database, allowedOrigins }), /exact HTTPS origins/);
  }
  // Select an available port in development, then exercise production request policy.
  process.env.NODE_ENV = 'test';
  const { api } = await startServer(t, database);
  process.env.NODE_ENV = 'production';
  assert.equal((await api('/api/v1/health', { headers: { Origin: 'https://chat.example.com' } })).status, 200);
  for (const Origin of ['https://attacker.example', 'http://localhost:5173', 'https://other.ngrok-free.dev', 'https://other.ngrok-free.app']) {
    assert.equal((await api('/api/v1/health', { headers: { Origin } })).status, 403);
  }
});

test('readiness checks the live PostgreSQL schema without changing liveness', async (t) => {
  const { url } = await startServer(t);
  const ready = await fetch(`${url}/api/v1/ready`);
  assert.equal(ready.status, 200);
  assert.equal(ready.headers.get('cache-control'), 'no-store');
  // Also reports whether uploads survive a deploy (stored outside the release) and lost files among recent ones.
  assert.deepEqual(await ready.json(), { status: 'ok', storage: 'persistent', push: false, recentMedia: { checked: 0, missing: 0 } });
  await engine.exec('DROP SCHEMA relay CASCADE');
  const unavailable = await fetch(`${url}/api/v1/ready`);
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await unavailable.json(), { error: 'The server could not complete this request. Please retry.' });
  assert.equal((await fetch(`${url}/api/v1/health`)).status, 200);
});
