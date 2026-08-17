import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@ig-harness/db', async (importOriginal) => {
  const original = await importOriginal<typeof import('@ig-harness/db')>();
  return {
    ...original,
    createEngagementGate: vi.fn(),
    createRichMessage: vi.fn(),
    deleteEngagementGate: vi.fn().mockResolvedValue(undefined),
    deleteRichMessage: vi.fn().mockResolvedValue(undefined),
    getRichMessage: vi.fn(),
    setGateTargetPosts: vi.fn().mockResolvedValue(undefined),
  };
});

import {
  createEngagementGate,
  createRichMessage,
  deleteEngagementGate,
  deleteRichMessage,
  getRichMessage,
  setGateTargetPosts,
  type EngagementGate,
} from '@ig-harness/db';
import { copyEngagementGate } from '../campaign-copy.js';

const db = {} as D1Database;

function sourceGate(overrides: Partial<EngagementGate> = {}): EngagementGate {
  return {
    id: 'source-gate',
    name: 'プレゼント企画',
    status: 'active',
    trigger_type: 'comment_on_post',
    target_post_id: 'post-1',
    target_post_ids: ['post-1', 'post-2'],
    trigger_keyword: '欲しい',
    trigger_keywords: JSON.stringify(['欲しい', '希望']),
    require_follow: 1,
    initial_dm_text: '最初のDM',
    initial_dm_button_label: '受け取る',
    follow_reminder_dm_text: 'フォローしてください',
    follow_reminder_button_label: 'フォローした',
    reward_dm_text: '特典です',
    reward_url: 'https://example.com/reward',
    max_loops: 3,
    initial_dm_rich_message_id: 'rm-cta',
    reward_dm_rich_message_id: 'rm-reward',
    follow_reminder_dm_rich_message_id: 'rm-reminder',
    comment_reply_text: '["DMを確認してね"]',
    followup_dm_sequence: '[{"delay_minutes":30,"text":"確認しましたか？"}]',
    allow_repeat: 0,
    line_connection_id: 'line-1',
    line_pool_slug: 'pool-a',
    line_tracked_link_short: 'old-short',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRichMessage).mockImplementation(async (_db, id) => ({
    id,
    name: id,
    kind: id.includes('reward') ? 'reward' : id.includes('reminder') ? 'reminder' : 'cta',
    blocks: [{ type: 'text', text: `blocks:${id}` }],
    created_at: '',
    updated_at: '',
  }));
  vi.mocked(createRichMessage).mockImplementation(async (_db, data) => ({
    id: `copied-${data.kind}`,
    name: data.name,
    kind: data.kind,
    blocks: data.blocks,
    created_at: '',
    updated_at: '',
  }));
  vi.mocked(createEngagementGate).mockImplementation(async (_db, input) => ({
    id: 'copied-gate',
    created_at: '',
    updated_at: '',
    ...input,
  }) as EngagementGate);
});

describe('copyEngagementGate', () => {
  it('creates a paused independent copy without delivery history or link cache', async () => {
    const copied = await copyEngagementGate(db, sourceGate(), 'account-1');

    expect(createRichMessage).toHaveBeenCalledTimes(3);
    expect(createRichMessage).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ accountId: 'account-1', kind: 'cta' }),
    );
    expect(createEngagementGate).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        name: 'プレゼント企画（コピー）',
        status: 'paused',
        trigger_keywords: JSON.stringify(['欲しい', '希望']),
        initial_dm_rich_message_id: 'copied-cta',
        reward_dm_rich_message_id: 'copied-reward',
        follow_reminder_dm_rich_message_id: 'copied-reminder',
        line_tracked_link_short: null,
        accountId: 'account-1',
      }),
    );
    expect(setGateTargetPosts).toHaveBeenCalledWith(
      db,
      'copied-gate',
      ['post-1', 'post-2'],
    );
    expect(copied.status).toBe('paused');
    expect(copied.target_post_ids).toEqual(['post-1', 'post-2']);
  });

  it('clones one shared template only once and reuses the cloned id', async () => {
    const copied = await copyEngagementGate(
      db,
      sourceGate({
        initial_dm_rich_message_id: 'rm-shared',
        reward_dm_rich_message_id: 'rm-shared',
        follow_reminder_dm_rich_message_id: 'rm-shared',
      }),
      'account-1',
    );

    expect(getRichMessage).toHaveBeenCalledTimes(1);
    expect(createRichMessage).toHaveBeenCalledTimes(1);
    expect(copied.initial_dm_rich_message_id).toBe('copied-cta');
    expect(copied.reward_dm_rich_message_id).toBe('copied-cta');
    expect(copied.follow_reminder_dm_rich_message_id).toBe('copied-cta');
  });

  it('fails instead of creating a broken copy when a referenced template is missing', async () => {
    vi.mocked(getRichMessage).mockImplementation(async (_db, id) =>
      id === 'rm-reward'
        ? null
        : {
            id,
            name: id,
            kind: 'cta',
            blocks: [{ type: 'text', text: 'ok' }],
            created_at: '',
            updated_at: '',
          },
    );

    await expect(copyEngagementGate(db, sourceGate(), 'account-1')).rejects.toThrow(
      /DMテンプレートが見つかりません/,
    );
    expect(createRichMessage).not.toHaveBeenCalled();
    expect(createEngagementGate).not.toHaveBeenCalled();
  });

  it('removes newly cloned templates if gate creation fails', async () => {
    vi.mocked(createEngagementGate).mockRejectedValueOnce(new Error('D1 write failed'));

    await expect(copyEngagementGate(db, sourceGate(), 'account-1')).rejects.toThrow(
      /D1 write failed/,
    );

    expect(deleteEngagementGate).not.toHaveBeenCalled();
    expect(deleteRichMessage).toHaveBeenCalledTimes(3);
    expect(deleteRichMessage).toHaveBeenCalledWith(db, 'copied-cta');
    expect(deleteRichMessage).toHaveBeenCalledWith(db, 'copied-reward');
    expect(deleteRichMessage).toHaveBeenCalledWith(db, 'copied-reminder');
  });
});
