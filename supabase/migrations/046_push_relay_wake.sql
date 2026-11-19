-- Whether a phone's app opens messages from this server in the background (server/index.mjs pushToUser): then a new
-- message wakes it ("xwake") to fetch, decrypt and notify with the real text, instead of the sealed "🔒 Message".
-- Set by the app at each start (POST /api/v1/push/relay-wake). Additive.
SET LOCAL search_path TO relay;

ALTER TABLE push_devices ADD COLUMN relay_wake INTEGER NOT NULL DEFAULT 0;

UPDATE schema_version SET version = 46 WHERE singleton = 1;
