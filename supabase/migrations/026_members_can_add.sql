-- Group permissions › Members can › Add other members (server/parity.mjs). Off keeps adding to admins. Additive.
SET LOCAL search_path TO relay;

ALTER TABLE groups ADD COLUMN members_can_add INTEGER NOT NULL DEFAULT 0;

UPDATE schema_version SET version = 26 WHERE singleton = 1;
