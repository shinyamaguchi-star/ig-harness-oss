import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@ig-harness/db', async (importOriginal) => {
  const original = await importOriginal<typeof import('@ig-harness/db')>();
  return {
    ...original,
    createEngagementGate: vi.fn(),
    setGateTargetPosts: vi.fn(),
    getMediaPostById: vi.fn(),
    attachCampaignToMediaPost: vi.fn(),
    deleteEngagementGate: vi.fn(),
    getEngagementGate: vi.fn(),
    getRichMessage: vi.fn(),
    listMediaPosts: vi.fn(),
    replaceScheduledCampaignMediaPosts: vi.fn(),
  };
});

vi.mock('../../lib/accounts.js', () => ({
  resolveAccount: vi.fn(),
}));

import {
  createEngagementGate,
  setGateTargetPosts,
  getMediaPostById,
  attachCampaignToMediaPost,
  getEngagementGate,
  getRichMessage,
  listMediaPosts,
  replaceScheduledCampaignMediaPosts,
} from '@ig-harness/db';
import { resolveAccount } from '../../lib/accounts.js';
import { engagementGates } from '../engagement-gates.js';

const account = { id: 'account-1', ig_user_id: 'ig-1' };
const db = {} as D1Database;
const env = { DB: db } as any;
const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function post(id: string, campaignGateId: string | null = null) {
  return {
    id,
    account_id: account.id,
    post_type: 'reel',
    status: 'scheduled',
    campaign_gate_id: campaignGateId,
  } as any;
}

describe('PUT /api/engagement-gates/:id/scheduled-posts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveAccount).mockResolvedValue(account as any);
    vi.mocked(getEngagementGate).mockResolvedValue({
      id: 'gate-1',
      account_id: account.id,
      trigger_type: 'comment_on_post',
      status: 'active',
      target_post_ids: ['published-media-1'],
    } as any);
    vi.mocked(listMediaPosts).mockResolvedValue([post('post-1'), post('post-2')] as any);
    vi.mocked(replaceScheduledCampaignMediaPosts).mockResolvedValue(true);
  });

  it('links multiple scheduled posts to one campaign', async () => {
    const response = await engagementGates.fetch(
      new Request('https://worker.example/api/engagement-gates/gate-1/scheduled-posts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ post_ids: ['post-1', 'post-2'] }),
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(replaceScheduledCampaignMediaPosts).toHaveBeenCalledWith(db, {
      accountId: account.id,
      gateId: 'gate-1',
      postIds: ['post-1', 'post-2'],
    });
  });

  it('does not steal a reservation from another campaign', async () => {
    vi.mocked(listMediaPosts).mockResolvedValue([post('post-1', 'gate-other')] as any);
    const response = await engagementGates.fetch(
      new Request('https://worker.example/api/engagement-gates/gate-1/scheduled-posts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ post_ids: ['post-1'] }),
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(409);
    expect(replaceScheduledCampaignMediaPosts).not.toHaveBeenCalled();
  });

  it('protects an active all-post default campaign from accidental narrowing', async () => {
    vi.mocked(getEngagementGate).mockResolvedValue({
      id: 'gate-1',
      account_id: account.id,
      trigger_type: 'comment_on_post',
      status: 'active',
      target_post_ids: [],
    } as any);
    const response = await engagementGates.fetch(
      new Request('https://worker.example/api/engagement-gates/gate-1/scheduled-posts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ post_ids: ['post-1'] }),
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(409);
    expect(replaceScheduledCampaignMediaPosts).not.toHaveBeenCalled();
  });
});

describe('POST /api/engagement-gates with a new scheduled campaign', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveAccount).mockResolvedValue(account as any);
    vi.mocked(getMediaPostById).mockResolvedValue(post('post-1') as any);
    vi.mocked(getRichMessage).mockResolvedValue({
      id: 'rich-direct',
      blocks: [
        { type: 'text', text: '最初の本文' },
        {
          type: 'card',
          title: 'ご案内',
          buttons: [{ type: 'url', label: '記事を受け取る', url: '{REWARD_URL}' }],
        },
      ],
    } as any);
    vi.mocked(createEngagementGate).mockResolvedValue({
      id: 'gate-new',
      account_id: account.id,
      name: 'new scheduled campaign',
      status: 'paused',
      trigger_type: 'comment_on_post',
      target_post_id: null,
      trigger_keyword: '案内',
      trigger_keywords: '["案内"]',
    } as any);
    vi.mocked(attachCampaignToMediaPost).mockResolvedValue(true);
  });

  it('keeps the new campaign paused before publish and enables post-publish activation', async () => {
    const response = await engagementGates.fetch(
      new Request('https://worker.example/api/engagement-gates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'new scheduled campaign',
          trigger_type: 'comment_on_post',
          trigger_keywords: ['案内'],
          require_follow: 0,
          initial_dm_rich_message_id: 'rich-direct',
          scheduled_media_post_id: 'post-1',
        }),
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(createEngagementGate).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ status: 'paused' }),
    );
    expect(setGateTargetPosts).toHaveBeenCalledWith(db, 'gate-new', []);
    expect(attachCampaignToMediaPost).toHaveBeenCalledWith(
      db,
      'post-1',
      'gate-new',
      'pending',
      true,
    );
  });

  it('rejects the retired two-step CTA flow without creating a campaign', async () => {
    vi.mocked(getRichMessage).mockResolvedValueOnce({
      id: 'rich-cta',
      blocks: [
        {
          type: 'card',
          title: '特典を受け取る',
          buttons: [
            {
              type: 'postback',
              label: '受け取る',
              payload: 'CHECK_FOLLOW:{GATE_ID}:{DELIVERY_ID}',
            },
          ],
        },
      ],
    } as any);

    const response = await engagementGates.fetch(
      new Request('https://worker.example/api/engagement-gates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'retired two-step campaign',
          trigger_type: 'comment_on_post',
          require_follow: 0,
          initial_dm_rich_message_id: 'rich-cta',
          reward_dm_text: '特典DM',
          scheduled_media_post_id: 'post-1',
        }),
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: expect.stringContaining('two-step delivery is disabled'),
    });
    expect(createEngagementGate).not.toHaveBeenCalled();
    expect(attachCampaignToMediaPost).not.toHaveBeenCalled();
  });
});
