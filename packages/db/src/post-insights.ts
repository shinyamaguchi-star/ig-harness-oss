import { jstNow, toJstString } from './utils.js';

export const INSIGHT_CHECKPOINT_HOURS = [24, 168] as const;
export type InsightCheckpointHours = (typeof INSIGHT_CHECKPOINT_HOURS)[number];

export interface DuePostInsightCheckpoint {
  media_post_id: string;
  account_id: string;
  instagram_media_id: string;
  post_type: 'feed_image' | 'carousel' | 'reel' | 'story';
  title: string | null;
  caption: string | null;
  published_at: string;
  checkpoint_hours: InsightCheckpointHours;
  target_at: string;
}

export interface PostInsightSnapshot {
  id: string;
  account_id: string;
  media_post_id: string;
  instagram_media_id: string;
  checkpoint_hours: InsightCheckpointHours;
  target_at: string;
  captured_at: string;
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  saved: number | null;
  shares: number | null;
  total_interactions: number | null;
  profile_visits: number | null;
  follows: number | null;
  avg_watch_time_ms: number | null;
  total_watch_time_ms: number | null;
  replies: number | null;
  unavailable_metrics: string;
  raw_metrics: string;
  created_at: string;
}

export interface PostInsightSeriesRow extends PostInsightSnapshot {
  post_title: string | null;
  post_caption: string | null;
  post_type: 'feed_image' | 'carousel' | 'reel' | 'story';
  published_at: string;
}

export interface ImportPublishedMediaForInsightsInput {
  accountId: string;
  instagramMediaId: string;
  postType: 'feed_image' | 'carousel' | 'reel' | 'story';
  title: string | null;
  caption: string | null;
  media: Array<{ url: string; type: 'image' | 'video' }>;
  publishedAt: string;
}

/** Register media that was published outside IG Harness so the normal +24h
 * and +168h insight collector can track it. If a single published placeholder
 * exists near the Instagram timestamp (the smartphone-post workflow), link
 * that row instead of creating a duplicate. */
export async function importPublishedMediaForInsights(
  db: D1Database,
  input: ImportPublishedMediaForInsightsInput,
): Promise<boolean> {
  const existing = await db
    .prepare(
      `SELECT id FROM media_posts
       WHERE account_id = ? AND published_media_id = ?
       LIMIT 1`,
    )
    .bind(input.accountId, input.instagramMediaId)
    .first<{ id: string }>();
  if (existing) return false;

  const candidates = await db
    .prepare(
      `SELECT id FROM media_posts
       WHERE account_id = ?
         AND status = 'published'
         AND published_media_id IS NULL
         AND published_at IS NOT NULL
         AND ABS(strftime('%s', published_at) - strftime('%s', ?)) <= 21600
       ORDER BY ABS(strftime('%s', published_at) - strftime('%s', ?)) ASC
       LIMIT 2`,
    )
    .bind(input.accountId, input.publishedAt, input.publishedAt)
    .all<{ id: string }>();

  const now = jstNow();
  if (candidates.results.length === 1) {
    const linked = await db
      .prepare(
        `UPDATE media_posts
         SET published_media_id = ?, published_at = ?, scheduled_at = ?,
             post_type = ?, media = ?, caption = COALESCE(caption, ?),
             title = COALESCE(title, ?), updated_at = ?
         WHERE id = ? AND account_id = ? AND published_media_id IS NULL`,
      )
      .bind(
        input.instagramMediaId,
        input.publishedAt,
        input.publishedAt,
        input.postType,
        JSON.stringify(input.media),
        input.caption,
        input.title,
        now,
        candidates.results[0].id,
        input.accountId,
      )
      .run();
    if ((linked.meta.changes ?? 0) === 1) return true;
  }

  const inserted = await db
    .prepare(
      `INSERT INTO media_posts
       (id, account_id, title, post_type, media, caption, cover_url,
        thumb_offset_ms, status, scheduled_at, creation_id,
        child_creation_ids, published_media_id, published_at, attempt_count,
        last_attempt_at, next_retry_at, error, campaign_gate_id,
        campaign_activation_status, campaign_error, campaign_auto_activate,
        created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, NULL, NULL, 'published', ?, NULL, NULL, ?, ?,
              0, NULL, NULL, NULL, NULL, NULL, NULL, 0, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM media_posts
         WHERE account_id = ? AND published_media_id = ?
       )`,
    )
    .bind(
      crypto.randomUUID(),
      input.accountId,
      input.title,
      input.postType,
      JSON.stringify(input.media),
      input.caption,
      input.publishedAt,
      input.instagramMediaId,
      input.publishedAt,
      now,
      now,
      input.accountId,
      input.instagramMediaId,
    )
    .run();
  return (inserted.meta.changes ?? 0) === 1;
}

