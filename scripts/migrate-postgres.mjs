import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { DATABASE_SCHEMA_VERSION, postgresOptions } from '../server/database.mjs';

export async function migratePostgres(client) {
  await client.query('BEGIN');
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('relay-schema-migration'))");
    const existing = await client.query("SELECT to_regclass('relay.schema_version') AS version_table");
    if (existing.rows[0].version_table) {
      const version = await client.query('SELECT version FROM relay.schema_version WHERE singleton = 1');
      if (version.rows[0]?.version !== DATABASE_SCHEMA_VERSION) throw new Error('Existing schema version is unsupported. Do not overwrite it.');
    } else {
      const sql = await readFile(new URL('../supabase/migrations/001_relay.sql', import.meta.url), 'utf8');
      await client.query(sql);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = new pg.Pool(postgresOptions());
  try {
    const client = await pool.connect();
    try {
      console.log('Applying private Relay schema (no existing tables or data will be replaced).');
      await migratePostgres(client);
      console.log(`Relay schema version ${DATABASE_SCHEMA_VERSION} is ready.`);
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Schema migration failed. Verify credentials, CA certificate and schema permissions. Error:', error.code ?? error.name);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
