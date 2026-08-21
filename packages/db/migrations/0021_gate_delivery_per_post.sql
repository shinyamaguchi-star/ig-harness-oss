-- Scope comment-campaign idempotency to one delivery per follower per post.
-- DM-keyword and story-mention campaigns continue to use NULL so they remain
-- one delivery per follower per campaign.

ALTER TABLE gate_deliveries ADD COLUMN trigger_post_id TEXT;

CREATE INDEX IF NOT EXISTS idx_gate_deliveries_gate_follower_post
  ON gate_deliveries(gate_id, follower_id, trigger_post_id);

-- Historical delivery rows did not record their source post. For campaigns
-- that target exactly one post, the source is unambiguous and can be safely
-- reconstructed. Multi-post campaigns remain NULL because guessing would
-- incorrectly suppress one of their posts after this upgrade.
UPDATE gate_deliveries
SET trigger_post_id = (
  SELECT MIN(gtp.post_id)
  FROM gate_target_posts gtp
  WHERE gtp.gate_id = gate_deliveries.gate_id
)
WHERE trigger_post_id IS NULL
  AND 1 = (
    SELECT COUNT(*)
    FROM gate_target_posts gtp
    WHERE gtp.gate_id = gate_deliveries.gate_id
  );

-- Backward-compatible fallback for older single-post campaigns that still
-- only have engagement_gates.target_post_id and no junction-table rows.
UPDATE gate_deliveries
SET trigger_post_id = (
  SELECT eg.target_post_id
  FROM engagement_gates eg
  WHERE eg.id = gate_deliveries.gate_id
)
WHERE trigger_post_id IS NULL
  AND 0 = (
    SELECT COUNT(*)
    FROM gate_target_posts gtp
    WHERE gtp.gate_id = gate_deliveries.gate_id
  )
  AND EXISTS (
    SELECT 1
    FROM engagement_gates eg
    WHERE eg.id = gate_deliveries.gate_id
      AND eg.trigger_type = 'comment_on_post'
      AND eg.target_post_id IS NOT NULL
  );
