import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { DATABASE_SCHEMA_VERSION, postgresOptions } from '../server/database.mjs';
import { DEMO_USERS } from '../server/demo.mjs';

export const IMPORT_TABLES = Object.freeze([
  { name: 'users', columns: ['id', 'username', 'name', 'initials', 'color', 'dob', 'password_hash', 'created_at', 'avatar_disk_name', 'avatar_type', 'avatar_updated_at', 'last_seen_at', 'last_seen_privacy'], users: ['id'] },
  { name: 'sessions', columns: ['token_hash', 'user_id', 'device_id', 'device_name', 'expires_at', 'created_at', 'last_active_at'], users: ['user_id'] },
  { name: 'contacts', columns: ['owner_id', 'contact_id', 'created_at', 'saved', 'hidden'], users: ['owner_id', 'contact_id'], key: ['owner_id', 'contact_id'] },
  // Groups precede media and uploads, whose group_id references them.
  { name: 'groups', columns: ['id', 'name', 'created_by', 'created_at'], users: ['created_by'] },
  { name: 'group_members', columns: ['group_id', 'user_id', 'role', 'auto_delete', 'joined_at', 'last_read_at', 'cleared_at'], users: ['user_id'], key: ['group_id', 'user_id'] },
  { name: 'messages', columns: ['id', 'sender_id', 'receiver_id', 'created_at', 'content', 'status', 'deleted_at', 'reply_to_id', 'forwarded', 'expires_at', 'played_at'], users: ['sender_id', 'receiver_id'] },
  { name: 'media', columns: ['id', 'sender_id', 'receiver_id', 'group_id', 'filename', 'content_type', 'byte_size', 'disk_name', 'created_at'], users: ['sender_id', 'receiver_id'] },
  { name: 'pairing_codes', columns: ['code_hash', 'user_id', 'expires_at'], users: ['user_id'] },
  { name: 'chat_settings', columns: ['user_a', 'user_b', 'disappear_seconds', 'updated_by', 'updated_at'], users: ['user_a', 'user_b', 'updated_by'], key: ['user_a', 'user_b'] },
  { name: 'uploads', columns: ['id', 'owner_id', 'receiver_id', 'group_id', 'filename', 'content_type', 'byte_size', 'received', 'disk_name', 'created_at', 'updated_at'], users: ['owner_id', 'receiver_id'] },
  { name: 'message_reactions', columns: ['message_id', 'user_id', 'emoji'], users: ['user_id'], key: ['message_id', 'user_id'] },
  { name: 'message_hidden', columns: ['user_id', 'message_id'], users: ['user_id'], key: ['user_id', 'message_id'] },
  { name: 'group_messages', columns: ['id', 'group_id', 'sender_id', 'created_at', 'content', 'expires_at'], users: ['sender_id'] },
  { name: 'poll_votes', columns: ['message_id', 'user_id', 'option_index', 'voted_at'], users: ['user_id'], key: ['message_id', 'user_id', 'option_index'], numeric: ['option_index'] },
  { name: 'group_reports', columns: ['id', 'group_id', 'reporter_id', 'reason', 'created_at'], users: ['reporter_id'] },
  { name: 'statuses', columns: ['id', 'user_id', 'content', 'background', 'created_at', 'expires_at'], users: ['user_id'] },
  { name: 'status_views', columns: ['status_id', 'viewer_id', 'viewed_at'], users: ['viewer_id'], key: ['status_id', 'viewer_id'] },
  // Phones registered for Firebase push (kept with their sessions, so push keeps working after the move).
  { name: 'identity_keys', columns: ['user_id', 'public_key', 'algorithm', 'updated_at'], users: ['user_id'] },
  { name: 'push_devices', columns: ['token', 'user_id', 'session_hash', 'device_key', 'platform', 'updated_at'], users: ['user_id'], key: ['token'] },
]);
const demoIds = Object.keys(DEMO_USERS);
const excluded = demoIds.map(() => '?').join(', ');
const BATCH_ROWS = 200;

// Deterministic byte-order sort on each table's key; numeric key columns sort as numbers (collations are text-only).
function orderBy(table, collation) {
  return (table.key ?? [table.columns[0]]).map((column) => (table.numeric?.includes(column) ? column : `${column} COLLATE ${collation}`)).join(', ');
}
function sourceQuery(table) {
  const filters = table.users.map((column) => `(${column} IS NULL OR ${column} NOT IN (${excluded}))`);
  const parameters = table.users.flatMap(() => demoIds);
  if (['message_reactions', 'message_hidden'].includes(table.name)) {
    filters.push(`message_id IN (SELECT id FROM messages WHERE sender_id NOT IN (${excluded}) AND receiver_id NOT IN (${excluded}))`);
    parameters.push(...demoIds, ...demoIds);
  }
  if (['media', 'uploads'].includes(table.name)) {
    filters.push(`(group_id IS NULL OR group_id IN (SELECT id FROM groups WHERE created_by NOT IN (${excluded})))`);
    parameters.push(...demoIds);
  }
  if (['group_members', 'group_messages', 'group_reports'].includes(table.name)) {
    filters.push(`group_id IN (SELECT id FROM groups WHERE created_by NOT IN (${excluded}))`);
    parameters.push(...demoIds);
  }
  return {
    sql: `SELECT ${table.columns.join(', ')} FROM ${table.name} WHERE ${filters.join(' AND ')} ORDER BY ${orderBy(table, 'BINARY')}`,
    parameters,
  };
}

