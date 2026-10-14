-- Optional per-broadcast calendar-day cap. The worker counts delivery
-- attempts in Asia/Tokyo and automatically continues pending recipients on
-- the next day. NULL preserves the legacy unlimited behavior.
ALTER TABLE broadcasts ADD COLUMN daily_limit INTEGER
  CHECK(daily_limit IS NULL OR daily_limit > 0);
