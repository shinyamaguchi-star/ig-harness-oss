-- One comment campaign may be prepared for multiple scheduled posts.
-- Each media post still has at most one campaign through campaign_gate_id.
DROP INDEX IF EXISTS idx_media_posts_campaign_gate;

CREATE INDEX IF NOT EXISTS idx_media_posts_campaign_gate
  ON media_posts(campaign_gate_id)
  WHERE campaign_gate_id IS NOT NULL;

-- Campaigns created specifically from the scheduled-post wizard should be
-- activated after publication. Existing campaigns linked later keep their
-- current active/paused state instead of being resumed unexpectedly.
ALTER TABLE media_posts ADD COLUMN campaign_auto_activate INTEGER NOT NULL DEFAULT 0;
