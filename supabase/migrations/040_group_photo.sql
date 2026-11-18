-- Group photos (New group › photo, group info): a file in the data directory, named per group and version, served to
-- members only (server/parity.mjs). The URL carries avatar_updated_at so clients can cache it until it changes. Additive.
SET LOCAL search_path TO relay;

ALTER TABLE groups ADD COLUMN avatar_disk_name TEXT;
ALTER TABLE groups ADD COLUMN avatar_type TEXT;
ALTER TABLE groups ADD COLUMN avatar_updated_at BIGINT;

UPDATE schema_version SET version = 40 WHERE singleton = 1;
