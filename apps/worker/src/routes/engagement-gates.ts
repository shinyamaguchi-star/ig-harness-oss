import { Hono } from 'hono';
import type { Env } from '../index.js';
import {
  createEngagementGate,
  listEngagementGates,
  getEngagementGate,
  updateEngagementGate,
  deleteEngagementGate,
  listGateDeliveries,
  getGateAnalytics,
  getRichMessage,
  hasCheckFollowPostback,
  setGateTargetPosts,
  getMediaPostById,
  listMediaPosts,
  getMediaPostsByCampaignGateId,
  replaceScheduledCampaignMediaPosts,
  attachCampaignToMediaPost,
  parseGateTriggerKeywords,
  upsertFriend,
  type EngagementGate,
} from '@ig-harness/db';
import { getAccountClient, resolveAccount, toIgAccountRef } from '../lib/accounts.js';
import { copyEngagementGate } from '../services/campaign-copy.js';
import { triggerGateForComment } from '../services/engagement-gate.js';

const engagementGates = new Hono<Env>();

const MAX_COMMENT_TRIGGER_KEYWORDS = 10;
const MAX_COMMENT_TRIGGER_KEYWORD_LENGTH = 100;

export function normalizeCommentTriggerKeywords(
  input: unknown,
  legacyKeyword?: unknown,
): { keywords: string[]; error: string | null } {
  const source = input === undefined
    ? typeof legacyKeyword === 'string' && legacyKeyword.trim()
      ? [legacyKeyword]
      : []
    : input === null
      ? []
      : input;
  if (!Array.isArray(source)) {
    return { keywords: [], error: 'trigger_keywords must be an array of strings' };
  }
  if (source.length > MAX_COMMENT_TRIGGER_KEYWORDS) {
    return {
      keywords: [],
      error: `trigger_keywords supports up to ${MAX_COMMENT_TRIGGER_KEYWORDS} items`,
    };
  }

  const keywords: string[] = [];
  const seen = new Set<string>();
  for (const value of source) {
    if (typeof value !== 'string') {
      return { keywords: [], error: 'trigger_keywords must contain only strings' };
    }
    const keyword = value.trim();
    if (!keyword) continue;
    if (keyword.length > MAX_COMMENT_TRIGGER_KEYWORD_LENGTH) {
      return {
        keywords: [],
        error: `each trigger keyword must be ${MAX_COMMENT_TRIGGER_KEYWORD_LENGTH} characters or fewer`,
      };
    }
    const dedupeKey = keyword.toLocaleLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    keywords.push(keyword);
  }
  return { keywords, error: null };
}

function gateResponse(gate: EngagementGate) {
  return {
    ...gate,
    trigger_keywords:
      gate.trigger_type === 'comment_on_post' ? parseGateTriggerKeywords(gate) : [],
  };
}

/**
 * GET /click/:gateId?u=<base64url-encoded destination>[&ig=<igsid>]
 *
 * Records a click and 302s to the decoded destination.
 *
 * SECURITY: the destination's ORIGIN (protocol + host) must match one of
 * the operator-configured allowed origins:
 *   1. The gate's reward_url origin  (always checked)
 *   2. The gate's LINE connection worker_url origin (when line_connection_id is set)
 * Any other host → 400, preventing open-redirect abuse.
 */
