-- Add group storage without altering existing direct conversations.
SET LOCAL search_path TO relay;

CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at BIGINT NOT NULL
);
CREATE TABLE group_members (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  auto_delete INTEGER NOT NULL DEFAULT 0 CHECK (auto_delete IN (0, 1)),
  joined_at BIGINT NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX group_members_user ON group_members(user_id, group_id);
CREATE TABLE group_messages (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES users(id),
  created_at BIGINT NOT NULL,
  content TEXT NOT NULL,
  expires_at BIGINT
);
CREATE INDEX group_messages_history ON group_messages(group_id, created_at, id);
CREATE INDEX group_messages_expiry ON group_messages(expires_at) WHERE expires_at IS NOT NULL;
ALTER TABLE groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE groups, group_members, group_messages FROM PUBLIC, anon, authenticated;
UPDATE schema_version SET version = 2 WHERE singleton = 1;
