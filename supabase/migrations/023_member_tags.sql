-- Member tags (server/parity.mjs): a short label each member sets for themselves in a group. Additive.
SET LOCAL search_path TO relay;

ALTER TABLE group_members ADD COLUMN member_tag TEXT NOT NULL DEFAULT '';

UPDATE schema_version SET version = 23 WHERE singleton = 1;
