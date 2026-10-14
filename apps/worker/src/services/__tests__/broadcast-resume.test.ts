import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getBroadcastById: vi.fn(),
  getBroadcasts: vi.fn(),
  updateBroadcastStatus: vi.fn(),
  initializeBroadcastQueue: vi.fn(),
  failStaleBroadcastClaims: vi.fn(),
  getPendingBroadcastQueue: vi.fn(),
  claimBroadcastQueueItem: vi.fn(),
  completeBroadcastQueueItem: vi.fn(),
  getBroadcastQueueCounts: vi.fn(),
  getBroadcastAttemptsToday: vi.fn(),
  setBroadcastBackoff: vi.fn(),
  recordDmFailure: vi.fn(),
}));

vi.mock('@ig-harness/db', () => mocks);
vi.mock('../../lib/health.js', () => ({ recordDmFailure: mocks.recordDmFailure }));

import { processBroadcastSend, processBroadcastWorkItem } from '../broadcast.js';

const broadcast = {
  id: 7,
  name: 'test',
  message_type: 'text',
  body: JSON.stringify({ text: 'hello' }),
  tag_filter: null,
  status: 'sending',
  scheduled_at: null,
  sent_at: null,
  total_sent: 0,
  total_target: 120,
  success_count: 0,
  failure_count: 0,
  daily_limit: null,
  auto_append_recipients: 0,
  audience_cursor_follower_id: 0,
  backoff_until: null,
  sent_today: 0,
  last_error: null,
  account_id: 'account-1',
  created_at: '',
  updated_at: '',
};

function queueItem(id: number) {
  return {
    id,
    broadcast_id: 7,
    follower_id: id,
    recipient_igsid: `ig-${id}`,
    status: 'pending',
    error_code: null,
    error_message: null,
    claimed_at: null,
    completed_at: null,
  };
}

