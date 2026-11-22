-- Notification preview keys (src/e2e/preview.js): each phone's public key for sealed notification previews, signed by
-- that device's identity key (senders verify the signature; the server only stores and hands it out). Additive.
SET LOCAL search_path TO relay;

CREATE TABLE IF NOT EXISTS e2e_preview_keys (
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  signature TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, device_id)
);
ALTER TABLE e2e_preview_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE e2e_preview_keys FROM PUBLIC, anon, authenticated;

UPDATE schema_version SET version = 48 WHERE singleton = 1;
