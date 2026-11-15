-- Token buckets for upload allowances (server/abuse.mjs createTokenBuckets): presigned parts and bytes per account,
-- shared by every server process. Keys are HMACs, never account ids. Run once, in order, after 032.
SET LOCAL search_path TO relay;

CREATE TABLE IF NOT EXISTS token_buckets (
  key TEXT PRIMARY KEY,
  tokens DOUBLE PRECISION NOT NULL,
  updated_at BIGINT NOT NULL
);
ALTER TABLE token_buckets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE token_buckets FROM PUBLIC, anon, authenticated;

UPDATE schema_version SET version = 33 WHERE singleton = 1;