engagementGates.get('/click/:gateId', async (c) => {
  const gateId = c.req.param('gateId');
  const uEncoded = c.req.query('u') ?? '';
  const igsid = c.req.query('ig') ?? null;
  const ua = c.req.header('User-Agent') ?? null;
  const referer = c.req.header('Referer') ?? null;

  let destination = '';
  try {
    destination = decodeBase64Url(uEncoded);
  } catch {
    return c.text('Invalid destination', 400);
  }
  if (!destination || !/^https?:\/\//.test(destination)) {
    return c.text('Invalid destination', 400);
  }

  // Load gate to validate the destination origin.
  const gate = await getEngagementGate(c.env.DB, gateId);
  if (!gate) {
    return c.text('Invalid destination', 400);
  }

  let destOrigin: string;
  try {
    destOrigin = new URL(destination).origin;
  } catch {
    return c.text('Invalid destination', 400);
  }

  // Build the set of allowed origins from operator-configured values.
  const allowedOrigins = new Set<string>();
  if (gate.reward_url) {
    try { allowedOrigins.add(new URL(gate.reward_url).origin); } catch { /* ignore malformed */ }
  }
  if (gate.line_connection_id) {
    try {
      const conn = await c.env.DB
        .prepare('SELECT worker_url FROM line_harness_connections WHERE id = ?')
        .bind(gate.line_connection_id)
        .first<{ worker_url: string }>();
      if (conn?.worker_url) {
        allowedOrigins.add(new URL(conn.worker_url).origin);
      }
    } catch { /* ignore DB/parse errors */ }
  }

  if (!allowedOrigins.has(destOrigin)) {
    console.warn(`[gate-click] blocked redirect to disallowed origin: ${destOrigin}`);
    return c.text('Invalid destination', 400);
  }

  const id = crypto.randomUUID();
  c.executionCtx.waitUntil(
    (async () => {
      try {
        await c.env.DB
          .prepare(
            `INSERT INTO gate_clicks (id, gate_id, igsid, destination_url, user_agent, referer)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(id, gateId, igsid, destination, ua, referer)
          .run();
      } catch (err) {
        console.error('[gate-click] insert failed:', err);
      }
    })(),
  );

  return c.redirect(destination, 302);
});

/**
 * base64url decode (no padding, - _ instead of + /). Worker's atob only
 * handles standard base64, so we normalize first.
 */
function decodeBase64Url(input: string): string {
  let b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) b64 += '=';
  return decodeURIComponent(
    atob(b64)
      .split('')
      .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
      .join(''),
  );
}

engagementGates.get('/api/engagement-gates', async (c) => {
  const account = await resolveAccount(c);
  if (!account) return c.json({ success: false, error: 'account not found' }, 404);
  const gates = await listEngagementGates(c.env.DB, { accountId: account.id });
  return c.json({ success: true, data: gates.map(gateResponse) });
});

/**
 * GET /api/engagement-gates/post-coverage
 *
 * Returns a map of { post_id: [{gate_id, gate_name, status}, ...] } so the
 * wizard's media picker can surface "N キャンペーン適用中" badges and stop
 * operators from accidentally double-binding the same post.
 */
engagementGates.get('/api/engagement-gates/post-coverage', async (c) => {
  const rows = await c.env.DB
    .prepare(
      `SELECT gtp.post_id, g.id AS gate_id, g.name AS gate_name, g.status AS gate_status
       FROM gate_target_posts gtp
       JOIN engagement_gates g ON g.id = gtp.gate_id
       WHERE g.status != 'archived'`,
    )
    .all<{ post_id: string; gate_id: string; gate_name: string; gate_status: string }>();

  const map: Record<string, Array<{ gate_id: string; gate_name: string; status: string }>> = {};
  for (const r of rows.results) {
    const arr = map[r.post_id] ?? [];
    arr.push({ gate_id: r.gate_id, gate_name: r.gate_name, status: r.gate_status });
    map[r.post_id] = arr;
  }
  return c.json({ success: true, data: map });
});

engagementGates.post('/api/engagement-gates', async (c) => {
  const account = await resolveAccount(c);
  if (!account) return c.json({ success: false, error: 'account not found' }, 404);
  const body = await c.req.json<{
    name: string;
    status?: 'active' | 'paused' | 'archived';
    trigger_type: 'comment_on_post' | 'dm_keyword' | 'story_mention';
    target_post_id?: string | null;
    trigger_keyword?: string | null;
    trigger_keywords?: string[] | null;
    require_follow?: number;
    initial_dm_text?: string;
    initial_dm_button_label?: string;
    follow_reminder_dm_text?: string;
    follow_reminder_button_label?: string;
    reward_dm_text?: string;
    reward_url?: string | null;
    max_loops?: number;
    initial_dm_rich_message_id?: string | null;
    reward_dm_rich_message_id?: string | null;
    follow_reminder_dm_rich_message_id?: string | null;
    comment_reply_text?: string | null;
    followup_dm_sequence?: string | null;
    /** When 1, every matching trigger creates a new delivery and the
     *  service skips the idempotent early-return so the same follower
     *  can run the CTA flow repeatedly (demo/nurture campaigns).
     *  Default 0 (legacy idempotent: 1 follower × 1 gate = 1 delivery). */
    allow_repeat?: number;
    /** LINE Harness cross-link binding. When both are set, reward / CTA
     *  DMs rewrite outbound URLs through a LINE Harness tracked link so
     *  first-click captures the IG↔LINE userId pair. */
    line_connection_id?: string | null;
    line_pool_slug?: string | null;
    /** New preferred way: N target posts. Empty = all posts. Takes precedence
     *  over legacy target_post_id when present. */
    target_post_ids?: string[];
    /** Local scheduled post id. The gate stays paused until that post is
     * published and receives a real Instagram media id. */
    scheduled_media_post_id?: string;
  }>();

  if (!body.name || !body.trigger_type) {
    return c.json({ success: false, error: 'missing required fields: name, trigger_type' }, 400);
  }

  if (body.trigger_type !== 'comment_on_post' && body.trigger_keywords !== undefined) {
    return c.json(
      { success: false, error: 'trigger_keywords is only supported for comment campaigns' },
      400,
    );
  }
  const normalizedKeywords = normalizeCommentTriggerKeywords(
    body.trigger_type === 'comment_on_post' ? body.trigger_keywords : undefined,
    body.trigger_type === 'comment_on_post' ? body.trigger_keyword : undefined,
  );
  if (normalizedKeywords.error) {
    return c.json({ success: false, error: normalizedKeywords.error }, 400);
  }

  let scheduledPost = null;
  if (body.scheduled_media_post_id) {
    scheduledPost = await getMediaPostById(c.env.DB, body.scheduled_media_post_id);
    if (!scheduledPost || scheduledPost.account_id !== account.id) {
      return c.json({ success: false, error: 'scheduled media post not found for this account' }, 404);
    }
    if (body.trigger_type !== 'comment_on_post') {
      return c.json({ success: false, error: 'scheduled media posts only support comment campaigns' }, 400);
    }
    if (scheduledPost.post_type === 'story') {
      return c.json({ success: false, error: 'story posts cannot use a comment campaign' }, 400);
    }
    if (scheduledPost.campaign_gate_id) {
      return c.json({ success: false, error: 'this scheduled post already has a campaign' }, 409);
    }
    if (scheduledPost.status === 'failed' || scheduledPost.status === 'canceled') {
      return c.json(
        { success: false, error: `cannot attach a campaign to a ${scheduledPost.status} post` },
        409,
      );
    }
    if (scheduledPost.status === 'published' && !scheduledPost.published_media_id) {
      return c.json(
        { success: false, error: 'published post is missing its Instagram media id' },
        409,
      );
    }
  }

  // Legacy text fields are only required when the corresponding rich-message
  // slot is NOT provided. Missing legacy text + missing rich_message_id =
  // invalid configuration.
  const initialOk = !!body.initial_dm_text || !!body.initial_dm_rich_message_id;
  const reminderOk = !!body.follow_reminder_dm_text || !!body.follow_reminder_dm_rich_message_id;
  const rewardOk = !!body.reward_dm_text || !!body.reward_dm_rich_message_id;
  if (!initialOk || !reminderOk || !rewardOk) {
    return c.json(
      { success: false, error: 'each DM slot needs either legacy *_dm_text or *_rich_message_id' },
      400,
    );
  }

  // Fail fast on typo'd references — the legacy *_dm_text columns default
  // to '' when a rich_message_id is set, so a missing row would otherwise
  // cause silent empty-DM delivery at runtime.
  const requireFollow = body.require_follow ?? 1;
  // CTA (initial) always needs CHECK_FOLLOW postback — it's the only path
  // that advances to reward delivery, regardless of require_follow.
  // Reminder needs CHECK_FOLLOW only when require_follow=1 (it only runs in
  // that flow).
  for (const [field, id, enforceCheckFollow] of [
    ['initial_dm_rich_message_id', body.initial_dm_rich_message_id, true],
    ['reward_dm_rich_message_id', body.reward_dm_rich_message_id, false],
    ['follow_reminder_dm_rich_message_id', body.follow_reminder_dm_rich_message_id, requireFollow === 1],
  ] as const) {
    if (id) {
      const rm = await getRichMessage(c.env.DB, id);
      if (!rm) return c.json({ success: false, error: `${field} not found: ${id}` }, 400);
      if (enforceCheckFollow && !hasCheckFollowPostback(rm.blocks)) {
        return c.json(
          {
            success: false,
            error: `${field} must contain a postback button with payload "CHECK_FOLLOW:{GATE_ID}:{DELIVERY_ID}" — without it, deliveries stall in cta_sent`,
          },
          400,
        );
      }
    }
  }

  // Normalize: junction array wins when provided. The legacy single-post
  // column stays in sync for back-compat (holds the first id, or null).
  const targetIds = scheduledPost?.published_media_id
    ? [scheduledPost.published_media_id]
    : scheduledPost
      ? []
      : Array.isArray(body.target_post_ids)
    ? body.target_post_ids.filter((x) => typeof x === 'string' && x.length > 0)
    : body.target_post_id
      ? [body.target_post_id]
      : [];
  const legacyTargetPostId = targetIds.length > 0 ? targetIds[0]! : null;

  const gate = await createEngagementGate(c.env.DB, {
    name: body.name,
    // Empty target ids mean "all posts" to the webhook matcher. A campaign
    // waiting for a scheduled post must therefore remain paused.
    status: scheduledPost
      ? scheduledPost.published_media_id
        ? 'active'
        : 'paused'
      : body.status ?? 'active',
    trigger_type: body.trigger_type,
    target_post_id: legacyTargetPostId,
    trigger_keyword:
      body.trigger_type === 'comment_on_post'
        ? normalizedKeywords.keywords[0] ?? null
        : body.trigger_keyword ?? null,
    trigger_keywords:
      body.trigger_type === 'comment_on_post' && normalizedKeywords.keywords.length > 0
        ? JSON.stringify(normalizedKeywords.keywords)
        : null,
    require_follow: body.require_follow ?? 1,
    initial_dm_text: body.initial_dm_text ?? '',
    initial_dm_button_label: body.initial_dm_button_label ?? '特典を受け取る',
    follow_reminder_dm_text: body.follow_reminder_dm_text ?? '',
    follow_reminder_button_label: body.follow_reminder_button_label ?? 'フォローしたよ',
    reward_dm_text: body.reward_dm_text ?? '',
    reward_url: body.reward_url ?? null,
    max_loops: body.max_loops ?? 0,
    initial_dm_rich_message_id: body.initial_dm_rich_message_id ?? null,
    reward_dm_rich_message_id: body.reward_dm_rich_message_id ?? null,
    follow_reminder_dm_rich_message_id: body.follow_reminder_dm_rich_message_id ?? null,
    comment_reply_text: body.comment_reply_text ?? null,
    followup_dm_sequence: body.followup_dm_sequence ?? null,
    line_connection_id: body.line_connection_id ?? null,
    line_pool_slug: body.line_pool_slug ?? null,
    line_tracked_link_short: null,
    allow_repeat: body.allow_repeat ?? 0,
    accountId: account.id,
  });

  // Populate the junction table with the full id list.
  await setGateTargetPosts(c.env.DB, gate.id, targetIds);
  gate.target_post_ids = targetIds;

  if (scheduledPost) {
    const activationStatus = scheduledPost.published_media_id ? 'active' : 'pending';
    const attached = await attachCampaignToMediaPost(
      c.env.DB,
      scheduledPost.id,
      gate.id,
      activationStatus,
      true,
    );
    if (!attached) {
      await deleteEngagementGate(c.env.DB, gate.id);
      return c.json({ success: false, error: 'scheduled post campaign attachment conflicted; retry' }, 409);
    }
  }

  return c.json({ success: true, data: gateResponse(gate) });
});

engagementGates.post('/api/engagement-gates/:id/duplicate', async (c) => {
  const account = await resolveAccount(c);
  if (!account) return c.json({ success: false, error: 'account not found' }, 404);

  // Use the account-scoped list instead of an unscoped id lookup so an API
  // key can never copy another connected account's campaign by guessing id.
  const accountGates = await listEngagementGates(c.env.DB, { accountId: account.id });
  const source = accountGates.find((gate) => gate.id === c.req.param('id'));
  if (!source) return c.json({ success: false, error: 'campaign not found' }, 404);

  try {
    const copied = await copyEngagementGate(c.env.DB, source, account.id);
    return c.json({ success: true, data: gateResponse(copied) }, 201);
  } catch (error) {
    console.error('[campaign-copy] failed:', error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'campaign copy failed',
      },
      500,
    );
  }
});

/** Replace the editable scheduled-post links for one comment campaign.
 * Published/processing posts are immutable history and are never detached. */
engagementGates.put('/api/engagement-gates/:id/scheduled-posts', async (c) => {
  const account = await resolveAccount(c);
  if (!account) return c.json({ success: false, error: 'account not found' }, 404);
  const gate = await getEngagementGate(c.env.DB, c.req.param('id'));
  if (!gate || gate.account_id !== account.id) {
    return c.json({ success: false, error: 'campaign not found' }, 404);
  }
  if (gate.trigger_type !== 'comment_on_post') {
    return c.json({ success: false, error: 'only comment campaigns can link scheduled posts' }, 400);
  }
  if (gate.status === 'archived') {
    return c.json({ success: false, error: 'archived campaigns cannot be changed' }, 409);
  }
  if (gate.status === 'active' && (gate.target_post_ids?.length ?? 0) === 0) {
    return c.json(
      { success: false, error: 'all-post default campaigns do not need individual post links' },
      409,
    );
  }

  let body: { post_ids?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'invalid JSON body' }, 400);
  }
  if (!Array.isArray(body.post_ids) || body.post_ids.some((id) => typeof id !== 'string')) {
    return c.json({ success: false, error: 'post_ids must be an array of strings' }, 400);
  }
  const postIds = [...new Set(body.post_ids as string[])];
  if (postIds.length > 100) {
    return c.json({ success: false, error: 'up to 100 scheduled posts can be linked at once' }, 400);
  }

  const scheduled = await listMediaPosts(c.env.DB, {
    accountId: account.id,
    status: 'scheduled',
    limit: 200,
  });
  const byId = new Map(scheduled.map((post) => [post.id, post]));
  for (const postId of postIds) {
    const post = byId.get(postId);
    if (!post) return c.json({ success: false, error: `scheduled post not found: ${postId}` }, 404);
    if (post.post_type === 'story') {
      return c.json({ success: false, error: 'story posts cannot use a comment campaign' }, 400);
    }
    if (post.campaign_gate_id && post.campaign_gate_id !== gate.id) {
      return c.json({ success: false, error: 'a selected post belongs to another campaign' }, 409);
    }
  }

  const replaced = await replaceScheduledCampaignMediaPosts(c.env.DB, {
    accountId: account.id,
    gateId: gate.id,
    postIds,
  });
  if (!replaced) {
    return c.json(
      { success: false, error: 'a post changed or started processing; reload and try again' },
      409,
    );
  }
  return c.json({ success: true, data: { post_ids: postIds } });
});

engagementGates.get('/api/engagement-gates/:id', async (c) => {
  const id = c.req.param('id');
  const gate = await getEngagementGate(c.env.DB, id);
  if (!gate) return c.json({ success: false, error: 'not found' }, 404);
  const analytics = await getGateAnalytics(c.env.DB, id);
  return c.json({ success: true, data: { ...gateResponse(gate), analytics } });
});

engagementGates.patch('/api/engagement-gates/:id', async (c) => {
  const id = c.req.param('id');
  const patch = await c.req.json<Record<string, unknown>>();

  const existing = await getEngagementGate(c.env.DB, id);
  if (!existing) return c.json({ success: false, error: 'not found' }, 404);

  const nextTriggerType =
    typeof patch.trigger_type === 'string' ? patch.trigger_type : existing.trigger_type;
  if ('trigger_keywords' in patch) {
    if (nextTriggerType !== 'comment_on_post') {
      return c.json(
        { success: false, error: 'trigger_keywords is only supported for comment campaigns' },
        400,
      );
    }
    const normalized = normalizeCommentTriggerKeywords(patch.trigger_keywords);
    if (normalized.error) return c.json({ success: false, error: normalized.error }, 400);
    patch.trigger_keywords =
      normalized.keywords.length > 0 ? JSON.stringify(normalized.keywords) : null;
    patch.trigger_keyword = normalized.keywords[0] ?? null;
  } else if ('trigger_keyword' in patch && nextTriggerType === 'comment_on_post') {
    const normalized = normalizeCommentTriggerKeywords(undefined, patch.trigger_keyword);
    if (normalized.error) return c.json({ success: false, error: normalized.error }, 400);
    patch.trigger_keywords =
      normalized.keywords.length > 0 ? JSON.stringify(normalized.keywords) : null;
    patch.trigger_keyword = normalized.keywords[0] ?? null;
  } else if (nextTriggerType !== 'comment_on_post' && existing.trigger_type === 'comment_on_post') {
    patch.trigger_keywords = null;
    if (nextTriggerType === 'story_mention') patch.trigger_keyword = null;
  }

  // Until Instagram supplies a real media id, activating this gate would
  // make its empty target list apply to every post. Block that unsafe state.
  if (patch.status === 'active') {
    const linkedPosts = await getMediaPostsByCampaignGateId(c.env.DB, id, 'scheduled');
    if ((existing.target_post_ids?.length ?? 0) === 0 && linkedPosts.length > 0) {
      return c.json(
        { success: false, error: 'このキャンペーンは予約投稿の公開後に自動で有効になります' },
        409,
      );
    }
  }

  // Invalidate the cached tracked-link id when any of the three fields
  // that bake into the tracked link change: connection, pool, or reward_url.
  // Without this, edits would keep routing clicks through a stale LINE
  // Harness tracked link whose originalUrl no longer matches the operator's
  // intent (wrong pool attribution or wrong redirect target).
  const nextConn = 'line_connection_id' in patch ? patch.line_connection_id : existing.line_connection_id;
  const nextPool = 'line_pool_slug' in patch ? patch.line_pool_slug : existing.line_pool_slug;
  const nextUrl = 'reward_url' in patch ? patch.reward_url : existing.reward_url;
  const invalidate =
    nextConn !== existing.line_connection_id ||
    nextPool !== existing.line_pool_slug ||
    nextUrl !== existing.reward_url;
  if (invalidate) {
    patch.line_tracked_link_short = null;
  }

  // Apply target_post_ids update if present. Strip it from `patch` before
  // passing to updateEngagementGate so the column whitelist doesn't reject.
  if (Array.isArray(patch.target_post_ids)) {
    const ids = (patch.target_post_ids as unknown[]).filter(
      (x): x is string => typeof x === 'string' && x.length > 0,
    );
    await setGateTargetPosts(c.env.DB, id, ids);
    // Keep legacy column in sync
    patch.target_post_id = ids.length > 0 ? ids[0] : null;
    delete patch.target_post_ids;
  }

  // Simulate the merged row so we can validate the effective post-patch
  // configuration the same way POST validates a fresh gate.
  const pick = <K extends keyof typeof existing>(key: K): typeof existing[K] =>
    key in patch ? (patch[key as string] as typeof existing[K]) : existing[key];
  const merged = {
    require_follow: pick('require_follow'),
    initial_dm_text: pick('initial_dm_text'),
    follow_reminder_dm_text: pick('follow_reminder_dm_text'),
    reward_dm_text: pick('reward_dm_text'),
    initial_dm_rich_message_id: pick('initial_dm_rich_message_id'),
    reward_dm_rich_message_id: pick('reward_dm_rich_message_id'),
    follow_reminder_dm_rich_message_id: pick('follow_reminder_dm_rich_message_id'),
  };

  const initialOk = !!merged.initial_dm_text || !!merged.initial_dm_rich_message_id;
  const reminderOk = !!merged.follow_reminder_dm_text || !!merged.follow_reminder_dm_rich_message_id;
  const rewardOk = !!merged.reward_dm_text || !!merged.reward_dm_rich_message_id;
  if (!initialOk || !reminderOk || !rewardOk) {
    return c.json(
      { success: false, error: 'merged gate has a DM slot with neither legacy *_dm_text nor *_rich_message_id' },
      400,
    );
  }

  // Validate each rich-message reference that ends up on the merged row.
  for (const [field, enforceCheckFollow] of [
    ['initial_dm_rich_message_id', true],
    ['reward_dm_rich_message_id', false],
    ['follow_reminder_dm_rich_message_id', merged.require_follow === 1],
  ] as const) {
    const value = merged[field];
    if (typeof value === 'string' && value.length > 0) {
      const rm = await getRichMessage(c.env.DB, value);
      if (!rm) return c.json({ success: false, error: `${field} not found: ${value}` }, 400);
      if (enforceCheckFollow && !hasCheckFollowPostback(rm.blocks)) {
        return c.json(
          {
            success: false,
            error: `${field} must contain a postback button with payload "CHECK_FOLLOW:{GATE_ID}:{DELIVERY_ID}"`,
          },
          400,
        );
      }
    }
  }

  await updateEngagementGate(c.env.DB, id, patch);
  const gate = await getEngagementGate(c.env.DB, id);
  return c.json({ success: true, data: gate ? gateResponse(gate) : null });
});

engagementGates.delete('/api/engagement-gates/:id', async (c) => {
  const id = c.req.param('id');
  await deleteEngagementGate(c.env.DB, id);
  return c.json({ success: true });
});

engagementGates.get('/api/engagement-gates/:id/deliveries', async (c) => {
  const id = c.req.param('id');
  const deliveries = await listGateDeliveries(c.env.DB, id);
  return c.json({ success: true, data: deliveries });
});

/**
 * Replay one historical Instagram comment through one explicitly selected
 * campaign. This is intentionally one-comment-per-request so an operator can
 * pace a backfill, stop safely, and resume without duplicating successful DMs.
 */
engagementGates.post('/api/engagement-gates/:id/backfill-comment', async (c) => {
  const gateId = c.req.param('id');
  const account = await resolveAccount(c);
  if (!account) return c.json({ success: false, error: 'account not found' }, 404);

  const gate = await getEngagementGate(c.env.DB, gateId);
  if (!gate || gate.account_id !== account.id) {
    return c.json({ success: false, error: 'campaign not found for this account' }, 404);
  }
  if (gate.status !== 'active' || gate.trigger_type !== 'comment_on_post') {
    return c.json({ success: false, error: 'campaign must be an active comment campaign' }, 409);
  }

  const body = await c.req.json<{
    post_id?: string;
    comment_id?: string;
    include_thread_reply?: boolean;
  }>();
  if (!body.post_id || !body.comment_id) {
    return c.json({ success: false, error: 'post_id and comment_id required' }, 400);
  }
  const targets = gate.target_post_ids?.length
    ? gate.target_post_ids
    : gate.target_post_id
      ? [gate.target_post_id]
      : [];
  if (targets.length > 0 && !targets.includes(body.post_id)) {
    return c.json({ success: false, error: 'post is not targeted by this campaign' }, 409);
  }

  const igClient = await getAccountClient(c.env, c.env.DB, account);
  // The individual-comment endpoint inconsistently omits the scoped author
  // id for some Instagram Login tokens. The media comments edge supplies it,
  // so validate the requested comment against that canonical list instead.
  const comment = (await igClient.getMediaComments(body.post_id, 100)).find(
    (candidate) => candidate.id === body.comment_id,
  );
  if (!comment) {
    return c.json({ success: false, error: 'comment was not found on the selected post' }, 404);
  }
  if (!comment.from_id || comment.from_id === account.ig_user_id) {
    return c.json({ success: false, error: 'comment has no eligible external author' }, 409);
  }
  const createdAt = Date.parse(comment.timestamp);
  if (!Number.isFinite(createdAt) || Date.now() - createdAt > 7 * 24 * 60 * 60 * 1000) {
    return c.json({ success: false, error: 'comment is outside the 7-day reply window' }, 409);
  }

  const follower = await upsertFriend(c.env.DB, {
    igsid: comment.from_id,
    username: comment.username || null,
    accountId: account.id,
  });
  const before = (await listGateDeliveries(c.env.DB, gateId)).find(
    (d) => d.follower_id === follower.id && d.trigger_post_id === body.post_id,
  );
  if (before && before.status !== 'triggered') {
    return c.json({
      success: true,
      data: { sent: false, duplicate: true, status: before.status, threaded_reply: 'skipped' },
    });
  }

  let replyError: unknown;
  const fired = await triggerGateForComment(c.env.DB, igClient, {
    postId: body.post_id,
    commentText: comment.text,
    follower: { id: follower.id, igsid: comment.from_id },
    commentId: body.include_thread_reply === false ? undefined : comment.id,
    commenterUsername: comment.username,
    workerBaseUrl: c.env.WORKER_URL,
    igAccount: toIgAccountRef(account),
    accountId: account.id,
    gateId,
    onCommentReplyResult: (error) => { replyError = error; },
  });
  if (!fired) {
    return c.json({ success: false, error: 'comment did not match the selected campaign' }, 409);
  }
  const after = (await listGateDeliveries(c.env.DB, gateId)).find(
    (d) => d.follower_id === follower.id && d.trigger_post_id === body.post_id,
  );
  return c.json({
    success: true,
    data: {
      sent: !before,
      duplicate: false,
      status: after?.status ?? 'unknown',
      threaded_reply:
        body.include_thread_reply === false ? 'skipped' : replyError ? 'failed' : 'sent',
      threaded_reply_error: replyError ? String(replyError) : null,
    },
  });
});

export { engagementGates };
