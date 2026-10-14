-- Opt-in rolling audiences for long-running broadcasts. Completed queue rows
-- remain in place, so a recipient is never added twice to the same broadcast.
-- The follower cursor makes each refresh incremental instead of rescanning the
-- complete audience on every cron tick.
ALTER TABLE broadcasts ADD COLUMN auto_append_recipients INTEGER NOT NULL DEFAULT 0
  CHECK(auto_append_recipients IN (0, 1));

ALTER TABLE broadcasts ADD COLUMN audience_cursor_follower_id INTEGER NOT NULL DEFAULT 0;

-- A transient Meta/network limit pauses new dispatches while the already
-- claimed recipient is retried with backoff.
ALTER TABLE broadcasts ADD COLUMN backoff_until TEXT;
