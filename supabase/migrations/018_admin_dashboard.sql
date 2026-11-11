-- Admin dashboard: verification tickets with request IDs for businesses and channels, verified channels, and an
-- approximate country per account (from the device time zone, never an IP) for aggregate statistics. Additive.
SET LOCAL search_path TO relay;

CREATE TABLE verified_channels (channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE, verified_at BIGINT NOT NULL, granted_by TEXT);
CREATE TABLE verification_tickets (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('business', 'channel')),
  subject_id TEXT NOT NULL,
  requester_id TEXT NOT NULL REFERENCES users(id),
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  created_at BIGINT NOT NULL,
  decided_at BIGINT,
  decided_by TEXT,
  decision_note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX verification_tickets_queue ON verification_tickets(kind, status, created_at);
CREATE INDEX verification_tickets_subject ON verification_tickets(kind, subject_id, created_at);
-- Requests made before tickets existed become tickets.
INSERT INTO verification_tickets(id, kind, subject_id, requester_id, note, status, created_at, decided_at)
  SELECT 'VR-' || upper(substr(md5(user_id || ':' || created_at::text), 1, 6)), 'business', user_id, user_id, note,
    CASE WHEN status = 'declined' THEN 'rejected' ELSE status END, created_at, decided_at
  FROM verification_requests;
ALTER TABLE users ADD COLUMN country TEXT;
ALTER TABLE users ADD COLUMN country_updated_at BIGINT;
ALTER TABLE verified_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_tickets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE verified_channels FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE verification_tickets FROM PUBLIC, anon, authenticated;
UPDATE schema_version SET version = 18 WHERE singleton = 1;
