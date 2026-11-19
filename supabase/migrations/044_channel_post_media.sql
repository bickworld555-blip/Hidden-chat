-- A photo, video or file on a channel update (server/extras.mjs). Channels are public: whoever can read the channel
-- may open the attachment while the post names it, and it is removed with the post or the channel. Additive.
SET LOCAL search_path TO relay;

ALTER TABLE channel_posts ADD COLUMN media_id TEXT;
-- A video's frame: a small JPEG data URL made on the poster's phone, shown before the video plays.
ALTER TABLE channel_posts ADD COLUMN poster TEXT;
CREATE INDEX channel_posts_media ON channel_posts(media_id) WHERE media_id IS NOT NULL;

UPDATE schema_version SET version = 44 WHERE singleton = 1;
