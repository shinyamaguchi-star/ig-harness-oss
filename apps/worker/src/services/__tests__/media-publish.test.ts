/**
 * Tests: media-publish state machine
 * scheduled → processing → published / failed, quota carry-over, retry cap.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@ig-harness/db', async (importOriginal) => {
  const original = await importOriginal<typeof import('@ig-harness/db')>();
  return {
    ...original,
    getDueMediaPosts: vi.fn().mockResolvedValue([]),
    getProcessingMediaPosts: vi.fn().mockResolvedValue([]),
    getPendingCampaignMediaPosts: vi.fn().mockResolvedValue([]),
    getMediaPostById: vi.fn().mockResolvedValue(null),
    getEngagementGate: vi.fn().mockResolvedValue(null),
    addGateTargetPost: vi.fn().mockResolvedValue(undefined),
    updateEngagementGate: vi.fn().mockResolvedValue(true),
    updateMediaPost: vi.fn().mockResolvedValue(null),
  };
});

import {
  getDueMediaPosts,
  getProcessingMediaPosts,
  getPendingCampaignMediaPosts,
  getMediaPostById,
  getEngagementGate,
  addGateTargetPost,
  updateEngagementGate,
  updateMediaPost,
} from '@ig-harness/db';
import { assertReelCoverFetchable, processMediaPosts, kickImmediate } from '../media-publish.js';

const db = {} as D1Database;

function makePost(overrides: Record<string, unknown> = {}) {
  return {
    id: 'post-1',
    account_id: 'acc-1',
    post_type: 'feed_image',
    media: JSON.stringify([{ url: 'https://example.com/a.jpg', type: 'image' }]),
    caption: 'hi',
    cover_url: null,
    thumb_offset_ms: null,
    status: 'scheduled',
    scheduled_at: '2026-07-23T10:00:00.000+09:00',
    creation_id: null,
    child_creation_ids: null,
    published_media_id: null,
    attempt_count: 0,
    error: null,
    campaign_gate_id: null,
    campaign_activation_status: null,
    campaign_error: null,
    campaign_auto_activate: 0,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    getPublishingLimit: vi.fn().mockResolvedValue({ quota_usage: 0, config: { quota_total: 100, quota_duration: 86400 } }),
    createMediaContainer: vi.fn().mockResolvedValue({ id: 'container-1' }),
    getContainerStatus: vi.fn().mockResolvedValue({ id: 'container-1', status_code: 'FINISHED' }),
    publishMedia: vi.fn().mockResolvedValue({ id: 'media-99' }),
    ...overrides,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPendingCampaignMediaPosts).mockResolvedValue([]);
  vi.mocked(getEngagementGate).mockResolvedValue(null);
  vi.mocked(addGateTargetPost).mockResolvedValue(undefined);
  vi.mocked(updateEngagementGate).mockResolvedValue(true);
  vi.mocked(updateMediaPost).mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('processMediaPosts — scheduled posts', () => {
  it('validates an IG Harness cover directly through R2 without self-fetching the Worker URL', async () => {
    const fetcher = vi.fn();
    const images = {
      get: vi.fn().mockResolvedValue({
        httpMetadata: { contentType: 'image/jpeg' },
        arrayBuffer: vi.fn().mockResolvedValue(
          new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer,
        ),
      }),
    } as unknown as R2Bucket;

    await assertReelCoverFetchable(
      'https://ig-harness-example.workers.dev/images/cover.jpg',
      fetcher as unknown as typeof fetch,
      images,
    );

    expect(images.get).toHaveBeenCalledWith('cover.jpg', {
      range: { offset: 0, length: 4096 },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('creates a container for a due feed image and moves it to processing', async () => {
    vi.mocked(getDueMediaPosts).mockResolvedValueOnce([makePost()] as any);
    const client = makeClient();
    await processMediaPosts(db, client, 'acc-1');
    expect(client.createMediaContainer).toHaveBeenCalledWith(
      expect.objectContaining({ imageUrl: 'https://example.com/a.jpg', caption: 'hi' }),
    );
    expect(updateMediaPost).toHaveBeenCalledWith(
      db,
      'post-1',
      expect.objectContaining({ status: 'processing', creation_id: 'container-1' }),
    );
  });

  it('carousel: creates child containers first, then parent with children ids', async () => {
    const post = makePost({
      post_type: 'carousel',
      media: JSON.stringify([
        { url: 'https://example.com/1.jpg', type: 'image' },
        { url: 'https://example.com/2.mp4', type: 'video' },
      ]),
    });
    vi.mocked(getDueMediaPosts).mockResolvedValueOnce([post] as any);
    const client = makeClient();
    client.createMediaContainer
      .mockResolvedValueOnce({ id: 'child-1' })
      .mockResolvedValueOnce({ id: 'child-2' })
      .mockResolvedValueOnce({ id: 'parent-1' });
    await processMediaPosts(db, client, 'acc-1');
    expect(client.createMediaContainer).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ imageUrl: 'https://example.com/1.jpg', isCarouselItem: true }),
    );
    expect(client.createMediaContainer).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ videoUrl: 'https://example.com/2.mp4', mediaType: 'VIDEO', isCarouselItem: true }),
    );
    expect(client.createMediaContainer).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ mediaType: 'CAROUSEL', children: ['child-1', 'child-2'] }),
    );
    expect(updateMediaPost).toHaveBeenCalledWith(
      db,
      'post-1',
      expect.objectContaining({
        status: 'processing',
        creation_id: 'parent-1',
        child_creation_ids: JSON.stringify(['child-1', 'child-2']),
      }),
    );
  });

  it('reel: sends a custom cover URL and ignores the frame offset', async () => {
    const post = makePost({
      post_type: 'reel',
      media: JSON.stringify([{ url: 'https://example.com/reel.mp4', type: 'video' }]),
      cover_url: 'https://example.com/cover.jpg',
      thumb_offset_ms: 2500,
    });
    vi.mocked(getDueMediaPosts).mockResolvedValueOnce([post] as any);
    const client = makeClient();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
      { status: 206, headers: { 'Content-Type': 'image/jpeg', 'Content-Range': 'bytes 0-3/400000' } },
    )));

    await processMediaPosts(db, client, 'acc-1');

    expect(client.createMediaContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaType: 'REELS',
        videoUrl: 'https://example.com/reel.mp4',
        coverUrl: 'https://example.com/cover.jpg',
        thumbOffsetMs: undefined,
        shareToFeed: true,
      }),
    );
  });

  it('reel: sends the selected video frame offset when no cover URL exists', async () => {
    const post = makePost({
      post_type: 'reel',
      media: JSON.stringify([{ url: 'https://example.com/reel.mp4', type: 'video' }]),
      thumb_offset_ms: 3200,
    });
    vi.mocked(getDueMediaPosts).mockResolvedValueOnce([post] as any);
    const client = makeClient();

    await processMediaPosts(db, client, 'acc-1');

    expect(client.createMediaContainer).toHaveBeenCalledWith(
      expect.objectContaining({ thumbOffsetMs: 3200, coverUrl: undefined, shareToFeed: true }),
    );
  });

  it('reel: does not create a Meta container when the requested cover is unavailable', async () => {
    const post = makePost({
      post_type: 'reel',
      media: JSON.stringify([{ url: 'https://example.com/reel.mp4', type: 'video' }]),
      cover_url: 'https://example.com/missing.jpg',
    });
    vi.mocked(getDueMediaPosts).mockResolvedValueOnce([post] as any);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
    const client = makeClient();

    await processMediaPosts(db, client, 'acc-1');

    expect(client.createMediaContainer).not.toHaveBeenCalled();
    expect(updateMediaPost).toHaveBeenCalledWith(
      db,
      'post-1',
      expect.objectContaining({
        attempt_count: 1,
        error: expect.stringContaining('reel cover preflight failed'),
      }),
    );
  });

  it('reel: reports repeated cover failures as an IG Harness asset problem, not a Meta outage', async () => {
    const post = makePost({
      post_type: 'reel',
      media: JSON.stringify([{ url: 'https://example.com/reel.mp4', type: 'video' }]),
      cover_url: 'https://example.com/missing.jpg',
      attempt_count: 3,
    });
    vi.mocked(getDueMediaPosts).mockResolvedValueOnce([post] as any);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
    const client = makeClient();

    await processMediaPosts(db, client, 'acc-1');

    expect(updateMediaPost).toHaveBeenCalledWith(
      db,
      'post-1',
      expect.objectContaining({
        status: 'failed',
        attempt_count: 4,
        error: expect.stringContaining('サムネ画像を4回確認できなかった'),
      }),
    );
    expect(updateMediaPost).not.toHaveBeenCalledWith(
      db,
      'post-1',
      expect.objectContaining({ error: expect.stringContaining('Meta側の一時エラー') }),
    );
  });

  it('story batch: creates one ordered STORIES container per frame', async () => {
    const post = makePost({
      post_type: 'story',
      media: JSON.stringify([
        { url: 'https://example.com/1.jpg', type: 'image' },
        { url: 'https://example.com/2.mp4', type: 'video' },
        { url: 'https://example.com/3.jpg', type: 'image' },
      ]),
    });
    vi.mocked(getDueMediaPosts).mockResolvedValueOnce([post] as any);
    const client = makeClient();
    client.createMediaContainer
      .mockResolvedValueOnce({ id: 'story-1' })
      .mockResolvedValueOnce({ id: 'story-2' })
      .mockResolvedValueOnce({ id: 'story-3' });

    await processMediaPosts(db, client, 'acc-1');

    expect(client.createMediaContainer).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ imageUrl: 'https://example.com/1.jpg', mediaType: 'STORIES' }),
    );
    expect(client.createMediaContainer).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ videoUrl: 'https://example.com/2.mp4', mediaType: 'STORIES' }),
    );
    expect(updateMediaPost).toHaveBeenCalledWith(
      db,
      'post-1',
      expect.objectContaining({
        status: 'processing',
        creation_id: 'story-1',
        child_creation_ids: JSON.stringify(['story-1', 'story-2', 'story-3']),
      }),
    );
  });

  it('story batch: waits until the entire batch fits the publishing quota', async () => {
    const post = makePost({
      post_type: 'story',
      media: JSON.stringify([
        { url: 'https://example.com/1.jpg', type: 'image' },
        { url: 'https://example.com/2.jpg', type: 'image' },
      ]),
    });
    vi.mocked(getDueMediaPosts).mockResolvedValueOnce([post] as any);
    const client = makeClient({
      getPublishingLimit: vi.fn().mockResolvedValue({ quota_usage: 99, config: { quota_total: 100, quota_duration: 86400 } }),
    });

    await processMediaPosts(db, client, 'acc-1');

    expect(client.createMediaContainer).not.toHaveBeenCalled();
    expect(updateMediaPost).toHaveBeenCalledWith(
      db,
      'post-1',
      expect.objectContaining({ error: expect.stringContaining('required=2') }),
    );
  });

  it('quota exhausted: stays scheduled with an error note, no container created', async () => {
    vi.mocked(getDueMediaPosts).mockResolvedValueOnce([makePost()] as any);
    const client = makeClient({
      getPublishingLimit: vi.fn().mockResolvedValue({ quota_usage: 100, config: { quota_total: 100, quota_duration: 86400 } }),
    });
    await processMediaPosts(db, client, 'acc-1');
    expect(client.createMediaContainer).not.toHaveBeenCalled();
    expect(updateMediaPost).toHaveBeenCalledWith(
      db,
      'post-1',
      expect.not.objectContaining({ status: expect.anything() }),
    );
  });

  it('container creation failure increments attempt_count, keeps scheduled', async () => {
    vi.mocked(getDueMediaPosts).mockResolvedValueOnce([makePost()] as any);
    const client = makeClient({
      createMediaContainer: vi.fn().mockRejectedValue(new Error('Instagram API error 400: bad url')),
    });
    await processMediaPosts(db, client, 'acc-1');
    expect(updateMediaPost).toHaveBeenCalledWith(
      db,
      'post-1',
      expect.objectContaining({ attempt_count: 1 }),
    );
  });

  it('4th failure marks the post failed after three delayed retries', async () => {
    vi.mocked(getDueMediaPosts).mockResolvedValueOnce([makePost({ attempt_count: 3 })] as any);
    const client = makeClient({
      createMediaContainer: vi.fn().mockRejectedValue(new Error('boom')),
    });
    await processMediaPosts(db, client, 'acc-1');
    expect(updateMediaPost).toHaveBeenCalledWith(
      db,
      'post-1',
      expect.objectContaining({ status: 'failed', attempt_count: 4, next_retry_at: null }),
    );
  });

  it('labels Meta code 2 as transient and schedules a retry instead of claiming a missing scope', async () => {
    vi.mocked(getDueMediaPosts).mockResolvedValueOnce([makePost({ attempt_count: 0 })] as any);
    const client = makeClient({
      createMediaContainer: vi.fn().mockRejectedValue(
        new Error('Instagram API error 500: {"error":{"message":"An unexpected error has occurred.","type":"OAuthException","is_transient":true,"code":2}}'),
      ),
    });
    await processMediaPosts(db, client, 'acc-1');
    const retryCall = vi.mocked(updateMediaPost).mock.calls.find(
      (call) => (call[2] as any).attempt_count === 1,
    );
    expect(retryCall?.[2]).toEqual(expect.objectContaining({
      attempt_count: 1,
      last_attempt_at: expect.any(String),
      next_retry_at: expect.any(String),
      error: expect.stringContaining('Meta側の一時エラー'),
    }));
    expect(String((retryCall?.[2] as any).error)).not.toContain('instagram_business_content_publish');
    expect((retryCall?.[2] as any).status).toBeUndefined();
  });

  it('fails immediately with a token-specific message for Meta code 190', async () => {
    vi.mocked(getDueMediaPosts).mockResolvedValueOnce([makePost({ attempt_count: 0 })] as any);
    const client = makeClient({
      createMediaContainer: vi.fn().mockRejectedValue(
        new Error('Instagram API error 401: {"error":{"message":"Error validating access token","type":"OAuthException","code":190}}'),
      ),
    });
    await processMediaPosts(db, client, 'acc-1');
    expect(updateMediaPost).toHaveBeenCalledWith(
      db,
      'post-1',
      expect.objectContaining({
        status: 'failed',
        attempt_count: 1,
        next_retry_at: null,
        error: expect.stringContaining('トークンが無効または期限切れ'),
      }),
    );
  });

  it('permission error message mentions the missing scope', async () => {
    vi.mocked(getDueMediaPosts).mockResolvedValueOnce([makePost({ attempt_count: 2 })] as any);
    const client = makeClient({
      createMediaContainer: vi.fn().mockRejectedValue(
        new Error('Instagram API error 403: {"error":{"message":"(#10) Application does not have permission"}}'),
      ),
    });
    await processMediaPosts(db, client, 'acc-1');
    const failedCall = vi.mocked(updateMediaPost).mock.calls.find(
      (call) => (call[2] as any).status === 'failed',
    );
    expect(String((failedCall![2] as any).error)).toContain('instagram_business_content_publish');
  });
});

describe('processMediaPosts — processing posts', () => {
  it('FINISHED container is published', async () => {
    vi.mocked(getProcessingMediaPosts).mockResolvedValueOnce([
      makePost({ status: 'processing', creation_id: 'container-1' }),
    ] as any);
    const client = makeClient();
    await processMediaPosts(db, client, 'acc-1');
    expect(client.publishMedia).toHaveBeenCalledWith('container-1');
    expect(updateMediaPost).toHaveBeenCalledWith(
      db,
      'post-1',
      expect.objectContaining({ status: 'published', published_media_id: 'media-99' }),
    );
  });

  it('activates a linked campaign with the real Instagram media id after publish', async () => {
    const processing = makePost({
      status: 'processing',
      creation_id: 'container-1',
      campaign_gate_id: 'gate-1',
      campaign_activation_status: 'pending',
      campaign_auto_activate: 1,
    });
    const published = makePost({
      ...processing,
      status: 'published',
      published_media_id: 'media-99',
    });
    vi.mocked(getProcessingMediaPosts).mockResolvedValueOnce([processing] as any);
    vi.mocked(updateMediaPost)
      .mockResolvedValueOnce(published as any)
      .mockResolvedValueOnce({ ...published, campaign_activation_status: 'active' } as any);
    vi.mocked(getEngagementGate).mockResolvedValueOnce({
      id: 'gate-1',
      status: 'paused',
    } as any);

    await processMediaPosts(db, makeClient(), 'acc-1');

    expect(addGateTargetPost).toHaveBeenCalledWith(db, 'gate-1', 'media-99');
    expect(updateEngagementGate).toHaveBeenCalledWith(
      db,
      'gate-1',
      expect.objectContaining({ status: 'active' }),
    );
    expect(updateMediaPost).toHaveBeenCalledWith(
      db,
      'post-1',
      expect.objectContaining({ campaign_activation_status: 'active' }),
    );
  });

  it('activates an existing paused campaign after publish, including legacy auto flags', async () => {
    const processing = makePost({
      status: 'processing',
      creation_id: 'container-1',
      campaign_gate_id: 'gate-1',
      campaign_activation_status: 'pending',
      campaign_auto_activate: 0,
    });
    const published = makePost({ ...processing, status: 'published', published_media_id: 'media-100' });
    vi.mocked(getProcessingMediaPosts).mockResolvedValueOnce([processing] as any);
    vi.mocked(updateMediaPost)
      .mockResolvedValueOnce(published as any)
      .mockResolvedValueOnce({ ...published, campaign_activation_status: 'active' } as any);
    vi.mocked(getEngagementGate).mockResolvedValueOnce({ id: 'gate-1', status: 'paused' } as any);

    await processMediaPosts(db, makeClient(), 'acc-1');

    expect(addGateTargetPost).toHaveBeenCalledWith(db, 'gate-1', 'media-100');
    expect(updateEngagementGate).toHaveBeenCalledWith(
      db,
      'gate-1',
      expect.objectContaining({ status: 'active' }),
    );
  });

  it('keeps an already-published post published when campaign activation fails', async () => {
    const processing = makePost({
      status: 'processing',
      creation_id: 'container-1',
      campaign_gate_id: 'gate-1',
      campaign_activation_status: 'pending',
    });
    const published = makePost({
      ...processing,
      status: 'published',
      published_media_id: 'media-99',
    });
    vi.mocked(getProcessingMediaPosts).mockResolvedValueOnce([processing] as any);
    vi.mocked(updateMediaPost).mockResolvedValueOnce(published as any).mockResolvedValue(null);
    vi.mocked(getEngagementGate).mockResolvedValueOnce({ id: 'gate-1', status: 'paused' } as any);
    vi.mocked(addGateTargetPost).mockRejectedValueOnce(new Error('temporary D1 error'));

    await processMediaPosts(db, makeClient(), 'acc-1');

    const calls = vi.mocked(updateMediaPost).mock.calls.map((call) => call[2] as any);
    expect(calls).toContainEqual(
      expect.objectContaining({ campaign_activation_status: 'failed' }),
    );
    expect(calls.some((patch) => patch.status === 'failed')).toBe(false);
  });

  it('IN_PROGRESS container is left untouched for the next cycle', async () => {
    vi.mocked(getProcessingMediaPosts).mockResolvedValueOnce([
      makePost({ status: 'processing', creation_id: 'container-1' }),
    ] as any);
    const client = makeClient({
      getContainerStatus: vi.fn().mockResolvedValue({ id: 'container-1', status_code: 'IN_PROGRESS' }),
    });
    await processMediaPosts(db, client, 'acc-1');
    expect(client.publishMedia).not.toHaveBeenCalled();
    expect(updateMediaPost).not.toHaveBeenCalled();
  });

  it('ERROR container marks the post failed', async () => {
    vi.mocked(getProcessingMediaPosts).mockResolvedValueOnce([
      makePost({ status: 'processing', creation_id: 'container-1' }),
    ] as any);
    const client = makeClient({
      getContainerStatus: vi.fn().mockResolvedValue({
        id: 'container-1',
        status_code: 'ERROR',
        status: 'Media upload failed',
      }),
    });
    await processMediaPosts(db, client, 'acc-1');
    expect(updateMediaPost).toHaveBeenCalledWith(
      db,
      'post-1',
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('PUBLISHED container is recovered to published without re-publishing', async () => {
    vi.mocked(getProcessingMediaPosts).mockResolvedValueOnce([
      makePost({ status: 'processing', creation_id: 'container-1' }),
    ] as any);
    const client = makeClient({
      getContainerStatus: vi.fn().mockResolvedValue({ id: 'container-1', status_code: 'PUBLISHED' }),
    });
    await processMediaPosts(db, client, 'acc-1');
    expect(client.publishMedia).not.toHaveBeenCalled();
    expect(updateMediaPost).toHaveBeenCalledWith(
      db,
      'post-1',
      expect.objectContaining({ status: 'published' }),
    );
  });

  it('story batch: publishes every FINISHED frame in selected order', async () => {
    vi.mocked(getProcessingMediaPosts).mockResolvedValueOnce([
      makePost({
        post_type: 'story',
        status: 'processing',
        creation_id: 'story-1',
        child_creation_ids: JSON.stringify(['story-1', 'story-2', 'story-3']),
      }),
    ] as any);
    const client = makeClient({
      getContainerStatus: vi.fn().mockResolvedValue({ status_code: 'FINISHED' }),
      publishMedia: vi.fn()
        .mockResolvedValueOnce({ id: 'media-1' })
        .mockResolvedValueOnce({ id: 'media-2' })
        .mockResolvedValueOnce({ id: 'media-3' }),
    });

    await processMediaPosts(db, client, 'acc-1');

    expect(client.publishMedia.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      'story-1',
      'story-2',
      'story-3',
    ]);
    expect(updateMediaPost).toHaveBeenCalledWith(
      db,
      'post-1',
      expect.objectContaining({ status: 'published', published_media_id: 'media-3' }),
    );
  });

  it('story batch: never publishes a later frame while an earlier one is processing', async () => {
    vi.mocked(getProcessingMediaPosts).mockResolvedValueOnce([
      makePost({
        post_type: 'story',
        status: 'processing',
        creation_id: 'story-1',
        child_creation_ids: JSON.stringify(['story-1', 'story-2']),
      }),
    ] as any);
    const client = makeClient({
      getContainerStatus: vi.fn().mockResolvedValueOnce({ status_code: 'IN_PROGRESS' }),
    });

    await processMediaPosts(db, client, 'acc-1');

    expect(client.getContainerStatus).toHaveBeenCalledTimes(1);
    expect(client.getContainerStatus).toHaveBeenCalledWith('story-1');
    expect(client.publishMedia).not.toHaveBeenCalled();
  });
});

describe('kickImmediate', () => {
  it('runs a full start+advance cycle so images publish without waiting for cron', async () => {
    const scheduled = makePost();
    const processing = makePost({ status: 'processing', creation_id: 'container-1' });
    vi.mocked(getMediaPostById)
      .mockResolvedValueOnce(scheduled as any)
      .mockResolvedValueOnce(processing as any);
    const client = makeClient();
    await kickImmediate(db, client, 'post-1');
    expect(client.createMediaContainer).toHaveBeenCalled();
    expect(client.publishMedia).toHaveBeenCalledWith('container-1');
  });

  it('does nothing when the post is not scheduled', async () => {
    vi.mocked(getMediaPostById).mockResolvedValueOnce(
      makePost({ status: 'published' }) as any,
    );
    const client = makeClient();
    await kickImmediate(db, client, 'post-1');
    expect(client.createMediaContainer).not.toHaveBeenCalled();
  });
});

describe('assertReelCoverFetchable', () => {
  it('accepts a ranged public JPEG response', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      new Uint8Array([0xff, 0xd8, 0xff, 0xdb]),
      { status: 206, headers: { 'Content-Type': 'image/jpeg', 'Content-Range': 'bytes 0-3/340538' } },
    ));

    await expect(assertReelCoverFetchable('https://example.com/cover.jpg', fetcher)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledWith(
      'https://example.com/cover.jpg',
      expect.objectContaining({ headers: { Range: 'bytes=0-4095' } }),
    );
  });

  it('rejects content that is labelled JPEG but has a different signature', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      { status: 200, headers: { 'Content-Type': 'image/jpeg' } },
    ));

    await expect(assertReelCoverFetchable('https://example.com/cover.jpg', fetcher))
      .rejects.toThrow('not a valid JPEG');
  });
});
