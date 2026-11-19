-- The attachment a photo or video status shows (server/index.mjs), set when the status is posted. Contacts may open
-- the attachment, and it is kept, while a live status names it; this replaces matching the content's text, which
-- missed encrypted ("emedia:") statuses. Statuses already posted are linked at start (linkStatusMedia). Additive.
SET LOCAL search_path TO relay;

ALTER TABLE statuses ADD COLUMN media_id TEXT;
CREATE INDEX statuses_media ON statuses(media_id) WHERE media_id IS NOT NULL;

UPDATE schema_version SET version = 42 WHERE singleton = 1;
