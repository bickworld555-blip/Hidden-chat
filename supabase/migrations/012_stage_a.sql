-- End-to-end encrypted poll votes and the Stage A features (channels, broadcast lists, scheduled messages,
-- status privacy, call links, business hours). Sealed values are ciphertext the server cannot read.
SET LOCAL search_path TO relay;

CREATE TABLE poll_sealed_votes (
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  sealed TEXT NOT NULL,
  voted_at BIGINT NOT NULL,
  PRIMARY KEY (message_id, user_id)
);
ALTER TABLE poll_sealed_votes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE poll_sealed_votes FROM PUBLIC, anon, authenticated;
CREATE TABLE broadcast_lists (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, created_at BIGINT NOT NULL);
CREATE TABLE broadcast_members (list_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), PRIMARY KEY (list_id, user_id));
CREATE TABLE channels (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at BIGINT NOT NULL);
CREATE TABLE channel_followers (channel_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), followed_at BIGINT NOT NULL, PRIMARY KEY (channel_id, user_id));
CREATE TABLE channel_posts (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, author_id TEXT NOT NULL REFERENCES users(id), content TEXT NOT NULL, created_at BIGINT NOT NULL);
CREATE INDEX channel_posts_channel ON channel_posts(channel_id, created_at);
CREATE TABLE channel_reactions (post_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), emoji TEXT NOT NULL, PRIMARY KEY (post_id, user_id));
CREATE TABLE scheduled_messages (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), receiver_id TEXT NOT NULL REFERENCES users(id), content TEXT NOT NULL, send_at BIGINT NOT NULL, created_at BIGINT NOT NULL);
CREATE INDEX scheduled_messages_due ON scheduled_messages(send_at);
CREATE TABLE status_audience_members (owner_id TEXT NOT NULL REFERENCES users(id), user_id TEXT NOT NULL REFERENCES users(id), PRIMARY KEY (owner_id, user_id));
CREATE TABLE call_links (code TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), mode TEXT NOT NULL, created_at BIGINT NOT NULL, revoked_at BIGINT);
ALTER TABLE users ADD COLUMN status_audience TEXT NOT NULL DEFAULT 'contacts';
ALTER TABLE business_profiles ADD COLUMN away_hours TEXT;
ALTER TABLE broadcast_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcast_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_followers ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE status_audience_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE broadcast_lists, broadcast_members, channels, channel_followers, channel_posts, channel_reactions,
  scheduled_messages, status_audience_members, call_links FROM PUBLIC, anon, authenticated;
UPDATE schema_version SET version = 12 WHERE singleton = 1;
