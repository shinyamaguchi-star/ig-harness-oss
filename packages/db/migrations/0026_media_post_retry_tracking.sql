-- Track durable retry progress for scheduled Instagram publications.
-- NULL next_retry_at means the post may be processed on the next cron tick.
ALTER TABLE media_posts ADD COLUMN last_attempt_at TEXT;
ALTER TABLE media_posts ADD COLUMN next_retry_at TEXT;

CREATE INDEX IF NOT EXISTS idx_media_posts_retry_due
  ON media_posts(account_id, status, next_retry_at, scheduled_at);
