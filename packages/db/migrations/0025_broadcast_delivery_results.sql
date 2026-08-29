-- Persist aggregate and per-recipient broadcast results so operators can
-- understand partial failures without reading Worker logs.
ALTER TABLE broadcasts ADD COLUMN total_target INTEGER NOT NULL DEFAULT 0;
ALTER TABLE broadcasts ADD COLUMN success_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE broadcasts ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE broadcasts ADD COLUMN last_error TEXT;

CREATE TABLE IF NOT EXISTS broadcast_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  broadcast_id INTEGER NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  follower_id INTEGER REFERENCES followers(id) ON DELETE SET NULL,
  recipient_igsid TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('success', 'failed')),
  error_code TEXT,
  error_message TEXT,
  attempted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now')))
);

CREATE INDEX IF NOT EXISTS idx_broadcast_deliveries_broadcast
  ON broadcast_deliveries(broadcast_id, attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_broadcast_deliveries_status
  ON broadcast_deliveries(broadcast_id, status);
