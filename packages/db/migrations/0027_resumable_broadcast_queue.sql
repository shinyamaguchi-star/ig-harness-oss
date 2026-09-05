-- Durable recipient snapshot for resumable broadcasts. Each cron invocation
-- claims at most one small batch, so bulk delivery cannot monopolize the
-- worker ahead of scheduled posts and campaign follow-ups.
CREATE TABLE IF NOT EXISTS broadcast_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  broadcast_id INTEGER NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  follower_id INTEGER REFERENCES followers(id) ON DELETE SET NULL,
  recipient_igsid TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'processing', 'success', 'failed')),
  error_code TEXT,
  error_message TEXT,
  claimed_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now'))),
  UNIQUE(broadcast_id, recipient_igsid)
);

CREATE INDEX IF NOT EXISTS idx_broadcast_queue_pending
  ON broadcast_queue(broadcast_id, status, id);
CREATE INDEX IF NOT EXISTS idx_broadcast_queue_claimed
  ON broadcast_queue(status, claimed_at);
