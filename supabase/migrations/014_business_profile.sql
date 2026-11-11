-- Business profile shown to customers (server/parity.mjs): category, description, address, email, website.
-- Business hours stay in away_hours. Additive only.
SET LOCAL search_path TO relay;

ALTER TABLE business_profiles ADD COLUMN category TEXT NOT NULL DEFAULT '';
ALTER TABLE business_profiles ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE business_profiles ADD COLUMN address TEXT NOT NULL DEFAULT '';
ALTER TABLE business_profiles ADD COLUMN email TEXT NOT NULL DEFAULT '';
ALTER TABLE business_profiles ADD COLUMN website TEXT NOT NULL DEFAULT '';
UPDATE schema_version SET version = 14 WHERE singleton = 1;
