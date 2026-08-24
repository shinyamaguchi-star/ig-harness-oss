-- Every campaign explicitly linked to a scheduled post should start only
-- after that post receives a real Instagram media id. Upgrade reservations
-- created under the previous "existing campaigns stay paused" behaviour.
UPDATE media_posts
SET campaign_auto_activate = 1,
    campaign_activation_status = 'pending'
WHERE status = 'scheduled'
  AND campaign_gate_id IS NOT NULL;
