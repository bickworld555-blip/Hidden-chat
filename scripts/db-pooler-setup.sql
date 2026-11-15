-- Run once, as the role in DATABASE_URL, before pointing DATABASE_URL at a transaction-mode pooler
-- (Supabase: Project › Connect › Transaction pooler, port 6543; or PgBouncer with pool_mode = transaction).
--
-- A transaction pooler hands each query to whichever server connection is free, so the settings the app sends when
-- it connects (search_path, statement_timeout) would be lost. The role carries them instead. They apply to every
-- new session of this role: unqualified names resolve in relay first, then public (relevant only if a table name
-- exists in both, e.g. in the SQL editor). Undo with: ALTER ROLE CURRENT_USER RESET search_path; ... RESET statement_timeout;
ALTER ROLE CURRENT_USER SET search_path = relay, public, extensions;
-- A server-side backstop; the app also stops waiting after 30 s (QUERY_TIMEOUT_MS in server/database.mjs).
ALTER ROLE CURRENT_USER SET statement_timeout = '60s';
