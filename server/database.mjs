import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

export const DATABASE_SCHEMA_VERSION = 48;
// Additive migrations applied in order to reach each version from the one before it.
const MIGRATIONS = { 2: '002_groups.sql', 3: '003_group_media.sql', 4: '004_presence_polls.sql', 5: '005_voice_played.sql', 6: '006_statuses.sql', 7: '007_push_devices.sql', 8: '008_identity_keys.sql', 9: '009_privacy_settings.sql', 10: '010_parity.sql', 11: '011_e2e_devices.sql', 12: '012_stage_a.sql', 13: '013_admin_help.sql', 14: '014_business_profile.sql', 15: '015_channel_directory.sql', 16: '016_business_account.sql', 17: '017_verified.sql', 18: '018_admin_dashboard.sql', 19: '019_delivery_queue.sql', 20: '020_delivery_targets_per_user.sql', 21: '021_rate_limits.sql', 22: '022_blocks.sql', 23: '023_member_tags.sql', 24: '024_support.sql', 25: '025_privacy_extras.sql', 26: '026_members_can_add.sql', 27: '027_zero_number.sql', 28: '028_xmpp_accounts.sql', 29: '029_xmpp_accounts_outlive_users.sql', 30: '030_queue_sweep_indexes.sql', 31: '031_object_storage.sql', 32: '032_signed_device_lists.sql', 33: '033_token_buckets.sql', 34: '034_push_device_protocol.sql', 35: '035_group_read_marks.sql', 36: '036_call_telemetry.sql', 37: '037_account_numbers.sql', 38: '038_contact_alias.sql', 39: '039_message_requests.sql', 40: '040_group_photo.sql', 41: '041_support_media_campaigns.sql', 42: '042_status_media.sql', 43: '043_support_threads.sql', 44: '044_channel_post_media.sql', 45: '045_channel_link_preview.sql', 46: '046_push_relay_wake.sql', 47: '047_session_relay_wake.sql', 48: '048_e2e_preview_keys.sql' };

let chatEventsPool;

export function getPostgresPool() {
  if (!chatEventsPool) chatEventsPool = createPostgresDatabase().pool;
  return chatEventsPool;
}

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

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g;
const UNTRUSTED_TLS_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