/** Return the oldest uncollected checkpoint per post, capped to protect the
 * cron invocation and Meta rate limits. Only posts published after this
 * feature was installed have published_at; older posts are intentionally not
 * backfilled because current totals cannot reconstruct historical +24h data. */
export async function getDuePostInsightCheckpoints(
  db: D1Database,
  accountId: string,
  now: string = jstNow(),
  limit = 5,
): Promise<DuePostInsightCheckpoint[]> {
  const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 20);
  const result = await db
    .prepare(
      `WITH checkpoints(hours) AS (
         VALUES (24), (168)
       ), missing AS (
         SELECT p.id AS media_post_id,
                p.account_id,
                p.published_media_id AS instagram_media_id,
                p.post_type,
                p.title,
                p.caption,
                p.published_at,
                c.hours AS checkpoint_hours,
                datetime(p.published_at, '+' || c.hours || ' hours') AS target_at_utc
         FROM media_posts p
         CROSS JOIN checkpoints c
         LEFT JOIN post_insight_snapshots s
           ON s.media_post_id = p.id AND s.checkpoint_hours = c.hours
         WHERE p.account_id = ?
           AND p.status = 'published'
           AND p.published_media_id IS NOT NULL
           AND p.published_at IS NOT NULL
           AND s.id IS NULL
           AND datetime(p.published_at, '+' || c.hours || ' hours') <= datetime(?)
       )
       SELECT * FROM missing
       WHERE checkpoint_hours = (
         SELECT MIN(m2.checkpoint_hours) FROM missing m2
         WHERE m2.media_post_id = missing.media_post_id
       )
       ORDER BY target_at_utc ASC
       LIMIT ${boundedLimit}`,
    )
    .bind(accountId, now)
    .all<Omit<DuePostInsightCheckpoint, 'target_at'> & { target_at_utc: string }>();

  return result.results.map((row) => ({
    ...row,
    checkpoint_hours: Number(row.checkpoint_hours) as InsightCheckpointHours,
    target_at: toJstString(new Date(`${row.target_at_utc.replace(' ', 'T')}Z`)),
  }));
}

export type SavePostInsightSnapshotInput = Omit<
  PostInsightSnapshot,
  'id' | 'captured_at' | 'created_at' | 'unavailable_metrics' | 'raw_metrics'
> & {
  capturedAt?: string;
  unavailableMetrics: string[];
  rawMetrics: Record<string, number>;
};

export async function savePostInsightSnapshot(
  db: D1Database,
  input: SavePostInsightSnapshotInput,
): Promise<boolean> {
  const capturedAt = input.capturedAt ?? jstNow();
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO post_insight_snapshots
       (id, account_id, media_post_id, instagram_media_id, checkpoint_hours,
        target_at, captured_at, views, reach, likes, comments, saved, shares,
        total_interactions, profile_visits, follows, avg_watch_time_ms,
        total_watch_time_ms, replies, unavailable_metrics, raw_metrics, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      input.account_id,
      input.media_post_id,
      input.instagram_media_id,
      input.checkpoint_hours,
      input.target_at,
      capturedAt,
      input.views,
      input.reach,
      input.likes,
      input.comments,
      input.saved,
      input.shares,
      input.total_interactions,
      input.profile_visits,
      input.follows,
      input.avg_watch_time_ms,
      input.total_watch_time_ms,
      input.replies,
      JSON.stringify([...new Set(input.unavailableMetrics)].sort()),
      JSON.stringify(input.rawMetrics),
      capturedAt,
    )
    .run();
  return (result.meta.changes ?? 0) === 1;
}

export async function listPostInsightSeries(
  db: D1Database,
  accountId: string,
  limit = 1000,
): Promise<PostInsightSeriesRow[]> {
  const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 2000);
  const result = await db
    .prepare(
      `SELECT s.*, p.title AS post_title, p.caption AS post_caption,
              p.post_type, p.published_at
       FROM post_insight_snapshots s
       JOIN media_posts p ON p.id = s.media_post_id
       WHERE s.account_id = ?
       ORDER BY datetime(p.published_at) DESC,
                s.checkpoint_hours ASC
       LIMIT ${boundedLimit}`,
    )
    .bind(accountId)
    .all<PostInsightSeriesRow>();
  return result.results;
}
