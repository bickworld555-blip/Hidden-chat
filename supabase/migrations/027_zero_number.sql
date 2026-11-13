-- No Email. No Number. (Play Store readiness, fixes F1–F3.) Run once, in order, after 026.
--   * Invite links: only the SHA-256 of each 128-bit token is kept (server/index.mjs /api/v1/connect/*).
--   * Privacy › Discoverable by username for exact lookups (POST /api/v1/users/lookup).
--   * Business profiles no longer hold an email address or a phone number: the columns and their values go.
SET LOCAL search_path TO relay;

CREATE TABLE connect_tokens (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  uses_left INTEGER NOT NULL CHECK (uses_left >= 0),
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX connect_tokens_owner ON connect_tokens(owner_id);
ALTER TABLE connect_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE connect_tokens FROM PUBLIC, anon, authenticated;

ALTER TABLE users ADD COLUMN discoverable_by_username INTEGER NOT NULL DEFAULT 1 CHECK (discoverable_by_username IN (0, 1));

ALTER TABLE business_profiles DROP COLUMN IF EXISTS email;
ALTER TABLE business_profiles DROP COLUMN IF EXISTS phone;

UPDATE schema_version SET version = 27 WHERE singleton = 1;