// Hosting panels often store multi-line values with literal "\n" or collapsed whitespace,
// so PEM text is rebuilt from its base64 body rather than trusted as-is.
function normalizePem(text) {
  const blocks = [...text.replace(/\\n/g, '\n').matchAll(PEM_BLOCK)].map(([, body]) => {
    const base64 = body.replace(/\s+/g, '');
    if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error('DATABASE_SSL_CA contains a malformed PEM certificate.');
    return `-----BEGIN CERTIFICATE-----\n${base64.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  });
  if (!blocks.length) throw new Error('DATABASE_SSL_CA does not contain a PEM certificate.');
  return blocks.join('');
}

// DATABASE_SSL_CA accepts either PEM certificate text or a path to a PEM file.
export function databaseCertificateAuthority(value) {
  if (!value?.trim()) return undefined;
  if (value.includes('-----BEGIN CERTIFICATE-----')) return normalizePem(value);
  let text;
  try {
    text = readFileSync(value.trim(), 'utf8');
  } catch (error) {
    throw new Error(`DATABASE_SSL_CA file could not be read (${error.code ?? error.name}): ${value.trim()}`, { cause: error });
  }
  return normalizePem(text);
}

export function describeDatabaseError(error) {
  if (UNTRUSTED_TLS_CODES.has(error?.code)) {
    return 'Database TLS certificate is not trusted. Set DATABASE_SSL_CA to the Supabase CA certificate (PEM text or file path).';
  }
  return null;
}

const NETWORK_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);

// Connection, authentication and capacity failures (SQLSTATE classes 08, 28, 53, 57P) mean the
// database cannot serve any request, as opposed to a failure of one query.
export function isDatabaseUnavailable(error) {
  const code = error?.code;
  if (UNTRUSTED_TLS_CODES.has(code) || NETWORK_ERROR_CODES.has(code)) return true;
  if (typeof code === 'string' && /^(08|28|53|57P)/.test(code)) return true;
  return /^Connection terminated|timeout exceeded when trying to connect/i.test(error?.message ?? '');
}

// Applies ordered, additive migrations under an advisory lock; an existing schema is never replaced.
// Returns true when the schema was created.
export async function migratePostgres(client) {
  await client.query('BEGIN');
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('relay-schema-migration'))");
    const existing = await client.query("SELECT to_regclass('relay.schema_version') AS version_table");
    let created = false;
    let version;
    if (existing.rows[0].version_table) {
      const current = await client.query('SELECT version FROM relay.schema_version WHERE singleton = 1');
      version = current.rows[0]?.version;
    } else {
      const sql = await readFile(new URL('../supabase/migrations/001_relay.sql', import.meta.url), 'utf8');
      await client.query(sql);
      created = true;
      version = 1;
    }
    if (!Number.isInteger(version) || version < 1 || version > DATABASE_SCHEMA_VERSION) throw new Error('Existing schema version is unsupported. Do not overwrite it.');
    for (let next = version + 1; next <= DATABASE_SCHEMA_VERSION; next += 1) {
      const sql = await readFile(new URL(`../supabase/migrations/${MIGRATIONS[next]}`, import.meta.url), 'utf8');
      await client.query(sql);
    }
    await client.query('COMMIT');
    return created;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

// Behind a transaction-mode pooler (Supabase Supavisor on port 6543, PgBouncer pool_mode=transaction) every query may
// run on a different server connection, so settings sent when a connection starts (search_path, statement_timeout)
// do not stick. In that mode they come from the database role instead (scripts/db-pooler-setup.sql), the timeout is
// enforced by the client, and many more client connections are allowed because the pooler multiplexes them.
export const POOL_LIMITS = Object.freeze({ direct: { initial: 5, max: 20 }, transaction: { initial: 20, max: 200 } });
export const QUERY_TIMEOUT_MS = 30_000;

/**
 * DATABASE_POOL_MODE: 'direct' (default: a direct or session-pooler connection) or 'transaction'. Explicit only, never
 * guessed from the URL: switching modes changes how settings reach the database, so it is a deliberate step.
 */
export function databasePoolMode(env = process.env) {
  const configured = env.DATABASE_POOL_MODE?.trim().toLowerCase() || 'direct';
  if (configured !== 'direct' && configured !== 'transaction') throw new Error('DATABASE_POOL_MODE must be "direct" or "transaction".');
  return configured;
}

export function postgresOptions(env = process.env) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required for PostgreSQL.');
  const url = new URL(env.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must be a PostgreSQL URI.');
  // pg connection-string SSL options can override the verified TLS configuration.
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'ssl']) {
    if (url.searchParams.has(key)) throw new Error(`Remove ${key} from DATABASE_URL; configure TLS with DATABASE_SSL_CA.`);
  }
  const ca = databaseCertificateAuthority(env.DATABASE_SSL_CA);
  const mode = databasePoolMode(env);
  // The URL must agree with the mode. Supabase's transaction pooler listens on 6543: in direct mode the server would
  // send startup settings it drops, so queries fail later in confusing ways; its 5432 is the session pooler.
  if (mode === 'direct' && url.port === '6543') {
    throw new Error('DATABASE_URL uses port 6543, the transaction pooler: set DATABASE_POOL_MODE=transaction (after scripts/db-pooler-setup.sql).');
  }
  if (mode === 'transaction' && url.hostname.endsWith('.pooler.supabase.com') && url.port !== '6543') {
    throw new Error("DATABASE_POOL_MODE=transaction needs Supabase's transaction pooler on port 6543 (5432 there is the session pooler).");
  }
  const limits = POOL_LIMITS[mode];
  const max = Number(env.DATABASE_POOL_MAX ?? limits.initial);
  if (!Number.isInteger(max) || max < 1 || max > limits.max) throw new Error(`DATABASE_POOL_MAX must be an integer from 1 to ${limits.max} (${mode} connections).`);
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
  const common = { connectionString: env.DATABASE_URL, max, ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) }, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000, types };
  if (mode === 'transaction') return { ...common, query_timeout: QUERY_TIMEOUT_MS };
  return { ...common, options: '-c search_path=relay', statement_timeout: QUERY_TIMEOUT_MS };
}

export function createPostgresDatabase({ env = process.env, pool = new pg.Pool(postgresOptions(env)) } = {}) {
  const mode = databasePoolMode(env);
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
    async batch(statements) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const { sql, values } of statements) await client.query(postgresParameters(sql), values);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async migrate() {
      const client = await pool.connect();
      try {
        return await migratePostgres(client);
      } finally {
        client.release();
      }
    },
    async ready() {
      let result;
      try {
        result = await pool.query('SELECT version FROM relay.schema_version WHERE singleton = 1');
      } catch (error) {
        const described = describeDatabaseError(error);
        if (described) throw Object.assign(new Error(described, { cause: error }), { code: error.code });
        if (!['42P01', '3F000'].includes(error.code)) throw error;
        throw new Error('Database schema is missing. Run npm run db:migrate before starting the server.', { cause: error });
      }
      if (result.rows[0]?.version !== DATABASE_SCHEMA_VERSION) throw new Error('Database schema is not current. Run npm run db:migrate before starting the server.');
      if (mode === 'transaction') {
        // Unqualified table names need search_path = relay from the role: without it every query would fail later.
        const schema = (await pool.query('SELECT current_schema() AS "schema"')).rows[0]?.schema;
        if (schema !== 'relay') throw new Error(`Behind the transaction pooler the database role must default to the relay schema (current: ${schema ?? 'none'}). Run scripts/db-pooler-setup.sql once.`);
      }
    },
    async close() { await pool.end(); },
  };
}
