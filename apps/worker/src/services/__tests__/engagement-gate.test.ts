import { describe, it, expect, beforeEach, vi } from 'vitest';
import { triggerGateForComment, triggerGateForDmKeyword } from '../engagement-gate.js';

// Module-level mock so logMessage doesn't hit the real DB
vi.mock('@ig-harness/db', async (importOriginal) => {
  const original = await importOriginal<typeof import('@ig-harness/db')>();
  return {
    ...original,
    logMessage: vi.fn().mockResolvedValue(undefined),
    getRichMessage: vi.fn().mockResolvedValue({ id: 'rm-1', blocks: [{ type: 'text', text: 'Hello rich' }] }),
  };
});

// Minimal in-memory D1 mock — only the methods we use
function createMockDb() {
  const gates: any[] = [];
  const deliveries: any[] = [];
  const followers: any[] = [];
  const log: string[] = [];

  function makeStatement(sql: string, params: unknown[]) {
    return {
      async first<T>() {
        if (sql.includes('FROM engagement_gates') && sql.includes('WHERE id = ?')) {
          return gates.find((g) => g.id === params[0]) ?? null;
        }
        // packages/db createGateDelivery does INSERT then SELECT-by-id to
        // return the new row; mock must handle that lookup too.
        if (sql.includes('FROM gate_deliveries') && sql.includes('WHERE id = ?')) {
          return deliveries.find((d) => d.id === params[0]) ?? null;
        }
        if (sql.includes('FROM gate_deliveries') && sql.includes('WHERE gate_id = ? AND follower_id = ?')) {
          const expectsPost = sql.includes('trigger_post_id = ?');
          const expectsGlobal = sql.includes('trigger_post_id IS NULL');
          return deliveries.find((d) =>
            d.gate_id === params[0] &&
            d.follower_id === params[1] &&
            (!expectsPost || d.trigger_post_id === params[2]) &&
            (!expectsGlobal || d.trigger_post_id == null),
          ) ?? null;
        }
        return null;
      },
      async all<T>() {
        if (sql.includes('FROM gate_target_posts')) {
          return {
            results: gates.flatMap((gate) =>
              (gate.target_post_ids ?? []).map((postId: string) => ({
                gate_id: gate.id,
                post_id: postId,
              })),
            ),
          };
        }
        if (sql.includes("FROM engagement_gates") && sql.includes("status = 'active'")) {
          return { results: gates.filter((g) => g.status === 'active') };
        }
        if (sql.includes("FROM engagement_gates")) {
          return { results: gates };
        }
        return { results: [] };
      },
      async run() {
        if (sql.startsWith('INSERT INTO gate_deliveries')) {
          deliveries.push({
            id: params[0], gate_id: params[1], follower_id: params[2],
            igsid: params[3], metadata: params[4], trigger_post_id: params[5] ?? null,
            status: 'triggered', loop_count: 0,
            last_check_at: null, delivered_at: null,
            triggered_at: new Date().toISOString(),
          });
        }
        if (sql.startsWith('UPDATE gate_deliveries')) {
          // Naive: last param is id
          const id = params[params.length - 1];
          const target = deliveries.find((d) => d.id === id);
          if (target) {
            const m = sql.match(/SET (.+) WHERE/);
            if (m) {
              const fields = m[1].split(',').map((s) => s.trim().split(' = ')[0]);
              fields.forEach((f, i) => { (target as any)[f] = params[i]; });
            }
          }
        }
        return { meta: { changes: 1 } };
      },
    };
  }

  const db = {
    gates, deliveries, followers, log,
    prepare(sql: string) {
      const stmt = makeStatement(sql, []);
      return {
        ...stmt,
        bind(...params: unknown[]) {
          return makeStatement(sql, params);
        },
      };
    },
  };
  return db as unknown as D1Database & { gates: any[]; deliveries: any[]; followers: any[]; log: string[] };
}

const fakeIgClient = {
  sendGenericTemplate: vi.fn(async () => ({})),
  sendQuickReply: vi.fn(async () => ({})),
  sendText: vi.fn(async () => ({})),
  getUserProfile: vi.fn(async () => ({ is_user_follow_business: true })),
  replyToComment: vi.fn(async () => ({})),
  postCommentToMedia: vi.fn(async () => ({})),
};

