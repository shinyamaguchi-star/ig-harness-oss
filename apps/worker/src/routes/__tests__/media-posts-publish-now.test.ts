/**
 * Tests: POST /api/media-posts/:id/publish-now uses the post's OWNING
 * account, not the request-scoped ?account_id/default account (final review
 * Fix 1 — mirrors broadcasts.ts's /:id/send owning-account convention).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared before dynamic imports
// ---------------------------------------------------------------------------

const dbMocks = vi.hoisted(() => ({
  getMediaPostById: vi.fn(),
  updateMediaPost: vi.fn(),
  updateScheduledMediaPost: vi.fn(),
  retryFailedCoverMediaPost: vi.fn(),
  cancelMediaPost: vi.fn(),
  createMediaPost: vi.fn(),
  listMediaPosts: vi.fn(),
  getIgAccountById: vi.fn(),
  getEngagementGate: vi.fn(),
  jstNow: vi.fn().mockReturnValue('2026-01-01T00:00:00+09:00'),
  toJstString: vi.fn((d: Date) => d.toISOString()),
}));

vi.mock('@ig-harness/db', () => dbMocks);

const accountsMocks = vi.hoisted(() => ({
  resolveAccount: vi.fn(),
  getAccountClient: vi.fn(),
}));

vi.mock('../../lib/accounts.js', () => accountsMocks);

const mediaPublishMocks = vi.hoisted(() => ({
  kickImmediate: vi.fn().mockResolvedValue(undefined),
  assertReelCoverFetchable: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/media-publish.js', () => mediaPublishMocks);

import { mediaPosts } from '../media-posts.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACCOUNT_A = {
  id: 'account-A',
  ig_user_id: 'ig-A',
  username: 'acct_a',
  access_token: 'tok-a',
  is_active: 1,
  is_default: 1,
};
const ACCOUNT_B = {
  id: 'account-B',
  ig_user_id: 'ig-B',
  username: 'acct_b',
  access_token: 'tok-b',
  is_active: 1,
  is_default: 0,
};

const POST_OWNED_BY_B = {
  id: 'post-1',
  account_id: 'account-B',
  title: null,
  post_type: 'feed_image',
  media: JSON.stringify([{ url: 'https://example.com/post.jpg', type: 'image' }]),
  caption: null,
  cover_url: null,
  thumb_offset_ms: null,
  status: 'scheduled',
  scheduled_at: '2026-01-01T00:00:00+09:00',
  creation_id: null,
  child_creation_ids: null,
  published_media_id: null,
  attempt_count: 0,
  error: null,
  campaign_gate_id: null,
  campaign_activation_status: null,
  campaign_error: null,
  campaign_auto_activate: 0,
  created_at: '2026-01-01T00:00:00+09:00',
  updated_at: '2026-01-01T00:00:00+09:00',
};

function makeEnv() {
  return {
    DB: {} as D1Database,
    IG_APP_SECRET: 'secret',
    IG_ACCESS_TOKEN: 'tok',
    IG_USER_ID: 'ig-A',
    IG_VERIFY_TOKEN: 'vt',
    API_KEY: 'key',
    WORKER_URL: 'https://test.workers.dev',
  };
}

const executionCtx = {
  waitUntil: (p: Promise<unknown>) => {
    p.catch(() => {});
  },
  passThroughOnException: () => {},
} as ExecutionContext;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/media-posts/:id/publish-now owning-account (Fix 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.updateMediaPost.mockResolvedValue({ ...POST_OWNED_BY_B, status: 'processing' });
  });

  it('builds the IG client from the post\'s owning account, not resolveAccount', async () => {
    // A request made with the "wrong" default/query account (A) must still
    // resolve to the post's real owner (B).
    accountsMocks.resolveAccount.mockResolvedValue(ACCOUNT_A);
    dbMocks.getMediaPostById.mockResolvedValue(POST_OWNED_BY_B);
    dbMocks.getIgAccountById.mockResolvedValue(ACCOUNT_B);
    accountsMocks.getAccountClient.mockResolvedValue({ fake: 'client' });

    const res = await mediaPosts.fetch(
      new Request('https://worker.example.com/api/media-posts/post-1/publish-now?account_id=account-A', {
        method: 'POST',
      }),
      makeEnv(),
      executionCtx,
    );

    expect(res.status).toBe(200);
    expect(dbMocks.getIgAccountById).toHaveBeenCalledWith(expect.anything(), 'account-B');
    expect(accountsMocks.getAccountClient).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      ACCOUNT_B,
    );
    // resolveAccount must not gate this handler at all anymore.
    expect(accountsMocks.resolveAccount).not.toHaveBeenCalled();
  });

  it('404s when the owning account no longer exists', async () => {
    dbMocks.getMediaPostById.mockResolvedValue(POST_OWNED_BY_B);
    dbMocks.getIgAccountById.mockResolvedValue(null);

    const res = await mediaPosts.fetch(
      new Request('https://worker.example.com/api/media-posts/post-1/publish-now', {
        method: 'POST',
      }),
      makeEnv(),
      executionCtx,
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe('account not found');
    expect(accountsMocks.getAccountClient).not.toHaveBeenCalled();
  });

  it('409s when the post is not in scheduled status (checked before account lookup)', async () => {
    dbMocks.getMediaPostById.mockResolvedValue({ ...POST_OWNED_BY_B, status: 'published' });

    const res = await mediaPosts.fetch(
      new Request('https://worker.example.com/api/media-posts/post-1/publish-now', {
        method: 'POST',
      }),
      makeEnv(),
      executionCtx,
    );

    expect(res.status).toBe(409);
    expect(dbMocks.getIgAccountById).not.toHaveBeenCalled();
  });
});

describe('Reel cover availability and safe retry', () => {
  const FAILED_COVER_POST = {
    ...POST_OWNED_BY_B,
    post_type: 'reel',
    media: JSON.stringify([{ url: 'https://example.com/reel.mp4', type: 'video' }]),
    cover_url: 'https://worker.example.com/images/missing.jpg',
    status: 'failed',
    attempt_count: 4,
    error: 'サムネ画像を確認できません (reel cover preflight failed: public URL returned HTTP 404)',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mediaPublishMocks.assertReelCoverFetchable.mockResolvedValue(undefined);
    dbMocks.getMediaPostById.mockResolvedValue(FAILED_COVER_POST);
    dbMocks.getIgAccountById.mockResolvedValue(ACCOUNT_B);
    dbMocks.retryFailedCoverMediaPost.mockImplementation(
      async (_db: unknown, _id: string, patch: Record<string, unknown>) => ({
        ...FAILED_COVER_POST,
        status: 'scheduled',
        attempt_count: 0,
        error: null,
      }),
    );
    accountsMocks.getAccountClient.mockResolvedValue({ fake: 'client' });
  });

  it('rejects a new reservation before saving when the cover URL returns 404', async () => {
    accountsMocks.resolveAccount.mockResolvedValue(ACCOUNT_B);
    mediaPublishMocks.assertReelCoverFetchable.mockRejectedValueOnce(
      new Error('reel cover preflight failed: public URL returned HTTP 404'),
    );

    const res = await mediaPosts.fetch(
      new Request('https://worker.example.com/api/media-posts?account_id=account-B', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          post_type: 'reel',
          media: [{ url: 'https://example.com/reel.mp4', type: 'video' }],
          cover_url: 'https://worker.example.com/images/missing.jpg',
          scheduled_at: '2026-01-02T18:00:00+09:00',
        }),
      }),
      makeEnv(),
      executionCtx,
    );

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      success: false,
      error: expect.stringContaining('HTTP 404'),
    });
    expect(dbMocks.createMediaPost).not.toHaveBeenCalled();
  });

  it('rechecks the URL and safely resets a preflight failure before retrying', async () => {
    const res = await mediaPosts.fetch(
      new Request('https://worker.example.com/api/media-posts/post-1/retry-cover', {
        method: 'POST',
      }),
      makeEnv(),
      executionCtx,
    );

    expect(res.status).toBe(200);
    expect(mediaPublishMocks.assertReelCoverFetchable).toHaveBeenCalledWith(
      FAILED_COVER_POST.cover_url,
    );
    expect(dbMocks.retryFailedCoverMediaPost).toHaveBeenCalledWith(
      expect.anything(),
      'post-1',
      'account-B',
      '2026-01-01T00:00:00+09:00',
    );
    expect(mediaPublishMocks.kickImmediate).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'post-1',
    );
  });

  it('does not reset a failed post when its cover is still unavailable', async () => {
    mediaPublishMocks.assertReelCoverFetchable.mockRejectedValueOnce(
      new Error('reel cover preflight failed: public URL returned HTTP 404'),
    );
    const res = await mediaPosts.fetch(
      new Request('https://worker.example.com/api/media-posts/post-1/retry-cover', {
        method: 'POST',
      }),
      makeEnv(),
      executionCtx,
    );

    expect(res.status).toBe(422);
    expect(dbMocks.retryFailedCoverMediaPost).not.toHaveBeenCalled();
    expect(mediaPublishMocks.kickImmediate).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/media-posts/:id reservation editing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accountsMocks.resolveAccount.mockResolvedValue(ACCOUNT_B);
    dbMocks.getMediaPostById.mockResolvedValue(POST_OWNED_BY_B);
  });

  it('updates content and attaches an eligible existing campaign', async () => {
    dbMocks.getEngagementGate.mockResolvedValue({
      id: 'gate-2',
      account_id: 'account-B',
      status: 'active',
      trigger_type: 'comment_on_post',
      target_post_ids: ['existing-media'],
    });
    dbMocks.updateScheduledMediaPost.mockImplementation(
      async (_db: unknown, _id: string, _accountId: string, patch: Record<string, unknown>) => ({
        ...POST_OWNED_BY_B,
        ...patch,
      }),
    );

    const res = await mediaPosts.fetch(
      new Request('https://worker.example.com/api/media-posts/post-1?account_id=account-B', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caption: 'updated', campaign_gate_id: 'gate-2' }),
      }),
      makeEnv(),
      executionCtx,
    );

    expect(res.status).toBe(200);
    expect(dbMocks.updateScheduledMediaPost).toHaveBeenCalledWith(
      expect.anything(),
      'post-1',
      'account-B',
      expect.objectContaining({
        caption: 'updated',
        campaign_gate_id: 'gate-2',
        campaign_activation_status: 'pending',
        campaign_auto_activate: 1,
      }),
    );
  });

  it('rejects edits after publishing has started', async () => {
    dbMocks.getMediaPostById.mockResolvedValue({ ...POST_OWNED_BY_B, status: 'processing' });
    const res = await mediaPosts.fetch(
      new Request('https://worker.example.com/api/media-posts/post-1?account_id=account-B', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caption: 'too late' }),
      }),
      makeEnv(),
      executionCtx,
    );
    expect(res.status).toBe(409);
    expect(dbMocks.updateScheduledMediaPost).not.toHaveBeenCalled();
  });

  it('rejects a campaign owned by another Instagram account', async () => {
    dbMocks.getEngagementGate.mockResolvedValue({
      id: 'foreign-gate',
      account_id: 'account-A',
      status: 'active',
      trigger_type: 'comment_on_post',
      target_post_ids: ['media-1'],
    });
    const res = await mediaPosts.fetch(
      new Request('https://worker.example.com/api/media-posts/post-1?account_id=account-B', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaign_gate_id: 'foreign-gate' }),
      }),
      makeEnv(),
      executionCtx,
    );
    expect(res.status).toBe(400);
    expect(dbMocks.updateScheduledMediaPost).not.toHaveBeenCalled();
  });
});

describe('POST /api/media-posts scheduled campaign activation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accountsMocks.resolveAccount.mockResolvedValue(ACCOUNT_B);
    dbMocks.getEngagementGate.mockResolvedValue({
      id: 'gate-existing',
      account_id: 'account-B',
      status: 'paused',
      trigger_type: 'comment_on_post',
      target_post_ids: [],
    });
    dbMocks.createMediaPost.mockImplementation(async (_db: unknown, input: any) => ({
      ...POST_OWNED_BY_B,
      campaign_gate_id: input.campaignGateId,
      campaign_auto_activate: input.campaignAutoActivate ? 1 : 0,
    }));
  });

  it('marks an existing campaign to activate after the scheduled post publishes', async () => {
    const res = await mediaPosts.fetch(
      new Request('https://worker.example.com/api/media-posts?account_id=account-B', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: '年末キャンペーン用リール',
          post_type: 'reel',
          media: [{ url: 'https://example.com/reel.mp4', type: 'video' }],
          scheduled_at: '2026-01-02T18:00:00+09:00',
          campaign_gate_id: 'gate-existing',
        }),
      }),
      makeEnv(),
      executionCtx,
    );

    expect(res.status).toBe(201);
    expect(dbMocks.createMediaPost).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        title: '年末キャンペーン用リール',
        campaignGateId: 'gate-existing',
        campaignAutoActivate: true,
      }),
    );
  });
});
