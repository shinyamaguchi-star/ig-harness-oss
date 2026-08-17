-- Optional Reel cover configuration. `cover_url` is a public image URL;
-- `thumb_offset_ms` selects a frame from the video when no image is set.
ALTER TABLE media_posts ADD COLUMN cover_url TEXT;
ALTER TABLE media_posts ADD COLUMN thumb_offset_ms INTEGER
  CHECK (thumb_offset_ms IS NULL OR thumb_offset_ms >= 0);