describe('triggerGateForComment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a delivery and sends CTA DM when gate matches', async () => {
    const db = createMockDb();
    db.gates.push({
      id: 'gate-1',
      status: 'active',
      trigger_type: 'comment_on_post',
      target_post_id: 'post-1',
      trigger_keyword: '参加',
      require_follow: 1,
      initial_dm_text: '特典の準備ができました！下のボタンを押してね',
      initial_dm_button_label: '特典を受け取る',
      follow_reminder_dm_text: '',
      follow_reminder_button_label: '',
      reward_dm_text: '',
      reward_url: null,
      max_loops: 0,
    });

    await triggerGateForComment(db, fakeIgClient as never, {
      postId: 'post-1',
      commentText: '参加します',
      follower: { id: 42, igsid: 'IGSID42' },
    });

    expect(db.deliveries).toHaveLength(1);
    expect(db.deliveries[0].gate_id).toBe('gate-1');
    expect(db.deliveries[0].follower_id).toBe(42);
    expect(db.deliveries[0].trigger_post_id).toBe('post-1');
    expect(fakeIgClient.sendGenericTemplate).toHaveBeenCalledTimes(1);
    const call = fakeIgClient.sendGenericTemplate.mock.calls[0] as unknown as [string, unknown[]];
    expect(call[0]).toBe('IGSID42');
    expect(JSON.stringify(call[1])).toContain('CHECK_FOLLOW:gate-1:');
  });

  it('marks a one-step rich message delivered without waiting for a postback', async () => {
    const db = createMockDb();
    db.gates.push({
      id: 'gate-direct',
      status: 'active',
      trigger_type: 'comment_on_post',
      target_post_id: 'post-direct',
      trigger_keyword: null,
      require_follow: 0,
      initial_dm_rich_message_id: 'rm-1',
      initial_dm_text: 'direct fallback',
      initial_dm_button_label: '',
      follow_reminder_dm_text: '',
      follow_reminder_button_label: '',
      reward_dm_text: '',
      reward_url: 'https://example.com/offer',
      max_loops: 0,
      allow_repeat: 0,
      created_at: '2026-01-01T00:00:00Z',
    });
    const client = {
      ...fakeIgClient,
      sendRichMessage: vi.fn(async () => ({ sentBlocks: 1 })),
    };

    await triggerGateForComment(db, client as never, {
      postId: 'post-direct',
      commentText: 'anything',
      follower: { id: 77, igsid: 'IGSID77' },
      workerBaseUrl: 'https://worker.example',
    });

    expect(client.sendRichMessage).toHaveBeenCalledTimes(1);
    const richCall = client.sendRichMessage.mock.calls[0] as unknown as [string, unknown[], { rewardUrl?: string }];
    expect(richCall[2]).toEqual(
      expect.objectContaining({
        rewardUrl: expect.stringContaining('https://worker.example/click/gate-direct'),
      }),
    );
    expect(db.deliveries[0].status).toBe('delivered');
    expect(db.deliveries[0].delivered_at).toBeTruthy();
  });

  it('sends comment reply and CTA once per linked post for the same follower', async () => {
    const db = createMockDb();
    db.gates.push({
      id: 'gate-multi-post',
      status: 'active',
      trigger_type: 'comment_on_post',
      target_post_id: 'post-1',
      target_post_ids: ['post-1', 'post-2'],
      trigger_keyword: '参加',
      require_follow: 1,
      initial_dm_text: '特典を確認してください',
      initial_dm_button_label: '確認する',
      follow_reminder_dm_text: '',
      follow_reminder_button_label: '',
      reward_dm_text: '',
      reward_url: null,
      max_loops: 0,
      allow_repeat: 0,
      comment_reply_text: 'DMを確認してください',
      created_at: '2026-01-01T00:00:00Z',
    });

    const base = {
      commentText: '参加します',
      commenterUsername: 'sample_user',
      follower: { id: 42, igsid: 'IGSID42' },
    };
    await triggerGateForComment(db, fakeIgClient as never, {
      ...base,
      postId: 'post-1',
      commentId: 'comment-1',
    });
    await triggerGateForComment(db, fakeIgClient as never, {
      ...base,
      postId: 'post-1',
      commentId: 'comment-1-duplicate',
    });
    await triggerGateForComment(db, fakeIgClient as never, {
      ...base,
      postId: 'post-2',
      commentId: 'comment-2',
    });

    expect(db.deliveries).toHaveLength(2);
    expect(db.deliveries.map((d) => d.trigger_post_id)).toEqual(['post-1', 'post-2']);
    expect(fakeIgClient.sendGenericTemplate).toHaveBeenCalledTimes(2);
    expect(fakeIgClient.replyToComment).toHaveBeenCalledTimes(2);
    expect(fakeIgClient.replyToComment).toHaveBeenNthCalledWith(
      1,
      'comment-1',
      'DMを確認してください',
    );
    expect(fakeIgClient.replyToComment).toHaveBeenNthCalledWith(
      2,
      'comment-2',
      'DMを確認してください',
    );
  });

  it('keeps DM keyword delivery idempotent across the account', async () => {
    const db = createMockDb();
    db.gates.push({
      id: 'gate-dm',
      status: 'active',
      trigger_type: 'dm_keyword',
      target_post_id: null,
      trigger_keyword: '案内',
      require_follow: 1,
      initial_dm_text: 'ご案内です',
      initial_dm_button_label: '確認する',
      follow_reminder_dm_text: '',
      follow_reminder_button_label: '',
      reward_dm_text: '',
      reward_url: null,
      max_loops: 0,
      allow_repeat: 0,
      created_at: '2026-01-01T00:00:00Z',
    });

    const args = {
      text: '案内をください',
      follower: { id: 42, igsid: 'IGSID42' },
    };
    await triggerGateForDmKeyword(db, fakeIgClient as never, args);
    await triggerGateForDmKeyword(db, fakeIgClient as never, args);

    expect(db.deliveries).toHaveLength(1);
    expect(db.deliveries[0].trigger_post_id).toBeNull();
    expect(fakeIgClient.sendGenericTemplate).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no active gate matches the post', async () => {
    const db = createMockDb();
    db.gates.push({
      id: 'gate-1', status: 'active', trigger_type: 'comment_on_post',
      target_post_id: 'post-OTHER', trigger_keyword: null,
      require_follow: 1, initial_dm_text: 'x', initial_dm_button_label: 'x',
      follow_reminder_dm_text: '', follow_reminder_button_label: '',
      reward_dm_text: '', reward_url: null, max_loops: 0,
    });

    await triggerGateForComment(db, fakeIgClient as never, {
      postId: 'post-1',
      commentText: '参加します',
      follower: { id: 42, igsid: 'IGSID42' },
    });

    expect(db.deliveries).toHaveLength(0);
    expect(fakeIgClient.sendGenericTemplate).not.toHaveBeenCalled();
  });

  it('skips when keyword does not match', async () => {
    const db = createMockDb();
    db.gates.push({
      id: 'gate-1', status: 'active', trigger_type: 'comment_on_post',
      target_post_id: 'post-1', trigger_keyword: '参加',
      require_follow: 1, initial_dm_text: 'x', initial_dm_button_label: 'x',
      follow_reminder_dm_text: '', follow_reminder_button_label: '',
      reward_dm_text: '', reward_url: null, max_loops: 0,
    });

    await triggerGateForComment(db, fakeIgClient as never, {
      postId: 'post-1',
      commentText: '無関係なコメント',
      follower: { id: 42, igsid: 'IGSID42' },
    });

    expect(db.deliveries).toHaveLength(0);
  });

  it('fires when any one of multiple comment keywords matches', async () => {
    const db = createMockDb();
    db.gates.push({
      id: 'gate-multiple', status: 'active', trigger_type: 'comment_on_post',
      target_post_id: 'post-1', trigger_keyword: '欲しい',
      trigger_keywords: JSON.stringify(['欲しい', '希望', 'お願いします']),
      require_follow: 1, initial_dm_text: 'x', initial_dm_button_label: 'x',
      follow_reminder_dm_text: '', follow_reminder_button_label: '',
      reward_dm_text: '', reward_url: null, max_loops: 0,
    });

    await triggerGateForComment(db, fakeIgClient as never, {
      postId: 'post-1',
      commentText: '特典を希望します',
      follower: { id: 42, igsid: 'IGSID42' },
    });

    expect(db.deliveries).toHaveLength(1);
    expect(fakeIgClient.sendGenericTemplate).toHaveBeenCalledTimes(1);
  });

  it('matches multiple comment keywords without distinguishing letter case', async () => {
    const db = createMockDb();
    db.gates.push({
      id: 'gate-case', status: 'active', trigger_type: 'comment_on_post',
      target_post_id: 'post-1', trigger_keyword: 'Present',
      trigger_keywords: JSON.stringify(['Present', 'Gift']),
      require_follow: 1, initial_dm_text: 'x', initial_dm_button_label: 'x',
      follow_reminder_dm_text: '', follow_reminder_button_label: '',
      reward_dm_text: '', reward_url: null, max_loops: 0,
    });

    await triggerGateForComment(db, fakeIgClient as never, {
      postId: 'post-1',
      commentText: 'GIFT please',
      follower: { id: 42, igsid: 'IGSID42' },
    });

    expect(db.deliveries).toHaveLength(1);
  });

  it('does not fire when none of the multiple comment keywords match', async () => {
    const db = createMockDb();
    db.gates.push({
      id: 'gate-no-match', status: 'active', trigger_type: 'comment_on_post',
      target_post_id: 'post-1', trigger_keyword: '欲しい',
      trigger_keywords: JSON.stringify(['欲しい', '希望', 'お願いします']),
      require_follow: 1, initial_dm_text: 'x', initial_dm_button_label: 'x',
      follow_reminder_dm_text: '', follow_reminder_button_label: '',
      reward_dm_text: '', reward_url: null, max_loops: 0,
    });

    await triggerGateForComment(db, fakeIgClient as never, {
      postId: 'post-1',
      commentText: '普通の感想です',
      follower: { id: 42, igsid: 'IGSID42' },
    });

    expect(db.deliveries).toHaveLength(0);
  });

  it('replies inside the triggering comment thread and removes a legacy leading mention', async () => {
    const db = createMockDb();
    db.gates.push({
      id: 'gate-threaded-reply', status: 'active', trigger_type: 'comment_on_post',
      target_post_id: 'post-1', trigger_keyword: null,
      require_follow: 1, initial_dm_text: 'x', initial_dm_button_label: 'x',
      follow_reminder_dm_text: '', follow_reminder_button_label: '',
      reward_dm_text: '', reward_url: null, max_loops: 0,
      comment_reply_text: '@{{username}} DMを確認してね',
    });

    await triggerGateForComment(db, fakeIgClient as never, {
      postId: 'post-1',
      commentId: 'comment-123',
      commentText: '欲しい',
      commenterUsername: 'sample_user',
      follower: { id: 42, igsid: 'IGSID42' },
    });

    expect(fakeIgClient.replyToComment).toHaveBeenCalledWith('comment-123', 'DMを確認してね');
    expect(fakeIgClient.postCommentToMedia).not.toHaveBeenCalled();
  });

  it('can rotate across ten threaded comment reply patterns', async () => {
    const db = createMockDb();
    const patterns = Array.from({ length: 10 }, (_, index) => `返信パターン${index + 1}`);
    db.gates.push({
      id: 'gate-ten-replies', status: 'active', trigger_type: 'comment_on_post',
      target_post_id: 'post-1', trigger_keyword: null,
      require_follow: 1, initial_dm_text: 'x', initial_dm_button_label: 'x',
      follow_reminder_dm_text: '', follow_reminder_button_label: '',
      reward_dm_text: '', reward_url: null, max_loops: 0,
      comment_reply_text: JSON.stringify(patterns),
    });
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.999);

    try {
      await triggerGateForComment(db, fakeIgClient as never, {
        postId: 'post-1',
        commentId: 'comment-ten',
        commentText: '欲しい',
        follower: { id: 42, igsid: 'IGSID42' },
      });
    } finally {
      random.mockRestore();
    }

    expect(fakeIgClient.replyToComment).toHaveBeenCalledWith('comment-ten', '返信パターン10');
  });
});

