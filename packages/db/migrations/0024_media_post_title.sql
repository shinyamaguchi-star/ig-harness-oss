-- Operator-only label for distinguishing scheduled and historical posts.
-- This value is never sent to Instagram.
ALTER TABLE media_posts ADD COLUMN title TEXT;
