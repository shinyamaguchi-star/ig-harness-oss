-- Link a scheduled media post to the engagement gate that should become
-- active only after Instagram returns the real published media id.
ALTER TABLE media_posts ADD COLUMN campaign_gate_id TEXT
  REFERENCES engagement_gates(id) ON DELETE SET NULL;
ALTER TABLE media_posts ADD COLUMN campaign_activation_status TEXT
  CHECK (campaign_activation_status IN ('pending','active','failed','canceled'));
ALTER TABLE media_posts ADD COLUMN campaign_error TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_media_posts_campaign_gate
  ON media_posts(campaign_gate_id)
  WHERE campaign_gate_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_media_posts_campaign_activation
  ON media_posts(account_id, campaign_activation_status);
