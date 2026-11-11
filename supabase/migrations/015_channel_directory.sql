-- Channel directory categories and channel admins (server/extras.mjs). Additive only.
SET LOCAL search_path TO relay;

ALTER TABLE channels ADD COLUMN category TEXT NOT NULL DEFAULT 'other';
CREATE INDEX channels_category ON channels(category, created_at);
CREATE TABLE channel_admins (channel_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), added_at BIGINT NOT NULL, PRIMARY KEY (channel_id, user_id));
ALTER TABLE channel_admins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE channel_admins FROM PUBLIC, anon, authenticated;
UPDATE schema_version SET version = 15 WHERE singleton = 1;
