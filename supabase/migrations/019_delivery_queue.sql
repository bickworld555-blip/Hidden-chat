-- The server becomes a short-lived queue (server/deliveryQueue.mjs): per-device delivery rows, the route of each
-- message (no content) for 30 days, small per-device events for offline devices, and end-to-end encrypted backups
-- (opaque blobs; the password or recovery key never reaches the server). Additive.
SET LOCAL search_path TO relay;

CREATE TABLE message_deliveries (
  message_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('direct', 'group')),
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  delivered_at BIGINT,
  PRIMARY KEY (message_id, device_id)
);
CREATE INDEX message_deliveries_pending ON message_deliveries(device_id, delivered_at);
CREATE INDEX message_deliveries_user ON message_deliveries(user_id, delivered_at);
CREATE TABLE message_routes (
  message_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('direct', 'group')),
  sender_id TEXT NOT NULL,
  receiver_id TEXT,
  group_id TEXT,
  created_at BIGINT NOT NULL
);
CREATE TABLE device_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX device_events_device ON device_events(device_id, created_at);
CREATE TABLE backups (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  disk_name TEXT NOT NULL,
  byte_size BIGINT NOT NULL,
  kdf TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);
ALTER TABLE message_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE backups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE message_deliveries, message_routes, device_events, backups FROM PUBLIC, anon, authenticated;
UPDATE schema_version SET version = 19 WHERE singleton = 1;
