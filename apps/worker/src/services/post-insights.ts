import {
  getDuePostInsightCheckpoints,
  importPublishedMediaForInsights,
  savePostInsightSnapshot,
  type DuePostInsightCheckpoint,
} from '@ig-harness/db';
import type { InstagramClient, MediaInfo, MediaInsightResult } from '@ig-harness/ig-sdk';

const COMMON_METRICS = [
  'views',
  'reach',
  'likes',
  'comments',
  'saved',
  'shares',
  'total_interactions',
] as const;

export function postTypeForInstagramMedia(
  media: Pick<MediaInfo, 'media_type' | 'media_product_type'>,
): DuePostInsightCheckpoint['post_type'] {
  if (media.media_product_type === 'STORY') return 'story';
  if (media.media_product_type === 'REELS') return 'reel';
  if (media.media_type === 'CAROUSEL_ALBUM') return 'carousel';
  return 'feed_image';
}

function importedPostTitle(caption?: string): string {
  const firstLine = caption?.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return firstLine ? firstLine.slice(0, 80) : 'Instagram直接投稿';
}

/** Discover posts made directly from Instagram (including smartphone posts)
 * and register them for the same checkpoint collector used by Harness posts.
 * A short lookback avoids relabeling old cumulative totals as historical +24h
 * values, while still recovering posts missed during a temporary outage. */
export async function syncExternalPublishedMedia(
  db: D1Database,
  client: Pick<InstagramClient, 'getMyMedia'>,
  accountId: string,
  now = new Date(),
): Promise<number> {
  const recent = await client.getMyMedia(25);
  const earliest = now.getTime() - 72 * 60 * 60 * 1000;
  let imported = 0;

  for (const item of recent) {
    const published = new Date(item.timestamp);
    if (!Number.isFinite(published.getTime()) || published.getTime() < earliest) continue;
    if (published.getTime() > now.getTime() + 5 * 60 * 1000) continue;

    const postType = postTypeForInstagramMedia(item);
    const sourceUrl = item.media_url ?? item.thumbnail_url;
    const didImport = await importPublishedMediaForInsights(db, {
      accountId,
      instagramMediaId: item.id,
      postType,
      title: importedPostTitle(item.caption),
      caption: item.caption ?? null,
      media: sourceUrl
        ? [{ url: sourceUrl, type: item.media_type === 'VIDEO' ? 'video' : 'image' }]
        : [],
      publishedAt: published.toISOString(),
    });
    if (didImport) imported += 1;
  }
  return imported;
}

export function metricsForPostType(
  postType: DuePostInsightCheckpoint['post_type'],
): string[] {
  if (postType === 'reel') {
    return [
      ...COMMON_METRICS,
      'ig_reels_avg_watch_time',
      'ig_reels_video_view_total_time',
    ];
  }
  if (postType === 'story') {
    return ['views', 'reach', 'replies', 'shares', 'profile_visits', 'follows'];
  }
  return [...COMMON_METRICS, 'profile_visits', 'follows'];
}

/** Meta uses both total_value and values depending on metric/API version. */
export function numericInsightValue(result: MediaInsightResult): number | null {
  const candidates: unknown[] = [
    result.total_value?.value,
    result.values?.at(-1)?.value,
  ];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function unsupportedMetricError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error);
  return /metric.+(?:not valid|invalid|not supported|unsupported)|unsupported.+metric|does not support this metric|period.+not valid/i.test(
    message,
  );
}

export interface CollectedPostInsights {
  metrics: Record<string, number>;
  unavailableMetrics: string[];
}

/** Try one efficient multi-metric call first. When Meta rejects a combination
 * because one metric is not valid for this media type/API version, retry each
 * metric separately and record unsupported values as unavailable. Unknown,
 * auth and transient errors are thrown so cron retries instead of persisting a
 * misleading partial snapshot. */
