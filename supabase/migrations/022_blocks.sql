-- Blocking (server/blocks.mjs): who blocked whom, enforced by the server (messages, calls, presence, photo, statuses).
-- Additive.
SET LOCAL search_path TO relay;

CREATE TABLE blocks (
  blocker_id TEXT NOT NULL REFERENCES users(id),
  blocked_id TEXT NOT NULL REFERENCES users(id),
  created_at BIGINT NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX blocks_blocked ON blocks(blocked_id);
ALTER TABLE blocks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE blocks FROM PUBLIC, anon, authenticated;

UPDATE schema_version SET version = 22 WHERE singleton = 1;
