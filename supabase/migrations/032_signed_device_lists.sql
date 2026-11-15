-- Signed device lists (src/e2e/deviceList.js): the account key's latest signed list of the account's devices, and
-- link claims relayed from a device linked by QR to the phone that linked it. Run once, in order, after 031.
SET LOCAL search_path TO relay;

CREATE TABLE IF NOT EXISTS e2e_device_lists (
  user_id TEXT PRIMARY KEY,
  account_key TEXT NOT NULL,
  counter BIGINT NOT NULL,
  list TEXT NOT NULL,
  signature TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS e2e_link_claims (
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  claim TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, device_id)
);
ALTER TABLE e2e_device_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE e2e_link_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE e2e_device_lists, e2e_link_claims FROM PUBLIC, anon, authenticated;

UPDATE schema_version SET version = 32 WHERE singleton = 1;
