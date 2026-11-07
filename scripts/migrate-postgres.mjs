import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { DATABASE_SCHEMA_VERSION, migratePostgres, postgresOptions } from '../server/database.mjs';

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
