-- When each group member read the group (server/index.mjs PUT /groups/:id/read): a message's read time for a member is
-- their first mark at or after it ("Read by" in Message info, blue ticks in groups). Run once, after 034.
SET LOCAL search_path TO relay;

CREATE TABLE IF NOT EXISTS group_read_marks (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  read_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS group_read_marks_group ON group_read_marks(group_id, read_at);
ALTER TABLE group_read_marks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE group_read_marks FROM PUBLIC, anon, authenticated;

UPDATE schema_version SET version = 35 WHERE singleton = 1;
