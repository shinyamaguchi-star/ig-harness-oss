import { describe, expect, it, vi } from 'vitest';
import {
  collectPostInsights,
  metricsForPostType,
  numericInsightValue,
  postTypeForInstagramMedia,
} from '../post-insights.js';

const POST = {
  media_post_id: 'post-1',
  account_id: 'account-1',
  instagram_media_id: 'ig-media-1',
  post_type: 'feed_image' as const,
  title: 'test',
  caption: null,
  published_at: '2026-09-01T09:00:00.000+09:00',
  checkpoint_hours: 24 as const,
  target_at: '2026-09-02T09:00:00.000+09:00',
};

describe('post insight metric selection', () => {
  it('maps Instagram media created outside Harness to a supported post type', () => {
    expect(postTypeForInstagramMedia({ media_type: 'VIDEO', media_product_type: 'REELS' })).toBe('reel');
    expect(postTypeForInstagramMedia({ media_type: 'CAROUSEL_ALBUM', media_product_type: 'FEED' })).toBe('carousel');
    expect(postTypeForInstagramMedia({ media_type: 'IMAGE', media_product_type: 'FEED' })).toBe('feed_image');
  });

  it('uses views rather than deprecated impressions', () => {
    const metrics = metricsForPostType('feed_image');
    expect(metrics).toContain('views');
    expect(metrics).not.toContain('impressions');
    expect(metrics).toContain('profile_visits');
    expect(metrics).toContain('follows');
  });

  it('requests watch-time metrics only for reels', () => {
    expect(metricsForPostType('reel')).toContain('ig_reels_avg_watch_time');
    expect(metricsForPostType('feed_image')).not.toContain('ig_reels_avg_watch_time');
  });
});
describe('numericInsightValue', () => {
  it('reads total_value and legacy values shapes', () => {
    expect(numericInsightValue({ name: 'views', total_value: { value: 42 } })).toBe(42);
    expect(numericInsightValue({ name: 'reach', values: [{ value: '12' }] })).toBe(12);
    expect(numericInsightValue({ name: 'reach', total_value: { value: null } })).toBeNull();
  });
});

describe('collectPostInsights', () => {
  it('collects a supported group in one request', async () => {
    const client = {
      getMediaInsights: vi.fn(async (_id: string, metrics: string[]) =>
        metrics.map((name, index) => ({ name, total_value: { value: index + 1 } })),
      ),
      getMediaEngagementCounts: vi.fn(async () => ({})),
    };
    const result = await collectPostInsights(client as never, POST);
    expect(result.metrics.views).toBe(1);
    expect(result.unavailableMetrics).toEqual([]);
    expect(client.getMediaInsights).toHaveBeenCalledTimes(1);
    expect(client.getMediaEngagementCounts).not.toHaveBeenCalled();
  });

  it('isolates unsupported metrics and falls back to media engagement fields', async () => {
    const client = {
      getMediaInsights: vi.fn(async (_id: string, metrics: string[]) => {
        if (metrics.length > 1) throw new Error('metric is not supported');
        if (metrics[0] === 'profile_visits' || metrics[0] === 'likes') {
          throw new Error('This metric is not supported for this media product type');
        }
        return [{ name: metrics[0], total_value: { value: 7 } }];
      }),
      getMediaEngagementCounts: vi.fn(async () => ({ like_count: 19, comments_count: 3 })),
    };
    const result = await collectPostInsights(client as never, POST);
    expect(result.metrics.likes).toBe(19);
    expect(result.metrics.comments).toBe(7);
    expect(result.unavailableMetrics).toContain('profile_visits');
    expect(result.unavailableMetrics).not.toContain('likes');
  });

  it('throws transient failures so cron retries instead of saving partial data', async () => {
    const client = {
      getMediaInsights: vi.fn(async () => {
        throw new Error('Instagram API error 500: transient');
      }),
      getMediaEngagementCounts: vi.fn(async () => ({})),
    };
    await expect(collectPostInsights(client as never, POST)).rejects.toThrow('transient');
  });
});
