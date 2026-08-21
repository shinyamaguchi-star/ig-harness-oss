import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@ig-harness/db', async (importOriginal) => {
  const original = await importOriginal<typeof import('@ig-harness/db')>();
  return {
    ...original,
    getEngagementGate: vi.fn(),
    listMediaPosts: vi.fn(),
    replaceScheduledCampaignMediaPosts: vi.fn(),
  };
});

vi.mock('../../lib/accounts.js', () => ({
  resolveAccount: vi.fn(),
}));

import {
  getEngagementGate,
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
