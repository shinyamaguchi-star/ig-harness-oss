/**
 * Tests: media-publish state machine
 * scheduled → processing → published / failed, quota carry-over, retry cap.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@ig-harness/db', async (importOriginal) => {
  const original = await importOriginal<typeof import('@ig-harness/db')>();
  return {
    ...original,
    getDueMediaPosts: vi.fn().mockResolvedValue([]),
    getProcessingMediaPosts: vi.fn().mockResolvedValue([]),
    getPendingCampaignMediaPosts: vi.fn().mockResolvedValue([]),
    getMediaPostById: vi.fn().mockResolvedValue(null),
    getEngagementGate: vi.fn().mockResolvedValue(null),
    setGateTargetPosts: vi.fn().mockResolvedValue(undefined),
    updateEngagementGate: vi.fn().mockResolvedValue(undefined),
    updateMediaPost: vi.fn().mockResolvedValue(null),
  };
});

import {
  getDueMediaPosts,
  getProcessingMediaPosts,
  getPendingCampaignMediaPosts,
  getMediaPostById,
  getEngagementGate,
  setGateTargetPosts,
  updateEngagementGate,
  updateMediaPost,
} from '@ig-harness/db';
import { processMediaPosts, kickImmediate } from '../media-publish.js';

const db = {} as D1Database;

function makePost(overrides: Record<string, unknown> = {}) {
  return {
    id: 'post-1',
    account_id: 'acc-1',
    post_type: 'feed_image',
    media: JSON.stringify([{ url: 'https://example.com/a.jpg', type: 'image' }]),
    caption: 'hi',
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
  vi.mocked(setGateTargetPosts).mockResolvedValue(undefined);
  vi.mocked(updateEngagementGate).mockResolvedValue(undefined);
  vi.mocked(updateMediaPost).mockResolvedValue(null);
});

describe('processMediaPosts — scheduled posts', () => {
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

  it('3rd failure marks the post failed', async () => {
    vi.mocked(getDueMediaPosts).mockResolvedValueOnce([makePost({ attempt_count: 2 })] as any);
    const client = makeClient({
      createMediaContainer: vi.fn().mockRejectedValue(new Error('boom')),
    });
    await processMediaPosts(db, client, 'acc-1');
    expect(updateMediaPost).toHaveBeenCalledWith(
      db,
      'post-1',
      expect.objectContaining({ status: 'failed', attempt_count: 3 }),
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

    expect(setGateTargetPosts).toHaveBeenCalledWith(db, 'gate-1', ['media-99']);
    expect(updateEngagementGate).toHaveBeenCalledWith(
      db,
      'gate-1',
      expect.objectContaining({ target_post_id: 'media-99', status: 'active' }),
    );
    expect(updateMediaPost).toHaveBeenCalledWith(
      db,
      'post-1',
      expect.objectContaining({ campaign_activation_status: 'active' }),
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
    vi.mocked(setGateTargetPosts).mockRejectedValueOnce(new Error('temporary D1 error'));

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
