-- Call telemetry (server/callTelemetry.mjs): per-call connection numbers the app reports, kept 30 days. Additive.
SET LOCAL search_path TO relay;

CREATE TABLE call_telemetry (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  call_id TEXT NOT NULL,
  final INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  report TEXT NOT NULL
);
CREATE INDEX call_telemetry_created ON call_telemetry(created_at);
CREATE INDEX call_telemetry_user ON call_telemetry(user_id, created_at);
ALTER TABLE call_telemetry ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE call_telemetry FROM PUBLIC, anon, authenticated;

UPDATE schema_version SET version = 36 WHERE singleton = 1;
