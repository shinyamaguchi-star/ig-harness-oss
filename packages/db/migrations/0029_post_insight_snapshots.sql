-- Record the actual publish time so insight checkpoints are anchored to the
-- moment Instagram accepted the post rather than its requested schedule.
ALTER TABLE media_posts ADD COLUMN published_at TEXT;

-- One immutable cumulative snapshot for each post/checkpoint. Metrics that
-- Instagram does not expose for a media type remain NULL and are listed in
-- unavailable_metrics; NULL must never be presented as a numeric zero.
CREATE TABLE IF NOT EXISTS post_insight_snapshots (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  media_post_id TEXT NOT NULL,
  instagram_media_id TEXT NOT NULL,
  checkpoint_hours INTEGER NOT NULL CHECK (checkpoint_hours IN (24,48,72,96,120,144,168)),
  target_at TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  views INTEGER,
  reach INTEGER,
  likes INTEGER,
  comments INTEGER,
  saved INTEGER,
  shares INTEGER,
  total_interactions INTEGER,
  profile_visits INTEGER,
  follows INTEGER,
  avg_watch_time_ms INTEGER,
  total_watch_time_ms INTEGER,
  replies INTEGER,
  unavailable_metrics TEXT NOT NULL DEFAULT '[]',
  raw_metrics TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(media_post_id, checkpoint_hours),
  FOREIGN KEY (media_post_id) REFERENCES media_posts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_post_insight_snapshots_account_post
  ON post_insight_snapshots(account_id, media_post_id, checkpoint_hours);

CREATE INDEX IF NOT EXISTS idx_media_posts_insight_due
  ON media_posts(account_id, status, published_at)
  WHERE status = 'published' AND published_media_id IS NOT NULL;
