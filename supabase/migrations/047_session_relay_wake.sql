-- Whether the app behind a session opens messages from this server in the background (server/index.mjs pushToUser):
-- then a new message wakes its phone ("xwake") instead of a sealed "🔒 Message". It belongs to the session, not to a
-- push token: kept on push_devices (046), a token registered after the app had said so (a new token after an APK
-- update) had it off, and that phone got sealed notices (seen on the S23, 2026-11-20). Additive; marks carried over.
SET LOCAL search_path TO relay;

ALTER TABLE sessions ADD COLUMN relay_wake INTEGER NOT NULL DEFAULT 0;
UPDATE sessions SET relay_wake = 1 WHERE token_hash IN (SELECT session_hash FROM push_devices WHERE relay_wake = 1);

UPDATE schema_version SET version = 47 WHERE singleton = 1;
