-- The wire version of the app that registered a phone for push (X-HM-Client): from version 3 its push handler confirms
-- incoming calls (server/index.mjs CALL_CONFIRM_PROTOCOL); older phones keep the old ringing rule. Run once, after 033.
SET LOCAL search_path TO relay;

ALTER TABLE push_devices ADD COLUMN IF NOT EXISTS client_protocol INTEGER NOT NULL DEFAULT 0;

UPDATE schema_version SET version = 34 WHERE singleton = 1;
