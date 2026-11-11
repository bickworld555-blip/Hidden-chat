-- Business profile links and cover photo, away message date ranges, catalog collections, and deleted accounts
-- (server/parity.mjs, server/account.mjs). Additive only.
SET LOCAL search_path TO relay;

ALTER TABLE business_profiles ADD COLUMN links TEXT NOT NULL DEFAULT '[]';
ALTER TABLE business_profiles ADD COLUMN cover_disk_name TEXT;
ALTER TABLE business_profiles ADD COLUMN cover_type TEXT;
ALTER TABLE business_profiles ADD COLUMN away_from BIGINT;
ALTER TABLE business_profiles ADD COLUMN away_until BIGINT;
CREATE TABLE catalog_collections (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, item_ids TEXT NOT NULL DEFAULT '[]', created_at BIGINT NOT NULL);
CREATE INDEX catalog_collections_user ON catalog_collections(user_id, created_at);
ALTER TABLE users ADD COLUMN deleted_at BIGINT;
ALTER TABLE catalog_collections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE catalog_collections FROM PUBLIC, anon, authenticated;
UPDATE schema_version SET version = 16 WHERE singleton = 1;
