-- XMPP core, Phase 2 (server/xmpp.mjs): one ejabberd account per signed-in device. Run once, in order, after 027.
--   * The row records that the device's account exists on ejabberd (created before its first sign-in token), so the
--     account is removed when the device's session ends. The localpart is derived from the user and device ids.
SET LOCAL search_path TO relay;

CREATE TABLE xmpp_accounts (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  localpart TEXT NOT NULL UNIQUE,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, device_id)
);
ALTER TABLE xmpp_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE xmpp_accounts FROM PUBLIC, anon, authenticated;

UPDATE schema_version SET version = 28 WHERE singleton = 1;
