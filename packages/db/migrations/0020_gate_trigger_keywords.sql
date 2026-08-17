-- Store multiple comment trigger keywords as a JSON string array.
-- Existing gates continue to use trigger_keyword; the service falls back to
-- that legacy column whenever this new column is NULL.
ALTER TABLE engagement_gates ADD COLUMN trigger_keywords TEXT;