export function planImport(source) {
  const names = source.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((row) => row.name);
  const unknown = names.filter((name) => !IMPORT_TABLES.some((table) => table.name === name));
  if (unknown.length) throw new Error(`Unsupported source tables: ${unknown.join(', ')}. Define their migration before importing.`);
  return IMPORT_TABLES.map((table) => {
    const columns = source.prepare(`PRAGMA table_info(${table.name})`).all().map((row) => row.name);
    if (columns.length !== table.columns.length || table.columns.some((column) => !columns.includes(column))) {
      throw new Error(`Source schema for ${table.name} differs from the supported schema. Upgrade a copy with the SQLite app first.`);
    }
    const { sql, parameters } = sourceQuery(table);
    let rows = 0;
    for (const row of source.prepare(sql).iterate(...parameters)) rows += 1;
    return { table: table.name, rows };
  });
}

function digestRows(hash, rows, columns) {
  for (const row of rows) hash.update(JSON.stringify(columns.map((column) => row[column])) + '\n');
}

export async function importSqlite(source, client) {
  const plan = planImport(source);
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('relay-sqlite-import'))");
    const version = await client.query('SELECT version FROM relay.schema_version WHERE singleton = 1');
    if (version.rows[0]?.version !== DATABASE_SCHEMA_VERSION) throw new Error('Run the schema migration first.');
    await client.query(`LOCK TABLE ${IMPORT_TABLES.map((table) => `relay.${table.name}`).join(', ')} IN ACCESS EXCLUSIVE MODE`);
    for (const table of IMPORT_TABLES) {
      const result = await client.query(`SELECT 1 FROM relay.${table.name} LIMIT 1`);
      if (result.rows.length) throw new Error(`Destination ${table.name} is not empty. Import refuses to merge or overwrite data.`);
    }
    for (const table of IMPORT_TABLES) {
      const expected = createHash('sha256');
      const { sql, parameters } = sourceQuery(table);
      let batch = [];
      let offset = 0;
      async function insertBatch() {
        if (!batch.length) return;
        const placeholders = batch.map((row, index) => `(${table.columns.map((column, col) => `$${index * table.columns.length + col + 1}`).join(', ')})`).join(', ');
        const values = batch.flatMap((row) => table.columns.map((column) => row[column]));
        await client.query(`INSERT INTO relay.${table.name} (${table.columns.join(', ')}) VALUES ${placeholders}`, values);
        batch = [];
      }
      for (const row of source.prepare(sql).iterate(...parameters)) {
        digestRows(expected, [row], table.columns);
        batch.push(row);
        if (batch.length === BATCH_ROWS) await insertBatch();
      }
      await insertBatch();
      const actual = createHash('sha256');
      const order = orderBy(table, '"C"');
      await client.query(`DECLARE relay_import_verify NO SCROLL CURSOR FOR SELECT ${table.columns.join(', ')} FROM relay.${table.name} ORDER BY ${order}`);
      for (;;) {
        const result = await client.query(`FETCH FORWARD ${BATCH_ROWS} FROM relay_import_verify`);
        digestRows(actual, result.rows, table.columns);
        offset += result.rows.length;
        if (result.rows.length < BATCH_ROWS) break;
      }
      await client.query('CLOSE relay_import_verify');
      if (actual.digest('hex') !== expected.digest('hex') || offset !== plan.find((item) => item.table === table.name).rows) {
        throw new Error(`Verification failed for ${table.name}; the entire import will be rolled back.`);
      }
    }
    await client.query('COMMIT');
    return plan;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [path, flag] = process.argv.slice(2);
  if (!path || (flag && flag !== '--apply') || process.argv.length > 4) {
    console.error('Usage: npm run db:import -- C:\\path\\relay.sqlite [--apply]. Stop the source and destination servers first.');
    process.exitCode = 1;
  } else {
    let source;
    let pool;
    try {
      source = new DatabaseSync(resolve(path), { readOnly: true });
      console.table(planImport(source));
      console.log('Built-in demo IDs and their related records are excluded. Media bytes and live coordinates are not uploaded.');
      if (flag === '--apply') {
        const backupDirectory = resolve('backups');
        await mkdir(backupDirectory, { recursive: true });
        const backupPath = resolve(backupDirectory, `relay-before-import-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
        await backup(source, backupPath);
        console.log(`SQLite backup saved to ${backupPath}. Keep it private.`);
        source.close();
        source = new DatabaseSync(backupPath, { readOnly: true });
        pool = new pg.Pool(postgresOptions());
        const client = await pool.connect();
        try {
          await importSqlite(source, client);
          console.log('Import committed: every table count and content digest matched.');
        } finally {
          client.release();
        }
      } else {
        console.log('Preview only. Back up .data and stop both servers, then rerun with --apply to write.');
      }
    } catch (error) {
      console.error('Import failed. No successful migration is claimed. Error:', error.code ?? error.message);
      process.exitCode = 1;
    } finally {
      source?.close();
      await pool?.end();
    }
  }
}
