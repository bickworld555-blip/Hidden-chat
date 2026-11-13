-- About (a short line under the name) and who can see it, Silence unknown callers and the Default message timer
-- (server/index.mjs privacy and about routes; server/presence.mjs parsePrivacyPatch). Additive.
SET LOCAL search_path TO relay;

ALTER TABLE users ADD COLUMN about TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN about_privacy TEXT NOT NULL DEFAULT 'everyone' CHECK (about_privacy IN ('everyone', 'contacts', 'nobody'));
ALTER TABLE users ADD COLUMN silence_unknown_callers INTEGER NOT NULL DEFAULT 0 CHECK (silence_unknown_callers IN (0, 1));
ALTER TABLE users ADD COLUMN default_message_timer INTEGER NOT NULL DEFAULT 0;

UPDATE schema_version SET version = 25 WHERE singleton = 1;
