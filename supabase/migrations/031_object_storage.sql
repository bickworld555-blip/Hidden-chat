-- Attachments may live in S3-compatible object storage (Cloudflare R2, server/objectStore.mjs) instead of the app
-- server's disk. `storage` says where each one's bytes are; disk_name is then the object key. An upload going
-- straight to the bucket remembers the bucket's multipart upload id. Run once, in order, after 030.
SET LOCAL search_path TO relay;

ALTER TABLE media ADD COLUMN IF NOT EXISTS storage TEXT NOT NULL DEFAULT 'disk' CHECK (storage IN ('disk', 'r2'));
ALTER TABLE uploads ADD COLUMN IF NOT EXISTS storage TEXT NOT NULL DEFAULT 'disk' CHECK (storage IN ('disk', 'r2'));
ALTER TABLE uploads ADD COLUMN IF NOT EXISTS remote_upload_id TEXT;

UPDATE schema_version SET version = 31 WHERE singleton = 1;
