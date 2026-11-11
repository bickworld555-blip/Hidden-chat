-- Verified business badges: approved accounts and pending requests (server/verification.mjs). Additive only.
SET LOCAL search_path TO relay;

CREATE TABLE verified_accounts (user_id TEXT PRIMARY KEY REFERENCES users(id), verified_at BIGINT NOT NULL, granted_by TEXT);
CREATE TABLE verification_requests (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  created_at BIGINT NOT NULL,
  decided_at BIGINT
);
ALTER TABLE verified_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE verified_accounts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE verification_requests FROM PUBLIC, anon, authenticated;
UPDATE schema_version SET version = 17 WHERE singleton = 1;