export async function collectPostInsights(
  client: Pick<InstagramClient, 'getMediaInsights' | 'getMediaEngagementCounts'>,
  post: DuePostInsightCheckpoint,
): Promise<CollectedPostInsights> {
  const requested = metricsForPostType(post.post_type);
  const metrics: Record<string, number> = {};
  const unavailable = new Set<string>();

  try {
    const results = await client.getMediaInsights(post.instagram_media_id, requested);
    for (const result of results) {
      const value = numericInsightValue(result);
      if (value === null) unavailable.add(result.name);
      else metrics[result.name] = value;
    }
    for (const metric of requested) {
      if (!(metric in metrics)) unavailable.add(metric);
    }
  } catch {
    // A single unsupported metric makes Meta reject the whole list, so isolate
    // the invalid metric. Unknown failures must be retried, not snapshotted.
    for (const metric of requested) {
      try {
        const results = await client.getMediaInsights(post.instagram_media_id, [metric]);
        const found = results.find((item) => item.name === metric) ?? results[0];
        const value = found ? numericInsightValue(found) : null;
        if (value === null) unavailable.add(metric);
        else metrics[metric] = value;
      } catch (error) {
        if (unsupportedMetricError(error)) unavailable.add(metric);
        else throw error;
      }
    }
  }

  if (
    (requested.includes('likes') && !('likes' in metrics)) ||
    (requested.includes('comments') && !('comments' in metrics))
  ) {
    const counts = await client.getMediaEngagementCounts(post.instagram_media_id);
    if (requested.includes('likes') && !('likes' in metrics) && typeof counts.like_count === 'number') {
      metrics.likes = counts.like_count;
      unavailable.delete('likes');
    }
    if (requested.includes('comments') && !('comments' in metrics) && typeof counts.comments_count === 'number') {
      metrics.comments = counts.comments_count;
      unavailable.delete('comments');
    }
  }

  return { metrics, unavailableMetrics: [...unavailable] };
}

function metric(metrics: Record<string, number>, name: string): number | null {
  return typeof metrics[name] === 'number' ? Math.round(metrics[name]) : null;
}

/** Process a small bounded batch; failures remain missing and are retried on
 * the next cron. The unique DB key makes repeated/racing invocations safe. */
export async function processPostInsightSnapshots(
  db: D1Database,
  client: Pick<InstagramClient, 'getMediaInsights' | 'getMediaEngagementCounts'>,
  accountId: string,
  now?: string,
): Promise<number> {
  // Two posts per tick keeps the worst-case per-metric fallback comfortably
  // below Workers/Meta subrequest limits. Normal grouped requests catch up fast.
  const due = await getDuePostInsightCheckpoints(db, accountId, now, 2);
  let saved = 0;
  for (const post of due) {
    try {
      const collected = await collectPostInsights(client, post);
      const inserted = await savePostInsightSnapshot(db, {
        account_id: post.account_id,
        media_post_id: post.media_post_id,
        instagram_media_id: post.instagram_media_id,
        checkpoint_hours: post.checkpoint_hours,
        target_at: post.target_at,
        views: metric(collected.metrics, 'views'),
        reach: metric(collected.metrics, 'reach'),
        likes: metric(collected.metrics, 'likes'),
        comments: metric(collected.metrics, 'comments'),
        saved: metric(collected.metrics, 'saved'),
        shares: metric(collected.metrics, 'shares'),
        total_interactions: metric(collected.metrics, 'total_interactions'),
        profile_visits: metric(collected.metrics, 'profile_visits'),
        follows: metric(collected.metrics, 'follows'),
        avg_watch_time_ms: metric(collected.metrics, 'ig_reels_avg_watch_time'),
        total_watch_time_ms: metric(collected.metrics, 'ig_reels_video_view_total_time'),
        replies: metric(collected.metrics, 'replies'),
        unavailableMetrics: collected.unavailableMetrics,
        rawMetrics: collected.metrics,
      });
      if (inserted) saved += 1;
    } catch (error) {
      console.error(
        `[post-insights] checkpoint failed post=${post.media_post_id} hours=${post.checkpoint_hours}:`,
        error,
      );
    }
  }
  return saved;
}
