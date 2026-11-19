-- Delete chat for the Hidden Messenger chat (server/support.mjs): when each person last deleted it. Messages from
-- before that leave their view; the support console keeps them. Additive.
SET LOCAL search_path TO relay;

CREATE TABLE support_threads (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  cleared_at BIGINT NOT NULL
);
ALTER TABLE support_threads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE support_threads FROM PUBLIC, anon, authenticated;

UPDATE schema_version SET version = 43 WHERE singleton = 1;
