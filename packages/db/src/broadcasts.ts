import { jstNow } from './utils.js';
export type BroadcastStatus = 'draft' | 'scheduled' | 'sending' | 'sent';
export type BroadcastMessageType = 'text' | 'image' | 'template' | 'quick_reply';

export interface Broadcast {
  id: number;
  name: string;
  message_type: BroadcastMessageType;
  body: string;
  tag_filter: string | null;
  status: BroadcastStatus;
  scheduled_at: string | null;
  sent_at: string | null;
  total_sent: number;
  total_target: number;
  success_count: number;
  failure_count: number;
  last_error: string | null;
  account_id: string | null;
  created_at: string;
  updated_at: string;
}

export async function getBroadcasts(
  db: D1Database,
  opts: { accountId?: string } = {},
): Promise<Broadcast[]> {
  const conditions: string[] = [];
  const binds: unknown[] = [];
  if (opts.accountId) {
    conditions.push('account_id = ?');
    binds.push(opts.accountId);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const stmt = db.prepare(`SELECT * FROM broadcasts ${where} ORDER BY created_at DESC`);
  const result = binds.length > 0
    ? await stmt.bind(...binds).all<Broadcast>()
    : await stmt.all<Broadcast>();
  return result.results;
}

export async function getBroadcastById(
  db: D1Database,
  id: number | string,
): Promise<Broadcast | null> {
  return db
    .prepare(`SELECT * FROM broadcasts WHERE id = ?`)
    .bind(id)
    .first<Broadcast>();
}

export interface CreateBroadcastInput {
  name: string;
  messageType: BroadcastMessageType;
  body: string;
  tagFilter?: string | null;
  scheduledAt?: string | null;
  /** Owning IG business account (ig_accounts.id). */
  accountId?: string;
}

export async function createBroadcast(
  db: D1Database,
  input: CreateBroadcastInput,
): Promise<Broadcast> {
  const now = jstNow();
  const initialStatus: BroadcastStatus = input.scheduledAt ? 'scheduled' : 'draft';

  const result = await db
    .prepare(
      `INSERT INTO broadcasts
         (name, message_type, body, tag_filter, status, scheduled_at, sent_at, total_sent, account_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?)
       RETURNING *`,
    )
    .bind(
      input.name,
      input.messageType,
      input.body,
      input.tagFilter ?? null,
      initialStatus,
      input.scheduledAt ?? null,
      input.accountId ?? null,
      now,
      now,
    )
    .first<Broadcast>();

  return result!;
}

export type UpdateBroadcastInput = Partial<
  Pick<
    Broadcast,
    | 'name'
    | 'message_type'
    | 'body'
    | 'tag_filter'
    | 'status'
    | 'scheduled_at'
  >
>;

export async function updateBroadcast(
  db: D1Database,
  id: number | string,
  updates: UpdateBroadcastInput,
): Promise<Broadcast | null> {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.message_type !== undefined) {
    fields.push('message_type = ?');
    values.push(updates.message_type);
  }
  if (updates.body !== undefined) {
    fields.push('body = ?');
    values.push(updates.body);
  }
  if (updates.tag_filter !== undefined) {
    fields.push('tag_filter = ?');
    values.push(updates.tag_filter);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.scheduled_at !== undefined) {
    fields.push('scheduled_at = ?');
    values.push(updates.scheduled_at);
  }

  if (fields.length > 0) {
    fields.push('updated_at = ?');
    values.push(jstNow());
    values.push(id);
    await db
      .prepare(`UPDATE broadcasts SET ${fields.join(', ')} WHERE id = ?`)
      .bind(...values)
      .run();
  }

  return getBroadcastById(db, id);
}

export async function deleteBroadcast(db: D1Database, id: number | string): Promise<void> {
  await db.prepare(`DELETE FROM broadcasts WHERE id = ?`).bind(id).run();
}

export interface BroadcastStatusCounts {
  totalSent?: number;
  totalTarget?: number;
  successCount?: number;
  failureCount?: number;
  lastError?: string | null;
}

