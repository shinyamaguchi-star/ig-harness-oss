-- The follow-up cron previously used idx_gate_deliveries_status. That scanned
-- every delivered row on every tick even when next_followup_at was NULL. On a
-- busy account this can exhaust the D1 Free daily row-read allowance shortly
-- before its 00:00 UTC reset (09:00 JST), making reservation writes return 500.
CREATE INDEX IF NOT EXISTS idx_gate_deliveries_followup_due
  ON gate_deliveries(status, next_followup_at, gate_id)
  WHERE next_followup_at IS NOT NULL;
