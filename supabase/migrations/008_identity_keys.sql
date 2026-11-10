-- Public identity keys for end-to-end encryption (the private keys never leave the devices).
SET LOCAL search_path TO relay;

CREATE TABLE identity_keys (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  public_key TEXT NOT NULL,
  algorithm TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);
ALTER TABLE identity_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE identity_keys FROM PUBLIC, anon, authenticated;
UPDATE schema_version SET version = 8 WHERE singleton = 1;
