-- Phones registered for Firebase push: the FCM token, the device's payload key, and the session it belongs to
-- (signing out of that session forgets the phone).
SET LOCAL search_path TO relay;

CREATE TABLE push_devices (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_hash TEXT NOT NULL,
  device_key TEXT NOT NULL,
  platform TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX push_devices_user ON push_devices(user_id);
CREATE INDEX push_devices_session ON push_devices(session_hash);
ALTER TABLE push_devices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE push_devices FROM PUBLIC, anon, authenticated;
UPDATE schema_version SET version = 7 WHERE singleton = 1;
