-- WhatsApp-style privacy categories beyond last seen: who sees me online, who sees my profile photo, and read
-- receipts (blue ticks).
SET LOCAL search_path TO relay;

ALTER TABLE users ADD COLUMN online_privacy TEXT NOT NULL DEFAULT 'same_as_last_seen'
  CHECK (online_privacy IN ('everyone', 'same_as_last_seen'));
ALTER TABLE users ADD COLUMN photo_privacy TEXT NOT NULL DEFAULT 'everyone'
  CHECK (photo_privacy IN ('everyone', 'contacts', 'nobody'));
ALTER TABLE users ADD COLUMN read_receipts INTEGER NOT NULL DEFAULT 1 CHECK (read_receipts IN (0, 1));
UPDATE schema_version SET version = 9 WHERE singleton = 1;
