-- A channel update's link card (server/extras.mjs), stored with the post as JSON so every reader sees the same card
-- (title, description, site, and a small thumbnail from the poster's phone or the page's own image). Additive.
SET LOCAL search_path TO relay;

ALTER TABLE channel_posts ADD COLUMN link_preview TEXT;

UPDATE schema_version SET version = 45 WHERE singleton = 1;
