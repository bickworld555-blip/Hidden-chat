-- Last seen with its privacy setting, per-device session times for Linked devices, and poll votes.
SET LOCAL search_path TO relay;

ALTER TABLE users ADD COLUMN last_seen_at BIGINT;
ALTER TABLE users ADD COLUMN last_seen_privacy TEXT NOT NULL DEFAULT 'everyone'
  CHECK (last_seen_privacy IN ('everyone', 'contacts', 'nobody'));

ALTER TABLE sessions ADD COLUMN created_at BIGINT;
ALTER TABLE sessions ADD COLUMN last_active_at BIGINT;

-- One row per chosen option; a poll message lives in either messages or group_messages.
CREATE TABLE poll_votes (
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  option_index INTEGER NOT NULL CHECK (option_index >= 0 AND option_index < 12),
  voted_at BIGINT NOT NULL,
  PRIMARY KEY (message_id, user_id, option_index)
);
ALTER TABLE poll_votes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE poll_votes FROM PUBLIC, anon, authenticated;
UPDATE schema_version SET version = 4 WHERE singleton = 1;
