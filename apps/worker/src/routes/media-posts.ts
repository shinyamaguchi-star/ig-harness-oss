import { Hono } from 'hono';
import {
  createMediaPost,
  listMediaPosts,
  getMediaPostById,
  cancelMediaPost,
  updateMediaPost,
  updateScheduledMediaPost,
  jstNow,
  toJstString,
  getIgAccountById,
  getEngagementGate,
  type EngagementGate,
  type MediaPost,
  type MediaPostMediaItem,
  type MediaPostStatus,
  type MediaPostType,
} from '@ig-harness/db';
import { resolveAccount, getAccountClient } from '../lib/accounts.js';
import { kickImmediate } from '../services/media-publish.js';
import type { Env } from '../index.js';

const POST_TYPES: MediaPostType[] = ['feed_image', 'carousel', 'reel', 'story'];
const STATUSES: MediaPostStatus[] = ['scheduled', 'processing', 'published', 'failed', 'canceled'];
const MAX_STORY_ITEMS = 20;
const MAX_POST_TITLE_LENGTH = 100;

function serializeMediaPost(row: MediaPost) {
  let media: MediaPostMediaItem[] = [];
  try {
    media = JSON.parse(row.media) as MediaPostMediaItem[];
  } catch {
    // leave empty on corrupt rows rather than 500ing the whole list
  }
  return {
    id: row.id,
    accountId: row.account_id,
    title: row.title ?? null,
    postType: row.post_type,
    media,
    caption: row.caption,
    coverUrl: row.cover_url,
    thumbOffsetMs: row.thumb_offset_ms,
    status: row.status,
    scheduledAt: row.scheduled_at,
    creationId: row.creation_id,
    publishedMediaId: row.published_media_id,
    attemptCount: row.attempt_count,
    lastAttemptAt: row.last_attempt_at,
    nextRetryAt: row.next_retry_at,
    error: row.error,
    campaignGateId: row.campaign_gate_id,
    campaignActivationStatus: row.campaign_activation_status,
    campaignError: row.campaign_error,
    campaignAutoActivate: row.campaign_auto_activate === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Validate the operator-only post label. It is stored for the Admin UI and
 * is never included in an Instagram API request. */
export function validatePostTitle(title: unknown): string | null {
  if (title === undefined || title === null) return null;
  if (typeof title !== 'string') return 'title must be a string';
  if (title.trim().length > MAX_POST_TITLE_LENGTH) {
    return `title must be ${MAX_POST_TITLE_LENGTH} characters or fewer`;
  }
  return null;
}

/**
 * post_type × media integrity. Returns an error message or null when valid.
 * Exported for unit tests.
 */
export function validateMediaPostInput(
  postType: MediaPostType,
  media: MediaPostMediaItem[],
): string | null {
  if (!POST_TYPES.includes(postType)) {
    return `invalid post_type: must be one of ${POST_TYPES.join(', ')}`;
  }
  if (!Array.isArray(media) || media.length === 0) {
    return 'media is required (array of {url, type})';
  }
  for (const item of media) {
    if (!item || typeof item.url !== 'string' || !/^https?:\/\//.test(item.url)) {
      return 'each media item needs a public http(s) URL';
    }
    if (item.type !== 'image' && item.type !== 'video') {
      return "each media item type must be 'image' or 'video'";
    }
  }
  switch (postType) {
    case 'feed_image':
      if (media.length !== 1) return 'feed_image requires exactly 1 media item';
      if (media[0].type !== 'image') return 'feed_image requires an image';
      return null;
    case 'reel':
      if (media.length !== 1) return 'reel requires exactly 1 media item';
      if (media[0].type !== 'video') return 'reel requires a video';
      return null;
    case 'story':
      if (media.length > MAX_STORY_ITEMS) {
        return `story requires 1 to ${MAX_STORY_ITEMS} media items`;
      }
      return null;
    case 'carousel':
      if (media.length < 2 || media.length > 10) {
        return 'carousel requires 2 to 10 media items';
      }
      return null;
  }
}

/** Validate Reel-only cover inputs independently so the route and tests use
 * the exact same rules. A custom image wins when both values are supplied. */
export function validateReelCoverInput(
  postType: MediaPostType,
  coverUrl: unknown,
  thumbOffsetMs: unknown,
): string | null {
  const hasCover = coverUrl !== undefined && coverUrl !== null && coverUrl !== '';
  const hasOffset = thumbOffsetMs !== undefined && thumbOffsetMs !== null;
  if ((hasCover || hasOffset) && postType !== 'reel') {
    return 'cover_url and thumb_offset_ms are only supported for reel posts';
  }
  if (hasCover && (typeof coverUrl !== 'string' || !/^https:\/\//.test(coverUrl))) {
    return 'cover_url must be a public https URL';
  }
  if (
    hasOffset &&
    (typeof thumbOffsetMs !== 'number' ||
      !Number.isInteger(thumbOffsetMs) ||
      !Number.isSafeInteger(thumbOffsetMs) ||
      thumbOffsetMs < 0)
  ) {
    return 'thumb_offset_ms must be a non-negative safe integer';
  }
  return null;
}

/**
 * Normalize a client-supplied scheduled_at to a JST (+09:00) string.
 * Offset-less strings (e.g. "2026-07-24T09:00" from datetime-local) are
 * interpreted as JST — this project standardizes on JST everywhere.
 * Returns null for unparseable input.
 */
export function normalizeScheduledAt(input: string): string | null {
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/.test(input);
  const candidate = hasOffset ? input : `${input}+09:00`;
  const date = new Date(candidate);
  if (Number.isNaN(date.getTime())) return null;
  return toJstString(date);
}

const mediaPosts = new Hono<Env>();

async function validateCampaignForScheduledPost(
  db: D1Database,
  accountId: string,
  gateId: string,
  postType: MediaPostType,
): Promise<{ gate: EngagementGate | null; error: string | null }> {
  const gate = await getEngagementGate(db, gateId);
  if (!gate || gate.account_id !== accountId) {
    return { gate: null, error: 'campaign not found for this account' };
  }
  if (gate.status === 'archived') {
    return { gate: null, error: 'archived campaigns cannot be linked' };
  }
  if (gate.trigger_type !== 'comment_on_post') {
    return { gate: null, error: 'only comment campaigns can be linked to scheduled posts' };
  }
  if (postType === 'story') {
    return { gate: null, error: 'story posts cannot use a comment campaign' };
  }
  // An active campaign with no targets is intentionally an all-post default.
  // Attaching one reservation would silently narrow it after publish.
  if (gate.status === 'active' && (gate.target_post_ids?.length ?? 0) === 0) {
    return { gate: null, error: 'all-post default campaigns do not need an individual post link' };
  }
  return { gate, error: null };
}

// NOTE: register before /:id so "publishing-limit" is not captured as an id.
mediaPosts.get('/api/media-posts/publishing-limit', async (c) => {
  const account = await resolveAccount(c);
  if (!account) return c.json({ success: false, error: 'account not found' }, 404);
  try {
    const igClient = await getAccountClient(c.env, c.env.DB, account);
    const limit = await igClient.getPublishingLimit();
    return c.json({
      success: true,
      data: {
        quotaUsage: limit.quota_usage,
        quotaTotal: limit.config?.quota_total ?? 100,
      },
    });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

mediaPosts.post('/api/media-posts', async (c) => {
  const account = await resolveAccount(c);
  if (!account) return c.json({ success: false, error: 'account not found' }, 404);
  let body: {
    title?: string | null;
    post_type?: MediaPostType;
    media?: MediaPostMediaItem[];
    caption?: string;
    cover_url?: string | null;
    thumb_offset_ms?: number | null;
    scheduled_at?: string;
    campaign_gate_id?: string | null;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'invalid JSON body' }, 400);
  }
  const validationError = validateMediaPostInput(body.post_type as MediaPostType, body.media ?? []);
  if (validationError) return c.json({ success: false, error: validationError }, 400);
  const titleValidationError = validatePostTitle(body.title);
  if (titleValidationError) return c.json({ success: false, error: titleValidationError }, 400);
  const coverValidationError = validateReelCoverInput(
    body.post_type as MediaPostType,
    body.cover_url,
    body.thumb_offset_ms,
  );
  if (coverValidationError) return c.json({ success: false, error: coverValidationError }, 400);
  let normalizedScheduledAt: string | null = null;
  if (body.scheduled_at) {
    normalizedScheduledAt = normalizeScheduledAt(body.scheduled_at);
    if (!normalizedScheduledAt) {
      return c.json({ success: false, error: 'scheduled_at must be an ISO 8601 datetime' }, 400);
    }
  }

  const immediate = !body.scheduled_at;
  if (immediate && body.campaign_gate_id) {
    return c.json({ success: false, error: 'campaigns can only be linked to scheduled posts' }, 400);
  }
  if (body.campaign_gate_id) {
    const checked = await validateCampaignForScheduledPost(
      c.env.DB,
      account.id,
      body.campaign_gate_id,
      body.post_type as MediaPostType,
    );
    if (checked.error) return c.json({ success: false, error: checked.error }, 400);
  }
  const post = await createMediaPost(c.env.DB, {
    accountId: account.id,
    title: body.title?.trim() || null,
    postType: body.post_type as MediaPostType,
    media: body.media as MediaPostMediaItem[],
    caption: body.caption ?? null,
    coverUrl: body.cover_url ?? null,
    thumbOffsetMs: body.cover_url ? null : body.thumb_offset_ms ?? null,
    // Normalize to JST (+09:00) — due-check is a SQL string compare, so a
    // client-sent "Z" timestamp must not be stored as-is (see Task 1 note).
    scheduledAt: normalizedScheduledAt ?? jstNow(),
    campaignGateId: body.campaign_gate_id ?? null,
    // Existing and newly-created campaigns use the same safe lifecycle:
    // remain paused while the Instagram post has no real media id, then
    // activate only after publication succeeds and the target id is added.
    campaignAutoActivate: Boolean(body.campaign_gate_id),
  });

  if (immediate) {
    const igClient = await getAccountClient(c.env, c.env.DB, account);
    c.executionCtx.waitUntil(
      kickImmediate(c.env.DB, igClient, post.id).catch((err) =>
        console.error('[media-posts] kickImmediate failed:', err),
      ),
    );
  }
  return c.json({ success: true, data: serializeMediaPost(post) }, 201);
});

mediaPosts.get('/api/media-posts', async (c) => {
  const account = await resolveAccount(c);
  if (!account) return c.json({ success: false, error: 'account not found' }, 404);
  const statusParam = c.req.query('status') as MediaPostStatus | undefined;
  if (statusParam && !STATUSES.includes(statusParam)) {
    return c.json({ success: false, error: `invalid status: ${statusParam}` }, 400);
  }
  const limit = Number(c.req.query('limit') ?? '50');
  const items = await listMediaPosts(c.env.DB, {
    accountId: account.id,
    status: statusParam,
    limit,
  });
  return c.json({ success: true, data: items.map(serializeMediaPost) });
});

mediaPosts.get('/api/media-posts/:id', async (c) => {
  const account = await resolveAccount(c);
  if (!account) return c.json({ success: false, error: 'account not found' }, 404);
  const post = await getMediaPostById(c.env.DB, c.req.param('id'));
  if (!post || post.account_id !== account.id) {
    return c.json({ success: false, error: 'not found' }, 404);
  }
  return c.json({ success: true, data: serializeMediaPost(post) });
});

mediaPosts.patch('/api/media-posts/:id', async (c) => {
  const account = await resolveAccount(c);
  if (!account) return c.json({ success: false, error: 'account not found' }, 404);
  const post = await getMediaPostById(c.env.DB, c.req.param('id'));
  if (!post || post.account_id !== account.id) {
    return c.json({ success: false, error: 'not found' }, 404);
  }
  if (post.status !== 'scheduled') {
    return c.json({ success: false, error: 'only scheduled posts can be edited' }, 409);
  }

  let body: {
    title?: string | null;
    post_type?: MediaPostType;
    media?: MediaPostMediaItem[];
    caption?: string | null;
    cover_url?: string | null;
    thumb_offset_ms?: number | null;
    scheduled_at?: string;
    campaign_gate_id?: string | null;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'invalid JSON body' }, 400);
  }

  const titleValidationError = validatePostTitle(body.title);
  if (titleValidationError) return c.json({ success: false, error: titleValidationError }, 400);

  let currentMedia: MediaPostMediaItem[] = [];
  try {
    currentMedia = JSON.parse(post.media) as MediaPostMediaItem[];
  } catch {
    return c.json({ success: false, error: 'stored media is invalid' }, 500);
  }
  const nextType = body.post_type ?? post.post_type;
  const nextMedia = body.media ?? currentMedia;
  const nextCover = body.cover_url !== undefined ? body.cover_url : post.cover_url;
  const nextOffset = body.thumb_offset_ms !== undefined ? body.thumb_offset_ms : post.thumb_offset_ms;
  const validationError = validateMediaPostInput(nextType, nextMedia);
  if (validationError) return c.json({ success: false, error: validationError }, 400);
  const coverValidationError = validateReelCoverInput(nextType, nextCover, nextOffset);
  if (coverValidationError) return c.json({ success: false, error: coverValidationError }, 400);

  let nextScheduledAt = post.scheduled_at;
  if (body.scheduled_at !== undefined) {
    const normalized = normalizeScheduledAt(body.scheduled_at);
    if (!normalized) {
      return c.json({ success: false, error: 'scheduled_at must be an ISO 8601 datetime' }, 400);
    }
    nextScheduledAt = normalized;
  }

  const campaignWasPatched = Object.prototype.hasOwnProperty.call(body, 'campaign_gate_id');
  const nextCampaignId = campaignWasPatched ? body.campaign_gate_id ?? null : post.campaign_gate_id;
  if (nextCampaignId) {
    const checked = await validateCampaignForScheduledPost(
      c.env.DB,
      account.id,
      nextCampaignId,
      nextType,
    );
    if (checked.error) return c.json({ success: false, error: checked.error }, 400);
  }

  const updated = await updateScheduledMediaPost(c.env.DB, post.id, account.id, {
    title:
      body.title !== undefined
        ? typeof body.title === 'string' && body.title.trim()
          ? body.title.trim()
          : null
        : post.title,
    post_type: nextType,
    media: JSON.stringify(nextMedia),
    caption: body.caption !== undefined ? body.caption : post.caption,
    cover_url: nextType === 'reel' ? nextCover ?? null : null,
    thumb_offset_ms: nextType === 'reel' && !nextCover ? nextOffset ?? null : null,
    scheduled_at: nextScheduledAt,
    campaign_gate_id: nextCampaignId,
    campaign_activation_status: nextCampaignId ? 'pending' : null,
    campaign_error: null,
    campaign_auto_activate: nextCampaignId ? 1 : 0,
  });
  if (!updated) {
    return c.json({ success: false, error: 'the post started processing; reload before editing' }, 409);
  }
  return c.json({ success: true, data: serializeMediaPost(updated) });
});

mediaPosts.delete('/api/media-posts/:id', async (c) => {
  const account = await resolveAccount(c);
  if (!account) return c.json({ success: false, error: 'account not found' }, 404);
  const post = await getMediaPostById(c.env.DB, c.req.param('id'));
  if (!post || post.account_id !== account.id) {
    return c.json({ success: false, error: 'not found' }, 404);
  }
  const canceled = await cancelMediaPost(c.env.DB, post.id);
  if (!canceled) {
    return c.json(
      { success: false, error: `only scheduled posts can be canceled (status=${post.status})` },
      409,
    );
  }
  // Never archive the campaign here: it may already serve other published or
  // scheduled posts. Canceling a reservation only cancels this one link.
  return c.json({ success: true, data: null });
});

mediaPosts.post('/api/media-posts/:id/publish-now', async (c) => {
  const post = await getMediaPostById(c.env.DB, c.req.param('id'));
  if (!post) return c.json({ success: false, error: 'not found' }, 404);
  if (post.status !== 'scheduled') {
    return c.json(
      { success: false, error: `only scheduled posts can be published now (status=${post.status})` },
      409,
    );
  }
  // The post's owning account must do the publishing — a client built from
  // ?account_id/default could publish this post's media through another
  // account's token when the ids diverge (see broadcasts.ts's /:id/send).
  const account = await getIgAccountById(c.env.DB, post.account_id);
  if (!account) return c.json({ success: false, error: 'account not found' }, 404);
  const updated = await updateMediaPost(c.env.DB, post.id, { scheduled_at: jstNow() });
  const igClient = await getAccountClient(c.env, c.env.DB, account);
  c.executionCtx.waitUntil(
    kickImmediate(c.env.DB, igClient, post.id).catch((err) =>
      console.error('[media-posts] publish-now kick failed:', err),
    ),
  );
  return c.json({ success: true, data: updated ? serializeMediaPost(updated) : null });
});

export { mediaPosts };
