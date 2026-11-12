-- Abuse limits shared by every server process and kept across restarts (server/abuse.mjs): fixed-window counters
-- by an HMAC of the key (never the address or account id itself); windows that ended are deleted. Additive.
SET LOCAL search_path TO relay;

CREATE TABLE rate_limit_hits (
  key TEXT NOT NULL,
  window_start BIGINT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);
ALTER TABLE rate_limit_hits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE rate_limit_hits FROM PUBLIC, anon, authenticated;

UPDATE schema_version SET version = 21 WHERE singleton = 1;
