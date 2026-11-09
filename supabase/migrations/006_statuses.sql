-- Status updates that disappear after 24 hours, and who has seen each one.
SET LOCAL search_path TO relay;

CREATE TABLE statuses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  background TEXT,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX statuses_user ON statuses(user_id, expires_at);
CREATE TABLE status_views (
  status_id TEXT NOT NULL,
  viewer_id TEXT NOT NULL REFERENCES users(id),
  viewed_at BIGINT NOT NULL,
  PRIMARY KEY (status_id, viewer_id)
);
ALTER TABLE statuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE status_views ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE statuses FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE status_views FROM PUBLIC, anon, authenticated;
UPDATE schema_version SET version = 6 WHERE singleton = 1;
