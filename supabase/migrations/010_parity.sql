-- WhatsApp (Business) feature parity: message edits, account-synced stars, archived chats, pinned messages, group
-- administration and communities, the business suite and two-step verification (server/parity.mjs).
SET LOCAL search_path TO relay;

ALTER TABLE messages ADD COLUMN edited_at BIGINT;
ALTER TABLE group_messages ADD COLUMN edited_at BIGINT;
ALTER TABLE groups ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE groups ADD COLUMN only_admins_send INTEGER NOT NULL DEFAULT 0;
ALTER TABLE groups ADD COLUMN only_admins_edit INTEGER NOT NULL DEFAULT 0;
ALTER TABLE groups ADD COLUMN approve_joins INTEGER NOT NULL DEFAULT 0;
ALTER TABLE groups ADD COLUMN invite_code TEXT;
ALTER TABLE groups ADD COLUMN community_id TEXT;
ALTER TABLE groups ADD COLUMN is_announcement INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN two_step_hash TEXT;
ALTER TABLE users ADD COLUMN two_step_set_at BIGINT;
CREATE UNIQUE INDEX groups_invite_code ON groups(invite_code) WHERE invite_code IS NOT NULL;
CREATE INDEX groups_community ON groups(community_id) WHERE community_id IS NOT NULL;

CREATE TABLE group_join_requests (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  requested_at BIGINT NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE TABLE communities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at BIGINT NOT NULL,
  announcement_group_id TEXT NOT NULL
);
CREATE TABLE message_stars (
  user_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  chat_key TEXT NOT NULL,
  starred_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, message_id)
);
CREATE TABLE chat_prefs (
  user_id TEXT NOT NULL,
  chat_key TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, chat_key)
);
CREATE TABLE pinned_messages (
  chat_key TEXT NOT NULL,
  message_id TEXT NOT NULL,
  pinned_by TEXT NOT NULL,
  pinned_at BIGINT NOT NULL,
  PRIMARY KEY (chat_key, message_id)
);
CREATE TABLE business_profiles (
  user_id TEXT PRIMARY KEY,
  away_enabled INTEGER NOT NULL DEFAULT 0,
  away_text TEXT NOT NULL DEFAULT '',
  away_schedule TEXT NOT NULL DEFAULT 'always' CHECK (away_schedule IN ('always', 'offline')),
  greeting_enabled INTEGER NOT NULL DEFAULT 0,
  greeting_text TEXT NOT NULL DEFAULT '',
  updated_at BIGINT NOT NULL
);
CREATE TABLE business_auto_replies (
  user_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('away', 'greeting')),
  sent_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, peer_id, kind)
);
CREATE TABLE catalog_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  hidden INTEGER NOT NULL DEFAULT 0,
  image_disk_name TEXT,
  image_type TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX catalog_items_user ON catalog_items(user_id, created_at);
CREATE TABLE labels (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color INTEGER NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX labels_user ON labels(user_id);
CREATE TABLE label_chats (
  label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  chat_key TEXT NOT NULL,
  PRIMARY KEY (label_id, chat_key)
);
CREATE TABLE quick_replies (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  shortcut TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE (user_id, shortcut)
);
ALTER TABLE group_join_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE communities ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_stars ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE pinned_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_auto_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE label_chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE quick_replies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE group_join_requests, communities, message_stars, chat_prefs, pinned_messages, business_profiles,
  business_auto_replies, catalog_items, labels, label_chats, quick_replies FROM PUBLIC, anon, authenticated;
UPDATE schema_version SET version = 10 WHERE singleton = 1;
