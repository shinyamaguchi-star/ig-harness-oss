import { jstNow } from './utils.js';

export type MediaPostType = 'feed_image' | 'carousel' | 'reel' | 'story';
export type MediaPostStatus = 'scheduled' | 'processing' | 'published' | 'failed' | 'canceled';
export type CampaignActivationStatus = 'pending' | 'active' | 'failed' | 'canceled';

export interface MediaPostMediaItem {
  url: string;
  type: 'image' | 'video';
}

export interface MediaPost {
  id: string;
  account_id: string;
  post_type: MediaPostType;
  /** JSON-encoded MediaPostMediaItem[] */
  media: string;
  caption: string | null;
  status: MediaPostStatus;
  scheduled_at: string;
  creation_id: string | null;
  /** JSON-encoded string[] of carousel child container ids */
  child_creation_ids: string | null;
  published_media_id: string | null;
  attempt_count: number;
  error: string | null;
  /** Engagement gate prepared while this post was still unpublished. */
  campaign_gate_id: string | null;
  campaign_activation_status: CampaignActivationStatus | null;
  campaign_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateMediaPostInput {
  accountId: string;
  postType: MediaPostType;
  media: MediaPostMediaItem[];
  caption?: string | null;
  scheduledAt: string;
}

export async function createMediaPost(
  db: D1Database,
  input: CreateMediaPostInput,
): Promise<MediaPost> {
  const now = jstNow();
  const result = await db
    .prepare(
      `INSERT INTO media_posts
         (id, account_id, post_type, media, caption, status, scheduled_at,
          creation_id, child_creation_ids, published_media_id, attempt_count,
          error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'scheduled', ?, NULL, NULL, NULL, 0, NULL, ?, ?)
       RETURNING *`,
    )
    .bind(
      crypto.randomUUID(),
      input.accountId,
      input.postType,
      JSON.stringify(input.media),
      input.caption ?? null,
      input.scheduledAt,
      now,
      now,
    )
    .first<MediaPost>();
  return result!;
}

export async function getMediaPostById(
  db: D1Database,
  id: string,
): Promise<MediaPost | null> {
  return db.prepare(`SELECT * FROM media_posts WHERE id = ?`).bind(id).first<MediaPost>();
}

export async function listMediaPosts(
  db: D1Database,
  opts: { accountId?: string; status?: MediaPostStatus; limit?: number } = {},
): Promise<MediaPost[]> {
  const conditions: string[] = [];
  const binds: unknown[] = [];
  if (opts.accountId) {
    conditions.push('account_id = ?');
    binds.push(opts.accountId);
  }
  if (opts.status) {
    conditions.push('status = ?');
    binds.push(opts.status);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const requested = opts.limit ?? 50;
  const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 200) : 50;
  const stmt = db.prepare(
    `SELECT * FROM media_posts ${where} ORDER BY created_at DESC LIMIT ${limit}`,
  );
  const result = binds.length > 0
    ? await stmt.bind(...binds).all<MediaPost>()
    : await stmt.all<MediaPost>();
  return result.results;
}

export async function getDueMediaPosts(
  db: D1Database,
  accountId: string,
  now: string,
): Promise<MediaPost[]> {
  const result = await db
    .prepare(
      `SELECT * FROM media_posts
       WHERE account_id = ? AND status = 'scheduled' AND scheduled_at <= ?
       ORDER BY scheduled_at ASC`,
    )
    .bind(accountId, now)
    .all<MediaPost>();
  return result.results;
}

export async function getProcessingMediaPosts(
  db: D1Database,
  accountId: string,
): Promise<MediaPost[]> {
  const result = await db
    .prepare(
      `SELECT * FROM media_posts
       WHERE account_id = ? AND status = 'processing'
       ORDER BY scheduled_at ASC`,
    )
    .bind(accountId)
    .all<MediaPost>();
  return result.results;
}

export type UpdateMediaPostInput = Partial<
  Pick<
    MediaPost,
    | 'status'
    | 'creation_id'
    | 'child_creation_ids'
    | 'published_media_id'
    | 'attempt_count'
    | 'error'
    | 'scheduled_at'
    | 'campaign_gate_id'
    | 'campaign_activation_status'
    | 'campaign_error'
  >
>;

export async function updateMediaPost(
  db: D1Database,
  id: string,
  updates: UpdateMediaPostInput,
): Promise<MediaPost | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const key of [
    'status',
    'creation_id',
    'child_creation_ids',
    'published_media_id',
    'attempt_count',
    'error',
    'scheduled_at',
    'campaign_gate_id',
    'campaign_activation_status',
    'campaign_error',
  ] as const) {
    if (updates[key] !== undefined) {
      fields.push(`${key} = ?`);
      values.push(updates[key]);
    }
  }
  if (fields.length > 0) {
    fields.push('updated_at = ?');
    values.push(jstNow());
    values.push(id);
    await db
      .prepare(`UPDATE media_posts SET ${fields.join(', ')} WHERE id = ?`)
      .bind(...values)
      .run();
  }
  return getMediaPostById(db, id);
}

/**
 * Attach one gate to an unpublished media post. The gate itself must be
 * created paused: an active comment gate with no real IG media id would be
 * interpreted as an unsafe "all posts" campaign.
 */
export async function attachCampaignToMediaPost(
  db: D1Database,
  postId: string,
  gateId: string,
  activationStatus: CampaignActivationStatus = 'pending',
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE media_posts
       SET campaign_gate_id = ?, campaign_activation_status = ?,
           campaign_error = NULL, updated_at = ?
       WHERE id = ?
         AND campaign_gate_id IS NULL
         AND status NOT IN ('failed', 'canceled')`,
    )
    .bind(gateId, activationStatus, jstNow(), postId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function getMediaPostByCampaignGateId(
  db: D1Database,
  gateId: string,
): Promise<MediaPost | null> {
  return db
    .prepare(`SELECT * FROM media_posts WHERE campaign_gate_id = ?`)
    .bind(gateId)
    .first<MediaPost>();
}

/** Published posts whose linked campaign still needs its real IG media id. */
export async function getPendingCampaignMediaPosts(
  db: D1Database,
  accountId: string,
): Promise<MediaPost[]> {
  const result = await db
    .prepare(
      `SELECT * FROM media_posts
       WHERE account_id = ?
         AND status = 'published'
         AND published_media_id IS NOT NULL
         AND campaign_gate_id IS NOT NULL
         AND COALESCE(campaign_activation_status, 'pending') != 'active'
         AND COALESCE(campaign_activation_status, 'pending') != 'canceled'
       ORDER BY updated_at ASC`,
    )
    .bind(accountId)
    .all<MediaPost>();
  return result.results;
}

export async function cancelMediaPost(db: D1Database, id: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE media_posts
       SET status = 'canceled',
           campaign_activation_status = CASE
             WHEN campaign_gate_id IS NOT NULL THEN 'canceled'
             ELSE campaign_activation_status
           END,
           campaign_error = CASE
             WHEN campaign_gate_id IS NOT NULL THEN '予約投稿がキャンセルされました'
             ELSE campaign_error
           END,
           updated_at = ?
       WHERE id = ? AND status = 'scheduled'`,
    )
    .bind(jstNow(), id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
