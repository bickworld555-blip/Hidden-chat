-- Help Center articles, reports about people, and admin/suspension flags (server/admin.mjs). Additive only.
SET LOCAL search_path TO relay;

CREATE TABLE help_articles (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  published INTEGER NOT NULL DEFAULT 1,
  updated_at BIGINT NOT NULL,
  updated_by TEXT
);
CREATE TABLE user_reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES users(id),
  reported_id TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_at BIGINT NOT NULL,
  resolved_at BIGINT,
  resolved_by TEXT
);
CREATE INDEX user_reports_open ON user_reports(status, created_at);
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN suspended_at BIGINT;
ALTER TABLE group_reports ADD COLUMN status TEXT NOT NULL DEFAULT 'open';
ALTER TABLE help_articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE help_articles, user_reports FROM PUBLIC, anon, authenticated;
UPDATE schema_version SET version = 13 WHERE singleton = 1;