describe('logMessage integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls logMessage with direction:out and triggerSource:gate after triggerGateForComment', async () => {
    const { logMessage } = await import('@ig-harness/db');

    // Extended mock DB that handles SELECT by id after INSERT
    // so createGateDelivery's post-insert SELECT succeeds.
    const gates: any[] = [];
    const deliveries: any[] = [];

    function makeStatement(sql: string, params: unknown[]) {
      return {
        async first<T>() {
          if (sql.includes('FROM engagement_gates') && sql.includes('WHERE id = ?')) {
            return (gates.find((g) => g.id === params[0]) ?? null) as T;
          }
          if (sql.includes('FROM gate_deliveries') && sql.includes('WHERE gate_id = ?') && sql.includes('follower_id = ?')) {
            return (deliveries.find((d) => d.gate_id === params[0] && d.follower_id === params[1]) ?? null) as T;
          }
          // Post-insert SELECT by id
          if (sql.includes('FROM gate_deliveries') && sql.includes('WHERE id = ?')) {
            return (deliveries.find((d) => d.id === params[0]) ?? null) as T;
          }
          return null as T;
        },
        async all<T>() {
          if (sql.includes("FROM engagement_gates") && sql.includes("status = 'active'")) {
            return { results: gates.filter((g) => g.status === 'active') as T[] };
          }
          if (sql.includes("FROM engagement_gates")) {
            return { results: gates as T[] };
          }
          return { results: [] as T[] };
        },
        async run() {
          if (sql.startsWith('INSERT INTO gate_deliveries')) {
            deliveries.push({
              id: params[0], gate_id: params[1], follower_id: params[2],
              igsid: params[3], metadata: params[4],
              status: 'triggered', loop_count: 0,
              last_check_at: null, delivered_at: null,
              triggered_at: new Date().toISOString(),
              followup_step_sent: 0, next_followup_at: null,
            });
          }
          if (sql.startsWith('UPDATE gate_deliveries')) {
            const id = params[params.length - 1];
            const target = deliveries.find((d) => d.id === id);
            if (target) {
              const m = sql.match(/SET (.+) WHERE/);
              if (m) {
                const fields = m[1].split(',').map((s) => s.trim().split(' = ')[0]);
                fields.forEach((f, i) => { (target as any)[f] = params[i]; });
              }
            }
          }
          return { meta: { changes: 1 } };
        },
      };
    }

    const db = {
      gates, deliveries,
      prepare(sql: string) {
        const stmt = makeStatement(sql, []);
        return { ...stmt, bind(...p: unknown[]) { return makeStatement(sql, p); } };
      },
    } as unknown as D1Database;

    gates.push({
      id: 'gate-log',
      status: 'active',
      trigger_type: 'comment_on_post',
      target_post_id: 'post-log',
      target_post_ids: [],
      trigger_keyword: null,
      require_follow: 1,
      initial_dm_text: 'CTA text',
      initial_dm_button_label: 'Tap me',
      follow_reminder_dm_text: '',
      follow_reminder_button_label: '',
      reward_dm_text: '',
      reward_url: null,
      max_loops: 0,
      allow_repeat: 0,
      created_at: '2025-01-01T00:00:00Z',
    });

    const igClient = {
      sendGenericTemplate: vi.fn(async () => ({})),
      sendQuickReply: vi.fn(async () => ({})),
      sendText: vi.fn(async () => ({})),
      getUserProfile: vi.fn(async () => ({ is_user_follow_business: true })),
    };

    await triggerGateForComment(db, igClient as never, {
      postId: 'post-log',
      commentText: 'anything',
      follower: { id: 99, igsid: 'IGSID99' },
    });

    expect(logMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        direction: 'out',
        triggerSource: 'gate',
        messageType: 'template',
        followerId: 99,
      }),
    );
  });

  it('logs JSON rich body convention when gate uses rich message', async () => {
    const { logMessage } = await import('@ig-harness/db');
    vi.clearAllMocks();

    // Setup DB with a gate that references a rich message
    const gates: any[] = [];
    const deliveries: any[] = [];
    const richMessages: any[] = [{ id: 'rm-1', blocks: [{ type: 'text', text: 'Hello rich' }] }];

    function makeStatement(sql: string, params: unknown[]) {
      return {
        async first<T>() {
          if (sql.includes('FROM engagement_gates') && sql.includes('WHERE id = ?'))
            return (gates.find((g) => g.id === params[0]) ?? null) as T;
          if (sql.includes('FROM gate_deliveries') && sql.includes('gate_id = ?') && sql.includes('follower_id = ?'))
            return (deliveries.find((d) => d.gate_id === params[0] && d.follower_id === params[1]) ?? null) as T;
          if (sql.includes('FROM gate_deliveries') && sql.includes('WHERE id = ?'))
            return (deliveries.find((d) => d.id === params[0]) ?? null) as T;
          if (sql.includes('FROM rich_messages') && sql.includes('WHERE id = ?'))
            return (richMessages.find((r) => r.id === params[0]) ?? null) as T;
          return null as T;
        },
        async all<T>() {
          if (sql.includes("FROM engagement_gates") && sql.includes("status = 'active'"))
            return { results: gates.filter((g) => g.status === 'active') as T[] };
          if (sql.includes("FROM engagement_gates"))
            return { results: gates as T[] };
          return { results: [] as T[] };
        },
        async run() {
          if (sql.startsWith('INSERT INTO gate_deliveries')) {
            deliveries.push({
              id: params[0], gate_id: params[1], follower_id: params[2],
              igsid: params[3], metadata: params[4],
              status: 'triggered', loop_count: 0,
              last_check_at: null, delivered_at: null,
              triggered_at: new Date().toISOString(),
              followup_step_sent: 0, next_followup_at: null,
            });
          }
          if (sql.startsWith('UPDATE gate_deliveries')) {
            const id = params[params.length - 1];
            const target = deliveries.find((d: any) => d.id === id);
            if (target) {
              const m = sql.match(/SET (.+) WHERE/);
              if (m) {
                const fields = m[1].split(',').map((s: string) => s.trim().split(' = ')[0]);
                fields.forEach((f: string, i: number) => { (target as any)[f] = params[i]; });
              }
            }
          }
          return { meta: { changes: 1 } };
        },
      };
    }

    const db = {
      gates, deliveries,
      prepare(sql: string) {
        const stmt = makeStatement(sql, []);
        return { ...stmt, bind(...p: unknown[]) { return makeStatement(sql, p); } };
      },
    } as unknown as D1Database;

    gates.push({
      id: 'gate-rich',
      status: 'active',
      trigger_type: 'comment_on_post',
      target_post_id: 'post-rich',
      target_post_ids: [],
      trigger_keyword: null,
      require_follow: 1,
      initial_dm_text: 'fallback text',
      initial_dm_button_label: 'Tap',
      initial_dm_rich_message_id: 'rm-1',  // triggers rich path
      follow_reminder_dm_text: '',
      follow_reminder_button_label: '',
      reward_dm_text: '',
      reward_url: null,
      max_loops: 0,
      allow_repeat: 0,
      created_at: '2025-01-01T00:00:00Z',
    });

    const igClient = {
      sendRichMessage: vi.fn(async () => ({})),
      sendGenericTemplate: vi.fn(async () => ({})),
      sendQuickReply: vi.fn(async () => ({})),
      sendText: vi.fn(async () => ({})),
      getUserProfile: vi.fn(async () => ({ is_user_follow_business: true })),
    };

    await triggerGateForComment(db, igClient as never, {
      postId: 'post-rich',
      commentText: 'anything',
      follower: { id: 77, igsid: 'IGSID77' },
    });

    expect(logMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        direction: 'out',
        triggerSource: 'gate',
        messageType: 'template',
        followerId: 77,
        body: JSON.stringify({ kind: 'rich', blocks: [{ type: 'text', text: 'Hello rich' }] }),
      }),
    );
  });
});
