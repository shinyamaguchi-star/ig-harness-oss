import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  getFriendByIgsid: vi.fn(),
  upsertFriend: vi.fn(),
}));

vi.mock('@ig-harness/db', () => dbMocks);

import { processConversationBackfill, syncConversationPage } from '../conversation-sync.js';

describe('syncConversationPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('imports new contacts, updates owned contacts, and skips cross-account rows', async () => {
    const client = {
      getConversations: vi.fn().mockResolvedValue({
        data: [
          { id: 'c1', participants: { data: [{ id: 'business-ig' }, { id: 'new-user', username: 'new_user' }] } },
          { id: 'c2', participants: { data: [{ id: 'owned-user', name: 'Owned' }] } },
          { id: 'c3', participants: { data: [{ id: 'other-user', username: 'other' }] } },
          { id: 'c4', participants: { data: [] } },
        ],
        paging: { cursors: { after: 'next-cursor' }, next: 'https://graph.instagram.com/next' },
      }),
    };
    dbMocks.getFriendByIgsid.mockImplementation(async (_db: unknown, id: string) => {
      if (id === 'owned-user') return { id: 2, igsid: id, account_id: 'account-A' };
      if (id === 'other-user') return { id: 3, igsid: id, account_id: 'account-B' };
      return null;
    });
    dbMocks.upsertFriend.mockResolvedValue({ id: 1 });

    const result = await syncConversationPage(
      {} as D1Database,
      client as never,
      { id: 'account-A', ig_user_id: 'business-ig' },
    );

    expect(result).toEqual({
      conversationsScanned: 4,
      contactsFound: 3,
      added: 1,
      updated: 1,
      skipped: 2,
      nextCursor: 'next-cursor',
      hasMore: true,
    });
    expect(dbMocks.upsertFriend).toHaveBeenCalledTimes(2);
    expect(dbMocks.upsertFriend).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      igsid: 'new-user',
      username: 'new_user',
      accountId: 'account-A',
    }));
  });

  it('is idempotent when every contact already belongs to the account', async () => {
    const client = {
      getConversations: vi.fn().mockResolvedValue({
        data: [{ id: 'c1', participants: { data: [{ id: 'known-user' }] } }],
      }),
    };
    dbMocks.getFriendByIgsid.mockResolvedValue({ id: 1, igsid: 'known-user', account_id: 'account-A' });
    dbMocks.upsertFriend.mockResolvedValue({ id: 1 });

    const result = await syncConversationPage(
      {} as D1Database,
      client as never,
      { id: 'account-A', ig_user_id: 'business-ig' },
    );

    expect(result.added).toBe(0);
    expect(result.updated).toBe(1);
    expect(result.hasMore).toBe(false);
  });

  it('persists the automatic backfill cursor and completion state', async () => {
    const writes: unknown[][] = [];
    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: (...values: unknown[]) => ({
          first: async () => sql.startsWith('SELECT value') ? null : null,
          run: async () => { writes.push(values); return { success: true }; },
        }),
      })),
    };
    const client = {
      getConversations: vi.fn().mockResolvedValue({
        data: [{ id: 'c1', participants: { data: [{ id: 'known-user' }] } }],
      }),
    };
    dbMocks.getFriendByIgsid.mockResolvedValue(null);
    dbMocks.upsertFriend.mockResolvedValue({ id: 1 });

    const result = await processConversationBackfill(
      db as unknown as D1Database,
      client as never,
      { id: 'account-A', ig_user_id: 'business-ig' },
    );

    expect(result).toMatchObject({ done: true, conversationsScanned: 1, added: 1 });
    expect(writes).toHaveLength(2);
    expect(writes[0]?.[0]).toBe('conversation_backfill_v1:account-A');
    expect(JSON.parse(String(writes[0]?.[1]))).toMatchObject({ done: true, added: 1 });
  });
});
