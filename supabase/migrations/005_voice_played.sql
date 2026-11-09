-- When the recipient first played a voice note (WhatsApp's blue microphone).
SET LOCAL search_path TO relay;

ALTER TABLE messages ADD COLUMN played_at BIGINT;
UPDATE schema_version SET version = 5 WHERE singleton = 1;