export async function updateBroadcastStatus(
  db: D1Database,
  id: number | string,
  status: BroadcastStatus,
  counts?: BroadcastStatusCounts,
): Promise<void> {
  const fields: string[] = ['status = ?', 'updated_at = ?'];
  const values: unknown[] = [status, jstNow()];

  if (status === 'sent') {
    fields.push('sent_at = ?');
    values.push(jstNow());
  }
  if (counts?.totalSent !== undefined) {
    fields.push('total_sent = ?');
    values.push(counts.totalSent);
  }
  if (counts?.totalTarget !== undefined) {
    fields.push('total_target = ?');
    values.push(counts.totalTarget);
  }
  if (counts?.successCount !== undefined) {
    fields.push('success_count = ?');
    values.push(counts.successCount);
  }
  if (counts?.failureCount !== undefined) {
    fields.push('failure_count = ?');
    values.push(counts.failureCount);
  }
  if (counts?.lastError !== undefined) {
    fields.push('last_error = ?');
    values.push(counts.lastError);
  }

  values.push(id);
  await db
    .prepare(`UPDATE broadcasts SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();
}

export type BroadcastDeliveryStatus = 'success' | 'failed';

export interface BroadcastDelivery {
  id: number;
  broadcast_id: number;
  follower_id: number | null;
  recipient_igsid: string;
  status: BroadcastDeliveryStatus;
  error_code: string | null;
  error_message: string | null;
  attempted_at: string;
  username?: string | null;
  display_name?: string | null;
}

export async function clearBroadcastDeliveries(
  db: D1Database,
  broadcastId: number | string,
): Promise<void> {
  await db.prepare('DELETE FROM broadcast_deliveries WHERE broadcast_id = ?').bind(broadcastId).run();
}

export type BroadcastQueueStatus = 'pending' | 'processing' | 'success' | 'failed';

export interface BroadcastQueueItem {
  id: number;
  broadcast_id: number;
  follower_id: number | null;
  recipient_igsid: string;
  status: BroadcastQueueStatus;
  error_code: string | null;
  error_message: string | null;
  claimed_at: string | null;
  completed_at: string | null;
}

/** Remove a previous draft's queue before its first send. */
export async function clearBroadcastQueue(
  db: D1Database,
  broadcastId: number | string,
): Promise<void> {
  await db.prepare('DELETE FROM broadcast_queue WHERE broadcast_id = ?').bind(broadcastId).run();
}

/**
 * Freeze the audience at send-start. Existing result rows are imported first
 * so a broadcast left in `sending` by the old implementation can continue
 * without intentionally resending recipients already checkpointed there.
 */
export async function initializeBroadcastQueue(
  db: D1Database,
  input: { broadcastId: number | string; accountId: string | null; tagId?: string },
): Promise<number> {
  const existing = await db
    .prepare('SELECT COUNT(*) AS count FROM broadcast_queue WHERE broadcast_id = ?')
    .bind(input.broadcastId)
    .first<{ count: number }>();
  if (Number(existing?.count ?? 0) > 0) return Number(existing!.count);

  await db
    .prepare(
      `INSERT OR IGNORE INTO broadcast_queue
         (broadcast_id, follower_id, recipient_igsid, status, error_code, error_message, completed_at)
       SELECT broadcast_id, follower_id, recipient_igsid, status, error_code, error_message, attempted_at
       FROM broadcast_deliveries
       WHERE broadcast_id = ?`,
    )
    .bind(input.broadcastId)
    .run();

  const accountCondition = input.accountId ? 'f.account_id = ?' : '1 = 1';
  const tagJoin = input.tagId
    ? 'INNER JOIN follower_tags ft ON ft.follower_id = f.id AND ft.tag_id = ?'
    : '';
  const binds: unknown[] = [input.broadcastId];
  if (input.tagId) binds.push(input.tagId);
  if (input.accountId) binds.push(input.accountId);
  await db
    .prepare(
      `INSERT OR IGNORE INTO broadcast_queue
         (broadcast_id, follower_id, recipient_igsid, status)
       SELECT ?, f.id, f.igsid, 'pending'
       FROM followers f
       ${tagJoin}
       LEFT JOIN (
         SELECT follower_id, MAX(activity_at) AS last_activity_at
         FROM (
           -- A received DM is a direct reaction. Legacy comment-rule sends
           -- are also included because they prove that a comment was received.
           SELECT follower_id, created_at AS activity_at
           FROM messages_log
           WHERE direction = 'in' OR trigger_source = 'comment_rule'
           UNION ALL
           -- Campaign deliveries cover comments, DM keywords and story
           -- interactions handled by the newer engagement-gate flow.
           SELECT follower_id, triggered_at AS activity_at
           FROM gate_deliveries
         ) interaction_events
         GROUP BY follower_id
       ) recent_activity ON recent_activity.follower_id = f.id
       WHERE ${accountCondition}
       -- Queue ids determine batch order. People with the latest observed
       -- interaction are inserted first; people without history follow.
       ORDER BY recent_activity.last_activity_at DESC NULLS LAST,
                f.first_seen_at DESC,
                f.id DESC`,
    )
    .bind(...binds)
    .run();

  const total = await db
    .prepare('SELECT COUNT(*) AS count FROM broadcast_queue WHERE broadcast_id = ?')
    .bind(input.broadcastId)
    .first<{ count: number }>();
  return Number(total?.count ?? 0);
}

/** Convert abandoned in-flight rows to a visible uncertain failure.
 * Retrying these automatically could duplicate a DM that Meta accepted just
 * before the Worker stopped, so pending recipients continue but these do not.
 */
export async function failStaleBroadcastClaims(
  db: D1Database,
  broadcastId: number | string,
  staleBefore: string,
): Promise<void> {
  await db.batch([
    db.prepare(
      `INSERT INTO broadcast_deliveries
         (broadcast_id, follower_id, recipient_igsid, status, error_code, error_message)
       SELECT broadcast_id, follower_id, recipient_igsid, 'failed', 'DELIVERY_UNCERTAIN',
              '前回処理が途中で停止したため送信結果を確認できません。重複防止のため自動再送していません。'
       FROM broadcast_queue
       WHERE broadcast_id = ? AND status = 'processing' AND claimed_at < ?`,
    ).bind(broadcastId, staleBefore),
    db.prepare(
      `UPDATE broadcast_queue
       SET status = 'failed', error_code = 'DELIVERY_UNCERTAIN',
           error_message = '前回処理が途中で停止したため送信結果を確認できません。重複防止のため自動再送していません。',
           completed_at = strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now'))
       WHERE broadcast_id = ? AND status = 'processing' AND claimed_at < ?`,
    ).bind(broadcastId, staleBefore),
  ]);
}

export async function getPendingBroadcastQueue(
  db: D1Database,
  broadcastId: number | string,
  limit = 50,
): Promise<BroadcastQueueItem[]> {
  const result = await db
    .prepare(
      `SELECT * FROM broadcast_queue
       WHERE broadcast_id = ? AND status = 'pending'
       ORDER BY id ASC LIMIT ?`,
    )
    .bind(broadcastId, Math.min(Math.max(limit, 1), 50))
    .all<BroadcastQueueItem>();
  return result.results;
}

export async function claimBroadcastQueueItem(
  db: D1Database,
  id: number | string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE broadcast_queue
       SET status = 'processing', claimed_at = strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now'))
       WHERE id = ? AND status = 'pending'`,
    )
    .bind(id)
    .run();
  return Number(result.meta.changes ?? 0) === 1;
}

