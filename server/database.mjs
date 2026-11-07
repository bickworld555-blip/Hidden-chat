import { readFileSync } from 'node:fs';
import pg from 'pg';

export const DATABASE_SCHEMA_VERSION = 1;

// SQL emitted by the application uses ? parameters and quoted result aliases.
export function postgresParameters(sql) {
  let output = '';
  let index = 0;
  let quote = null;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    if (quote) {
      output += char;
      if (char === quote) {
        if (sql[i + 1] === quote) output += sql[++i];
        else quote = null;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
      output += char;
    } else if (char === '?') {
      output += `$${++index}`;
    } else {
      output += char;
    }
  }
  if (quote) throw new Error('Unterminated SQL quoted value.');
  return output;
}

export function postgresOptions(env = process.env) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required for PostgreSQL.');
  const url = new URL(env.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must be a PostgreSQL URI.');
  // pg connection-string SSL options can override the verified TLS configuration.
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'ssl']) {
    if (url.searchParams.has(key)) throw new Error(`Remove ${key} from DATABASE_URL; configure TLS with DATABASE_SSL_CA.`);
  }
  const max = Number(env.DATABASE_POOL_MAX ?? 5);
  if (!Number.isInteger(max) || max < 1 || max > 20) throw new Error('DATABASE_POOL_MAX must be an integer from 1 to 20.');
  const types = {
    getTypeParser(oid, format) {
      if (oid !== 20 || format === 'binary') return pg.types.getTypeParser(oid, format);
      return (value) => {
        const number = Number(value);
        if (!Number.isSafeInteger(number)) throw new Error('PostgreSQL bigint exceeds the application safe integer range.');
        return number;
      };
    },
  };
  return {
    connectionString: env.DATABASE_URL,
    max,
    ssl: { rejectUnauthorized: true, ...(env.DATABASE_SSL_CA ? { ca: readFileSync(env.DATABASE_SSL_CA, 'utf8') } : {}) },
    options: '-c search_path=relay',
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 30_000,
    types,
  };
}

export function createPostgresDatabase({ env = process.env, pool = new pg.Pool(postgresOptions(env)) } = {}) {
  pool.on('error', (error) => console.error('PostgreSQL idle connection failed:', error.code ?? error.name));
  return {
    dialect: 'postgres',
    pool,
    prepare(sql) {
      const text = postgresParameters(sql);
      return {
        async all(...values) { return (await pool.query(text, values)).rows; },
        async get(...values) { return (await pool.query(text, values)).rows[0]; },
        async run(...values) { return { changes: (await pool.query(text, values)).rowCount }; },
      };
    },
    async ready() {
      let result;
      try {
        result = await pool.query('SELECT version FROM relay.schema_version WHERE singleton = 1');
      } catch (error) {
        if (!['42P01', '3F000'].includes(error.code)) throw error;
        throw new Error('Database schema is missing. Run npm run db:migrate before starting the server.', { cause: error });
      }
      if (result.rows[0]?.version !== DATABASE_SCHEMA_VERSION) throw new Error('Database schema is not current. Run npm run db:migrate before starting the server.');
    },
    async close() { await pool.end(); },
  };
}
