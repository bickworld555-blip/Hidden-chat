-- Group attachments, per-member read and clear markers, and group reports.
SET LOCAL search_path TO relay;

-- An attachment belongs to exactly one direct conversation or one group.
ALTER TABLE media ALTER COLUMN receiver_id DROP NOT NULL;
ALTER TABLE media ADD COLUMN group_id TEXT REFERENCES groups(id);
ALTER TABLE media ADD CONSTRAINT media_one_target CHECK ((receiver_id IS NULL) <> (group_id IS NULL));
ALTER TABLE uploads ALTER COLUMN receiver_id DROP NOT NULL;
ALTER TABLE uploads ADD COLUMN group_id TEXT REFERENCES groups(id);
ALTER TABLE uploads ADD CONSTRAINT uploads_one_target CHECK ((receiver_id IS NULL) <> (group_id IS NULL));
CREATE INDEX media_group ON media(group_id) WHERE group_id IS NOT NULL;

ALTER TABLE group_members ADD COLUMN last_read_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE group_members ADD COLUMN cleared_at BIGINT NOT NULL DEFAULT 0;

CREATE TABLE group_reports (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  reporter_id TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
ALTER TABLE group_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE group_reports FROM PUBLIC, anon, authenticated;
UPDATE schema_version SET version = 3 WHERE singleton = 1;
