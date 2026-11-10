-- End-to-end encryption key directory (server/e2e.mjs): each signed-in device's public identity key, signed
-- prekey and one-time prekeys. Private keys never leave the devices.
SET LOCAL search_path TO relay;

CREATE TABLE e2e_devices (
  user_id TEXT NOT NULL REFERENCES users(id),
  device_id TEXT NOT NULL,
  identity_dh TEXT NOT NULL,
  identity_sig TEXT NOT NULL,
  signed_prekey_id BIGINT NOT NULL,
  signed_prekey TEXT NOT NULL,
  signed_prekey_signature TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, device_id)
);
CREATE TABLE e2e_prekeys (
  user_id TEXT NOT NULL REFERENCES users(id),
  device_id TEXT NOT NULL,
  key_id BIGINT NOT NULL,
  public_key TEXT NOT NULL,
  PRIMARY KEY (user_id, device_id, key_id)
);
ALTER TABLE e2e_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE e2e_prekeys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE e2e_devices, e2e_prekeys FROM PUBLIC, anon, authenticated;
UPDATE schema_version SET version = 11 WHERE singleton = 1;
