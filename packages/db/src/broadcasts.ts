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