export async function completeBroadcastQueueItem(
  db: D1Database,
  input: {
    id: number | string;
    broadcastId: number | string;
    followerId: number | string | null;
    recipientIgsid: string;
    status: 'success' | 'failed';
    errorCode?: string | null;
    errorMessage?: string | null;
  },
): Promise<void> {
  await db.batch([
    db.prepare(
      `UPDATE broadcast_queue
       SET status = ?, error_code = ?, error_message = ?,
           completed_at = strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now'))
       WHERE id = ? AND status = 'processing'`,
    ).bind(input.status, input.errorCode ?? null, input.errorMessage ?? null, input.id),
    db.prepare(
      `INSERT INTO broadcast_deliveries
         (broadcast_id, follower_id, recipient_igsid, status, error_code, error_message)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      input.broadcastId,
      input.followerId,
      input.recipientIgsid,
      input.status,
      input.errorCode ?? null,
      input.errorMessage ?? null,
    ),
  ]);
}

export interface BroadcastQueueCounts {
  total: number;
  pending: number;
  processing: number;
  success: number;
  failed: number;
}

export async function getBroadcastQueueCounts(
  db: D1Database,
  broadcastId: number | string,
): Promise<BroadcastQueueCounts> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
              SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM broadcast_queue WHERE broadcast_id = ?`,
    )
    .bind(broadcastId)
    .first<Record<keyof BroadcastQueueCounts, number | null>>();
  return {
    total: Number(row?.total ?? 0),
    pending: Number(row?.pending ?? 0),
    processing: Number(row?.processing ?? 0),
    success: Number(row?.success ?? 0),
    failed: Number(row?.failed ?? 0),
  };
}

export async function recordBroadcastDelivery(
  db: D1Database,
  input: {
    broadcastId: number | string;
    followerId: number | string | null;
    recipientIgsid: string;
    status: BroadcastDeliveryStatus;
    errorCode?: string | null;
    errorMessage?: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO broadcast_deliveries
         (broadcast_id, follower_id, recipient_igsid, status, error_code, error_message)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.broadcastId,
      input.followerId,
      input.recipientIgsid,
      input.status,
      input.errorCode ?? null,
      input.errorMessage ?? null,
    )
    .run();
}

export async function getBroadcastDeliveries(
  db: D1Database,
  broadcastId: number | string,
  opts: { status?: BroadcastDeliveryStatus; limit?: number } = {},
): Promise<BroadcastDelivery[]> {
  const conditions = ['bd.broadcast_id = ?'];
  const binds: unknown[] = [broadcastId];
  if (opts.status) {
    conditions.push('bd.status = ?');
    binds.push(opts.status);
  }
  binds.push(Math.min(Math.max(opts.limit ?? 200, 1), 500));
  const result = await db
    .prepare(
      `SELECT bd.*, f.username, f.name AS display_name
       FROM broadcast_deliveries bd
       LEFT JOIN followers f ON f.id = bd.follower_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY bd.attempted_at DESC, bd.id DESC
       LIMIT ?`,
    )
    .bind(...binds)
    .all<BroadcastDelivery>();
  return result.results;
}
