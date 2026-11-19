-- Hidden Messenger Support (server/support.mjs): attachments on support replies (a photo, video or PDF kept in the
-- data directory) and campaigns, one message from the admin console to every active account. Additive.
SET LOCAL search_path TO relay;

CREATE TABLE support_media (
  id TEXT PRIMARY KEY,
  disk_name TEXT NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  size BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
ALTER TABLE support_media ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE support_media FROM PUBLIC, anon, authenticated;

CREATE TABLE support_campaigns (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  media_id TEXT REFERENCES support_media(id),
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
ALTER TABLE support_campaigns ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE support_campaigns FROM PUBLIC, anon, authenticated;

ALTER TABLE support_messages ADD COLUMN media_id TEXT REFERENCES support_media(id);
ALTER TABLE support_messages ADD COLUMN campaign_id TEXT REFERENCES support_campaigns(id);
CREATE INDEX support_messages_campaign ON support_messages(campaign_id) WHERE campaign_id IS NOT NULL;

UPDATE schema_version SET version = 41 WHERE singleton = 1;
