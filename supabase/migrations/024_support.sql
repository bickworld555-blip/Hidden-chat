-- Hidden Messenger Support (server/support.mjs) and the business contact number. Additive.
SET LOCAL search_path TO relay;

CREATE TABLE support_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  from_admin INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  read_by_user_at BIGINT,
  read_by_admin_at BIGINT
);
CREATE INDEX support_messages_user ON support_messages(user_id, created_at);
ALTER TABLE support_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE support_messages FROM PUBLIC, anon, authenticated;

-- A business contact number on the business profile (server/parity.mjs BUSINESS_PROFILE_FIELDS).
ALTER TABLE business_profiles ADD COLUMN phone TEXT NOT NULL DEFAULT '';

UPDATE schema_version SET version = 24 WHERE singleton = 1;