describe('resumable broadcasts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getBroadcastById.mockResolvedValue(broadcast);
    mocks.initializeBroadcastQueue.mockResolvedValue(120);
    mocks.failStaleBroadcastClaims.mockResolvedValue(undefined);
    mocks.claimBroadcastQueueItem.mockResolvedValue(true);
    mocks.completeBroadcastQueueItem.mockResolvedValue(undefined);
    mocks.updateBroadcastStatus.mockResolvedValue(undefined);
    mocks.getBroadcastAttemptsToday.mockResolvedValue(0);
    mocks.recordDmFailure.mockResolvedValue(undefined);
  });

  it('requests at most 10 pending recipients and leaves the job sending', async () => {
    mocks.getPendingBroadcastQueue.mockResolvedValue([queueItem(1), queueItem(2)]);
    mocks.getBroadcastQueueCounts.mockResolvedValue({
      total: 120, pending: 118, processing: 0, success: 2, failed: 0,
    });
    const sendText = vi.fn().mockResolvedValue({});
    const db = {
      prepare: () => ({ bind: () => ({ run: vi.fn().mockResolvedValue(undefined) }) }),
    } as unknown as D1Database;

    await processBroadcastSend(db, { sendText } as never, 7, undefined, 'account-1');

    expect(mocks.getPendingBroadcastQueue).toHaveBeenCalledWith(db, 7, 10);
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(mocks.completeBroadcastQueueItem).toHaveBeenCalledTimes(2);
    expect(mocks.updateBroadcastStatus).toHaveBeenLastCalledWith(
      db,
      7,
      'sending',
      expect.objectContaining({ successCount: 2, totalTarget: 120 }),
    );
  });

  it('marks the broadcast sent only after no pending or processing rows remain', async () => {
    mocks.getPendingBroadcastQueue.mockResolvedValue([]);
    mocks.getBroadcastQueueCounts.mockResolvedValue({
      total: 50, pending: 0, processing: 0, success: 48, failed: 2,
    });

    await processBroadcastSend({} as D1Database, {} as never, 7);

    expect(mocks.updateBroadcastStatus).toHaveBeenLastCalledWith(
      {} as D1Database,
      7,
      'sent',
      expect.objectContaining({ successCount: 48, failureCount: 2 }),
    );
  });

  it('uses only the remaining daily allowance and resumes from pending recipients later', async () => {
    mocks.getBroadcastById.mockResolvedValue({ ...broadcast, daily_limit: 100 });
    mocks.getBroadcastAttemptsToday.mockResolvedValue(98);
    mocks.getPendingBroadcastQueue.mockResolvedValue([queueItem(99), queueItem(100)]);
    mocks.getBroadcastQueueCounts.mockResolvedValue({
      total: 120, pending: 20, processing: 0, success: 100, failed: 0,
    });
    const sendText = vi.fn().mockResolvedValue({});
    const db = {
      prepare: () => ({ bind: () => ({ run: vi.fn().mockResolvedValue(undefined) }) }),
    } as unknown as D1Database;

    await processBroadcastSend(db, { sendText } as never, 7, undefined, 'account-1');

    expect(mocks.getPendingBroadcastQueue).toHaveBeenCalledWith(db, 7, 2);
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(mocks.updateBroadcastStatus).toHaveBeenLastCalledWith(
      db,
      7,
      'sending',
      expect.objectContaining({ successCount: 100 }),
    );
  });

  it('does not send another recipient after the daily cap is reached', async () => {
    mocks.getBroadcastById.mockResolvedValue({ ...broadcast, daily_limit: 100 });
    mocks.getBroadcastAttemptsToday.mockResolvedValue(100);
    mocks.getPendingBroadcastQueue.mockResolvedValue([]);
    mocks.getBroadcastQueueCounts.mockResolvedValue({
      total: 120, pending: 20, processing: 0, success: 100, failed: 0,
    });

    await processBroadcastSend({} as D1Database, {} as never, 7);

    expect(mocks.getPendingBroadcastQueue).toHaveBeenCalledWith({} as D1Database, 7, 0);
    expect(mocks.updateBroadcastStatus).toHaveBeenLastCalledWith(
      {} as D1Database,
      7,
      'sending',
      expect.objectContaining({ successCount: 100 }),
    );
  });

  it('drip-feeds one recipient and keeps a rolling broadcast active when caught up', async () => {
    mocks.getBroadcastById.mockResolvedValue({
      ...broadcast,
      daily_limit: 200,
      auto_append_recipients: 1,
      audience_cursor_follower_id: 42,
    });
    mocks.getPendingBroadcastQueue.mockResolvedValue([queueItem(1)]);
    mocks.getBroadcastQueueCounts.mockResolvedValue({
      total: 1, pending: 0, processing: 0, success: 1, failed: 0,
    });
    const sendText = vi.fn().mockResolvedValue({});
    const db = {
      prepare: () => ({ bind: () => ({ run: vi.fn().mockResolvedValue(undefined) }) }),
    } as unknown as D1Database;

    await processBroadcastSend(db, { sendText } as never, 7, undefined, 'account-1');

    expect(mocks.initializeBroadcastQueue).toHaveBeenCalledWith(db, expect.objectContaining({
      broadcastId: 7,
      appendNewRecipients: true,
      audienceCursorFollowerId: 42,
    }));
    expect(mocks.getPendingBroadcastQueue).toHaveBeenCalledWith(db, 7, 1);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(mocks.updateBroadcastStatus).toHaveBeenLastCalledWith(
      db,
      7,
      'sending',
      expect.objectContaining({ successCount: 1 }),
    );
  });

  it('checkpoints a Meta rejection as failed and continues the batch', async () => {
    mocks.getPendingBroadcastQueue.mockResolvedValue([queueItem(1), queueItem(2)]);
    mocks.getBroadcastQueueCounts.mockResolvedValue({
      total: 2, pending: 0, processing: 0, success: 1, failed: 1,
    });
    const sendText = vi.fn()
      .mockRejectedValueOnce(new Error('Instagram API error code=551'))
      .mockResolvedValueOnce({});
    const db = {
      prepare: () => ({ bind: () => ({ run: vi.fn().mockResolvedValue(undefined) }) }),
    } as unknown as D1Database;

    await processBroadcastSend(db, { sendText } as never, 7, undefined, 'account-1');

    expect(sendText).toHaveBeenCalledTimes(2);
    expect(mocks.completeBroadcastQueueItem).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ id: 1, status: 'failed', errorCode: '551' }),
    );
    expect(mocks.completeBroadcastQueueItem).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ id: 2, status: 'success' }),
    );
  });

  it('backs off the whole broadcast when Meta returns a transient rate limit', async () => {
    const db = {
      prepare: vi.fn(() => ({
        bind: () => ({
          first: vi.fn().mockResolvedValue({
            body: JSON.stringify({ text: 'hello' }),
            message_type: 'text',
            status: 'sending',
          }),
        }),
      })),
    } as unknown as D1Database;
    const sendText = vi.fn().mockRejectedValue(new Error('Instagram API 429 rate limit'));

    await expect(processBroadcastWorkItem(
      db,
      { sendText } as never,
      { broadcastId: 7, queueItemId: 1, followerId: 1, recipientIgsid: 'ig-1', accountId: 'account-1' },
      2,
    )).rejects.toThrow('429');

    expect(mocks.setBroadcastBackoff).toHaveBeenCalledWith(
      db,
      7,
      expect.any(String),
      expect.stringContaining('5分待機'),
    );
    expect(mocks.completeBroadcastQueueItem).not.toHaveBeenCalled();
  });
});
