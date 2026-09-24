import { Hono } from 'hono';
import { listPostInsightSeries, type PostInsightSeriesRow } from '@ig-harness/db';
import { resolveAccount } from '../lib/accounts.js';
import type { Env } from '../index.js';

const postInsights = new Hono<Env>();

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function serialize(row: PostInsightSeriesRow) {
  return {
    id: row.id,
    mediaPostId: row.media_post_id,
    instagramMediaId: row.instagram_media_id,
    postTitle: row.post_title,
    postCaption: row.post_caption,
    postType: row.post_type,
    publishedAt: row.published_at,
    checkpointHours: row.checkpoint_hours,
    targetAt: row.target_at,
    capturedAt: row.captured_at,
    views: row.views,
    reach: row.reach,
    likes: row.likes,
    comments: row.comments,
    saved: row.saved,
    shares: row.shares,
    totalInteractions: row.total_interactions,
    profileVisits: row.profile_visits,
    follows: row.follows,
    avgWatchTimeMs: row.avg_watch_time_ms,
    totalWatchTimeMs: row.total_watch_time_ms,
    replies: row.replies,
    unavailableMetrics: parseStringArray(row.unavailable_metrics),
  };
}

postInsights.get('/api/post-insights', async (c) => {
  const account = await resolveAccount(c);
  if (!account) return c.json({ success: false, error: 'account not found' }, 404);
  try {
    const rows = await listPostInsightSeries(c.env.DB, account.id);
    return c.json({ success: true, data: rows.map(serialize) });
  } catch (error) {
    console.error('[post-insights] list failed:', error);
    return c.json({ success: false, error: '投稿分析の取得に失敗しました' }, 500);
  }
});

export { postInsights };
