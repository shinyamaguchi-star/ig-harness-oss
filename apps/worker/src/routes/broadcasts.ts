import { Hono } from 'hono';
import {
  getBroadcasts,
  getBroadcastById,
  createBroadcast,
  updateBroadcast,
  deleteBroadcast,
  getIgAccountById,
  getBroadcastDeliveries,
} from '@ig-harness/db';
import type { Broadcast as DbBroadcast, BroadcastMessageType } from '@ig-harness/db';
import { describeBroadcastFailure, processBroadcastSend } from '../services/broadcast.js';
import { resolveAccount, getAccountClient } from '../lib/accounts.js';
import type { Env } from '../index.js';

const broadcasts = new Hono<Env>();

function serializeBroadcast(row: DbBroadcast) {
  return {
    id: row.id,
    name: row.name,
    messageType: row.message_type,
    body: row.body,
    tagFilter: row.tag_filter,
    status: row.status,
    scheduledAt: row.scheduled_at,
    sentAt: row.sent_at,
    totalSent: row.total_sent,
    totalTarget: row.total_target,
    successCount: row.success_count,
    failureCount: row.failure_count,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getOwnedBroadcast(c: Parameters<typeof resolveAccount>[0], id: string) {
  const account = await resolveAccount(c);
  if (!account) return { account: null, broadcast: null };
  const broadcast = await getBroadcastById(c.env.DB, id);
  if (!broadcast || broadcast.account_id !== account.id) return { account, broadcast: null };
  return { account, broadcast };
}

// GET /api/broadcasts - list all
broadcasts.get('/api/broadcasts', async (c) => {
  try {
    const account = await resolveAccount(c);
    if (!account) return c.json({ success: false, error: 'account not found' }, 404);
    const items = await getBroadcasts(c.env.DB, { accountId: account.id });
    return c.json({ success: true, data: items.map(serializeBroadcast) });
  } catch (err) {
    console.error('GET /api/broadcasts error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/broadcasts/audience-count — preview current recipient count.
broadcasts.get('/api/broadcasts/audience-count', async (c) => {
  try {
    const account = await resolveAccount(c);
    if (!account) return c.json({ success: false, error: 'account not found' }, 404);
    const tagId = c.req.query('tag_id');
    const row = tagId
      ? await c.env.DB
          .prepare(
            `SELECT COUNT(DISTINCT f.id) AS count
             FROM followers f
             INNER JOIN follower_tags ft ON ft.follower_id = f.id
             WHERE f.account_id = ? AND ft.tag_id = ?`,
          )
          .bind(account.id, tagId)
          .first<{ count: number }>()
      : await c.env.DB
          .prepare('SELECT COUNT(*) AS count FROM followers WHERE account_id = ?')
          .bind(account.id)
          .first<{ count: number }>();
    return c.json({ success: true, data: { count: Number(row?.count ?? 0) } });
  } catch (err) {
    console.error('GET /api/broadcasts/audience-count error:', err);
    return c.json({ success: false, error: '対象人数の取得に失敗しました' }, 500);
  }
});

// GET /api/broadcasts/:id - get single
broadcasts.get('/api/broadcasts/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const { broadcast } = await getOwnedBroadcast(c, id);

    if (!broadcast) {
      return c.json({ success: false, error: 'Broadcast not found' }, 404);
    }

    return c.json({ success: true, data: serializeBroadcast(broadcast) });
  } catch (err) {
    console.error('GET /api/broadcasts/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/broadcasts/:id/deliveries — recipient-level results.
broadcasts.get('/api/broadcasts/:id/deliveries', async (c) => {
  try {
    const id = c.req.param('id');
    const { broadcast } = await getOwnedBroadcast(c, id);
    if (!broadcast) return c.json({ success: false, error: 'Broadcast not found' }, 404);
    const requestedStatus = c.req.query('status');
    const status = requestedStatus === 'success' || requestedStatus === 'failed'
      ? requestedStatus
      : undefined;
    const deliveries = await getBroadcastDeliveries(c.env.DB, id, { status, limit: 500 });
    return c.json({
      success: true,
      data: deliveries.map((row) => ({
        id: row.id,
        followerId: row.follower_id,
        recipientHint: row.recipient_igsid.slice(-4).padStart(4, '*'),
        username: row.username,
        displayName: row.display_name,
        status: row.status,
        errorCode: row.error_code,
        errorMessage: row.error_message,
        attemptedAt: row.attempted_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/broadcasts/:id/deliveries error:', err);
    return c.json({ success: false, error: '配信結果の取得に失敗しました' }, 500);
  }
});

// POST /api/broadcasts - create
broadcasts.post('/api/broadcasts', async (c) => {
  try {
    const account = await resolveAccount(c);
    if (!account) return c.json({ success: false, error: 'account not found' }, 404);
    const reqBody = await c.req.json<{
      name: string;
      messageType: BroadcastMessageType;
      body: string;
      tagFilter?: string | null;
      scheduledAt?: string | null;
    }>();

    if (!reqBody.name || !reqBody.messageType || !reqBody.body) {
      return c.json(
        { success: false, error: 'name, messageType, and body are required' },
        400,
      );
    }

    const broadcast = await createBroadcast(c.env.DB, {
      name: reqBody.name,
      messageType: reqBody.messageType,
      body: reqBody.body,
      tagFilter: reqBody.tagFilter ?? null,
      scheduledAt: reqBody.scheduledAt ?? null,
      accountId: account.id,
    });

    return c.json({ success: true, data: serializeBroadcast(broadcast) }, 201);
  } catch (err) {
    console.error('POST /api/broadcasts error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/broadcasts/:id - update draft
broadcasts.put('/api/broadcasts/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const { broadcast: existing } = await getOwnedBroadcast(c, id);

    if (!existing) {
      return c.json({ success: false, error: 'Broadcast not found' }, 404);
    }

    if (existing.status !== 'draft' && existing.status !== 'scheduled') {
      return c.json({ success: false, error: 'Only draft or scheduled broadcasts can be updated' }, 400);
    }

    const reqBody = await c.req.json<{
      name?: string;
      messageType?: BroadcastMessageType;
      body?: string;
      tagFilter?: string | null;
      scheduledAt?: string | null;
    }>();

    // Keep status in sync with scheduledAt changes
    let statusUpdate: 'draft' | 'scheduled' | undefined;
    if (reqBody.scheduledAt !== undefined) {
      statusUpdate = reqBody.scheduledAt ? 'scheduled' : 'draft';
    }

    const updated = await updateBroadcast(c.env.DB, id, {
      name: reqBody.name,
      message_type: reqBody.messageType,
      body: reqBody.body,
      tag_filter: reqBody.tagFilter,
      scheduled_at: reqBody.scheduledAt,
      ...(statusUpdate !== undefined ? { status: statusUpdate } : {}),
    });

    return c.json({ success: true, data: updated ? serializeBroadcast(updated) : null });
  } catch (err) {
    console.error('PUT /api/broadcasts/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/broadcasts/:id - delete
broadcasts.delete('/api/broadcasts/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const { broadcast } = await getOwnedBroadcast(c, id);
    if (!broadcast) return c.json({ success: false, error: 'Broadcast not found' }, 404);
    if (broadcast.status === 'sending') {
      return c.json({ success: false, error: '送信中の一斉配信は削除できません' }, 400);
    }
    await deleteBroadcast(c.env.DB, id);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/broadcasts/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/broadcasts/:id/send - send now
broadcasts.post('/api/broadcasts/:id/send', async (c) => {
  try {
    const id = c.req.param('id');
    const { broadcast: existing } = await getOwnedBroadcast(c, id);

    if (!existing) {
      return c.json({ success: false, error: 'Broadcast not found' }, 404);
    }

    if (existing.status === 'sending' || existing.status === 'sent') {
      return c.json({ success: false, error: 'Broadcast is already sent or sending' }, 400);
    }

    // The broadcast's owning account must do the sending — a client built
    // from ?account_id/default could DM another account's audience with the
    // wrong token when the ids diverge.
    const account = existing.account_id
      ? await getIgAccountById(c.env.DB, existing.account_id)
      : await resolveAccount(c);
    if (!account) return c.json({ success: false, error: 'account not found' }, 404);
    const igClient = await getAccountClient(c.env, c.env.DB, account);
    await processBroadcastSend(c.env.DB, igClient, existing.id, c.env.WORKER_URL, account.id);

    const result = await getBroadcastById(c.env.DB, existing.id);
    return c.json({ success: true, data: result ? serializeBroadcast(result) : null });
  } catch (err) {
    console.error('POST /api/broadcasts/:id/send error:', err);
    return c.json({ success: false, error: describeBroadcastFailure(err).message }, 500);
  }
});

export { broadcasts };
