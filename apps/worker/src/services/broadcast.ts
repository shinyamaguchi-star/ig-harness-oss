import {
  getBroadcastById,
  getBroadcasts,
  updateBroadcastStatus,
  initializeBroadcastQueue,
  failStaleBroadcastClaims,
  getPendingBroadcastQueue,
  claimBroadcastQueueItem,
  completeBroadcastQueueItem,
  getBroadcastQueueCounts,
  getBroadcastAttemptsToday,
  releaseBroadcastQueueItem,
  setBroadcastBackoff,
} from '@ig-harness/db';
import type { Broadcast } from '@ig-harness/db';
import type { InstagramClient, RichMessageBlock } from '@ig-harness/ig-sdk';
import { recordDmFailure } from '../lib/health.js';

// A rich-message recipient can consume multiple outbound fetches (one per
// block). Keep enough headroom under Workers' per-invocation subrequest limit
// for D1 bookkeeping and priority work that runs earlier in the same cron.
const BATCH_SIZE = 10;
const STALE_CLAIM_MS = 10 * 60 * 1000;
const PRIORITY_ACTIVITY_LOOKBACK_MS = 90 * 1000;
// Forty recipients per minute yields up to 10,000 dispatches in a little over
// four hours, while retaining headroom for the cron invocation's D1 work.
const QUEUE_DISPATCH_SIZE = 40;
// Rolling broadcasts are intentionally drip-fed one recipient per cron tick.
// The delivery window, rather than a fixed daily count, determines how many
// recipients are attempted before the remaining queue resumes the next day.
const CONTINUOUS_DISPATCH_SIZE = 1;
export interface BroadcastWorkItem {
  broadcastId: number | string;
  queueItemId: number;
  followerId: number | null;
  recipientIgsid: string;
  accountId: string;
}

interface BroadcastDeliveryWindow {
  timezone?: 'Asia/Tokyo';
  start: string;
  end: string;
  dates?: string[];
  pauseForPriorityWork?: boolean;
  highThroughput?: boolean;
}

function getDeliveryWindow(broadcast: Pick<Broadcast, 'body'>): BroadcastDeliveryWindow | null {
  try {
    const parsed = JSON.parse(broadcast.body) as { delivery_window?: unknown };
    const window = parsed.delivery_window as Partial<BroadcastDeliveryWindow> | undefined;
    if (!window || typeof window.start !== 'string' || typeof window.end !== 'string') return null;
    if (!/^\d{2}:\d{2}$/.test(window.start) || !/^\d{2}:\d{2}$/.test(window.end)) return null;
    return {
      timezone: 'Asia/Tokyo',
      start: window.start,
      end: window.end,
      dates: Array.isArray(window.dates) ? window.dates.filter((v): v is string => typeof v === 'string') : undefined,
      pauseForPriorityWork: window.pauseForPriorityWork === true,
      highThroughput: window.highThroughput === true,
    };
  } catch {
    return null;
  }
}

export function isWithinBroadcastDeliveryWindow(
  broadcast: Pick<Broadcast, 'body'>,
  date = new Date(),
): boolean {
  const window = getDeliveryWindow(broadcast);
  if (!window) return true;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  const day = `${part('year')}-${part('month')}-${part('day')}`;
  const time = `${part('hour')}:${part('minute')}`;
  if (window.dates?.length && !window.dates.includes(day)) return false;
  return time >= window.start && time < window.end;
}

async function hasRecentPriorityActivity(db: D1Database, accountId: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - PRIORITY_ACTIVITY_LOOKBACK_MS).toISOString();
  const now = new Date().toISOString();
  const row = await db
    .prepare(
      `SELECT (
         EXISTS(
           SELECT 1 FROM media_posts
           WHERE account_id = ?
             AND (
               (status = 'scheduled' AND scheduled_at <= ?)
               OR status = 'processing'
               OR (status = 'published' AND campaign_auto_activate = 1
                   AND COALESCE(campaign_activation_status, 'pending') <> 'active')
             )
         ) OR
         EXISTS(
           SELECT 1 FROM media_posts
           WHERE account_id = ? AND updated_at >= ?
             AND status IN ('scheduled', 'publishing', 'published')
         ) OR EXISTS(
           SELECT 1 FROM messages_log ml
           JOIN followers f ON f.id = ml.follower_id
           WHERE f.account_id = ? AND ml.direction = 'out'
             AND ml.trigger_source IN ('comment_rule', 'scenario')
             AND ml.created_at >= ?
         ) OR EXISTS(
           SELECT 1 FROM gate_deliveries gd
           JOIN engagement_gates g ON g.id = gd.gate_id
           WHERE g.account_id = ?
             AND COALESCE(gd.delivered_at, gd.last_check_at, gd.triggered_at) >= ?
         )
       ) AS busy`,
    )
    .bind(accountId, now, accountId, cutoff, accountId, cutoff, accountId, cutoff)
    .first<{ busy: number }>();
  return row?.busy === 1;
}

export function hasReachedBroadcastDailyLimit(
  broadcast: Pick<Broadcast, 'daily_limit' | 'sent_today'>,
): boolean {
  return broadcast.daily_limit !== null && broadcast.sent_today >= broadcast.daily_limit;
}

/** Cloudflare Cron has minute precision. With one every-minute trigger, these
 * minute slots produce alternating 2- and 3-minute gaps (average 2.5 min)
 * without consuming two cron-trigger slots per Worker. */
export function isBroadcastBatchMinute(date = new Date()): boolean {
  const minuteInFive = date.getUTCMinutes() % 5;
  return minuteInFive === 0 || minuteInFive === 2;
}

/** Do not start bulk delivery before the scheduled 19:00 posting pass. After
 * 19:00 the per-account priority check keeps waiting until that account's post
 * and campaign activation have actually completed. */
export function isPostingPriorityWindow(date = new Date()): boolean {
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
  return (time >= '18:00' && time < '19:00') ||
    (time >= '23:25' && time < '23:50');
}

export function describeBroadcastFailure(err: unknown): { code: string | null; message: string } {
  const raw = err instanceof Error ? err.message : String(err);
  const codeMatch = raw.match(/(?:"code"\s*:\s*|code[=: ]+)(\d+)/i);
  const code = codeMatch?.[1] ?? null;
  const friendly: Record<string, string> = {
    '10': '必要なInstagramメッセージ権限がありません。Metaアプリの権限とアクセストークンを確認してください。',
    '100': '送信先または送信内容をMetaが受け付けませんでした。送信先IDとメッセージ形式を確認してください。',
    '190': 'アクセストークンが無効または期限切れです。Instagramアカウントのトークンを再発行してください。',
    '200': 'Instagram APIへのアクセスが制限されています。Metaアプリの権限・公開状態・認証状態を確認してください。',
    '551': 'この相手には現在メッセージを送信できません。相手側の設定や会話状態が原因の可能性があります。',
  };
  const prefix = code ? friendly[code] : undefined;
  const sanitized = raw
    .replace(/access_token=[^&\s]+/gi, 'access_token=[REDACTED]')
    .replace(/"access_token"\s*:\s*"[^"]+"/gi, '"access_token":"[REDACTED]"')
    .slice(0, 700);
  return {
    code,
    message: prefix ? `${prefix}（Meta code ${code}）` : `送信に失敗しました: ${sanitized}`,
  };
}

export function isRetryableBroadcastFailure(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err);
  return /too many subrequests|\b429\b|\b5\d\d\b|rate.?limit|temporar|timeout|timed out|network|connection|overloaded|reset/i.test(raw);
}

/** Freeze recipients and hand a small set to Cloudflare Queues. Each claimed
 * recipient is processed in a separate consumer invocation/batch, preventing
 * one account or rich message from exhausting the cron invocation budget. */
export async function enqueueBroadcastWork(
  db: D1Database,
  queue: Queue<BroadcastWorkItem>,
  broadcastId: number | string,
  accountId: string,
): Promise<Broadcast> {
  const broadcast = await getBroadcastById(db, broadcastId);
  if (!broadcast) throw new Error(`Broadcast ${broadcastId} not found`);

  let tagId: string | undefined;
  if (broadcast.tag_filter) {
    const parsed = JSON.parse(broadcast.tag_filter) as { tagId?: string };
    if (!parsed.tagId) throw new Error('tag_filter must contain tagId');
    tagId = parsed.tagId;
  }
  const totalTarget = await initializeBroadcastQueue(db, {
    broadcastId,
    accountId: broadcast.account_id,
    tagId,
    appendNewRecipients: broadcast.auto_append_recipients === 1,
    audienceCursorFollowerId: broadcast.audience_cursor_follower_id,
  });
  await updateBroadcastStatus(db, broadcastId, 'sending', { totalTarget, lastError: null });

  const attemptedToday = broadcast.daily_limit === null
    ? 0
    : await getBroadcastAttemptsToday(db, broadcastId);
  const dispatchSize = broadcast.auto_append_recipients === 1
    ? CONTINUOUS_DISPATCH_SIZE
    : QUEUE_DISPATCH_SIZE;
  const remainingToday = broadcast.daily_limit === null
    ? dispatchSize
    : Math.max(0, broadcast.daily_limit - attemptedToday);
  const pending = await getPendingBroadcastQueue(
    db,
    broadcastId,
    Math.min(dispatchSize, remainingToday),
  );
  const claimed = [] as typeof pending;
  for (const item of pending) {
    if (await claimBroadcastQueueItem(db, item.id, null)) claimed.push(item);
  }
  if (claimed.length > 0) {
    try {
      await queue.sendBatch(claimed.map((item) => ({
        body: {
          broadcastId,
          queueItemId: item.id,
          followerId: item.follower_id,
          recipientIgsid: item.recipient_igsid,
          accountId,
        },
      })));
    } catch (err) {
      await Promise.all(claimed.map((item) => releaseBroadcastQueueItem(db, item.id)));
      throw err;
    }
  } else {
    // Avoid repeatedly scanning the whole frozen audience while the queue is
    // active. A full reconciliation is only needed once there is no more work
    // to dispatch; in-flight messages finish shortly afterwards and the next
    // cron tick performs the final reconciliation.
    await refreshBroadcastProgress(db, broadcastId);
  }
  return (await getBroadcastById(db, broadcastId))!;
}

export async function processBroadcastWorkItem(
  db: D1Database,
  igClient: InstagramClient,
  work: BroadcastWorkItem,
  retryAttempt = 1,
): Promise<void> {
  // Queue consumers do not need sent_today. Avoid the correlated daily-count
  // subquery in getBroadcastById for every recipient, which otherwise grows
  // quadratically as a large broadcast progresses.
  const broadcast = await db
    .prepare('SELECT body, message_type, status FROM broadcasts WHERE id = ?')
    .bind(work.broadcastId)
    .first<Pick<Broadcast, 'body' | 'message_type' | 'status'>>();
  if (!broadcast) throw new Error(`Broadcast ${work.broadcastId} not found`);
  if (broadcast.status !== 'sending') {
    await releaseBroadcastQueueItem(db, work.queueItemId);
    return;
  }
  const body = JSON.parse(broadcast.body) as Record<string, unknown>;
  try {
    await sendIgMessage(igClient, work.recipientIgsid, broadcast.message_type, body);
    await completeBroadcastQueueItem(db, {
      id: work.queueItemId,
      broadcastId: work.broadcastId,
      followerId: work.followerId,
      recipientIgsid: work.recipientIgsid,
      status: 'success',
    });
    await db
      .prepare(
        `INSERT INTO messages_log (follower_id, direction, message_type, body, trigger_source)
         VALUES (?, 'out', ?, ?, 'broadcast')`,
      )
      .bind(work.followerId, broadcast.message_type, broadcast.body)
      .run()
      .catch((err) => console.error(`Broadcast success logging failed for follower ${work.followerId}:`, err));
  } catch (err) {
    if (isRetryableBroadcastFailure(err)) {
      const retryDelaysSeconds = [120, 300, 600, 1_200, 1_800, 3_600];
      const delaySeconds = retryDelaysSeconds[Math.min(Math.max(retryAttempt - 1, 0), retryDelaysSeconds.length - 1)]!;
      const failure = describeBroadcastFailure(err);
      await setBroadcastBackoff(
        db,
        work.broadcastId,
        new Date(Date.now() + delaySeconds * 1_000).toISOString(),
        `一時的な送信制限のため${Math.ceil(delaySeconds / 60)}分待機します。${failure.message}`,
      );
      throw err;
    }
    const failure = describeBroadcastFailure(err);
    await completeBroadcastQueueItem(db, {
      id: work.queueItemId,
      broadcastId: work.broadcastId,
      followerId: work.followerId,
      recipientIgsid: work.recipientIgsid,
      status: 'failed',
      errorCode: failure.code,
      errorMessage: failure.message,
    });
    await recordDmFailure(db, work.accountId).catch(() => {});
  }
}

export async function refreshBroadcastProgress(
  db: D1Database,
  broadcastId: number | string,
): Promise<void> {
  const broadcast = await getBroadcastById(db, broadcastId);
  const counts = await getBroadcastQueueCounts(db, broadcastId);
  const complete = counts.pending === 0 && counts.processing === 0;
  const keepListening = broadcast?.auto_append_recipients === 1;
  await updateBroadcastStatus(db, broadcastId, complete && !keepListening ? 'sent' : 'sending', {
    totalSent: counts.success,
    totalTarget: counts.total,
    successCount: counts.success,
    failureCount: counts.failed,
    lastError: counts.failed > 0
      ? `${counts.failed}件の送信に失敗しました。配信結果から理由を確認してください。`
      : null,
  });
}

export async function processBroadcastSend(
  db: D1Database,
  igClient: InstagramClient,
  broadcastId: number | string,
  _workerUrl?: string,
  accountId?: string,
): Promise<Broadcast> {
  const broadcast = await getBroadcastById(db, broadcastId);
  if (!broadcast) {
    throw new Error(`Broadcast ${broadcastId} not found`);
  }

  try {
    const messageBody = JSON.parse(broadcast.body) as Record<string, unknown>;
    let tagId: string | undefined;
    if (broadcast.tag_filter) {
      const tagFilter = JSON.parse(broadcast.tag_filter) as { tagId?: string };
      if (!tagFilter.tagId) throw new Error('tag_filter must contain tagId');
      tagId = tagFilter.tagId;
    }

    // Snapshot once. On later cron ticks the existing queue is reused, so
    // newly-added followers do not shift the audience and completed users are
    // never selected again.
    const totalTarget = await initializeBroadcastQueue(db, {
      broadcastId,
      accountId: broadcast.account_id,
      tagId,
      appendNewRecipients: broadcast.auto_append_recipients === 1,
      audienceCursorFollowerId: broadcast.audience_cursor_follower_id,
    });
    await updateBroadcastStatus(db, broadcastId, 'sending', { totalTarget, lastError: null });

    // A Worker may stop after Meta accepted a send but before our checkpoint.
    // Treat that one recipient as uncertain instead of retrying and risking a
    // duplicate; all remaining pending recipients still resume normally.
    await failStaleBroadcastClaims(
      db,
      broadcastId,
      new Date(Date.now() - STALE_CLAIM_MS).toISOString(),
    );

    const attemptedToday = broadcast.daily_limit === null
      ? 0
      : await getBroadcastAttemptsToday(db, broadcastId);
    const dispatchSize = broadcast.auto_append_recipients === 1
      ? CONTINUOUS_DISPATCH_SIZE
      : BATCH_SIZE;
    const remainingToday = broadcast.daily_limit === null
      ? dispatchSize
      : Math.max(0, broadcast.daily_limit - attemptedToday);
    const batch = await getPendingBroadcastQueue(
      db,
      broadcastId,
      Math.min(dispatchSize, remainingToday),
    );
    for (const recipient of batch) {
      if (!(await claimBroadcastQueueItem(db, recipient.id, null))) continue;
      try {
        await sendIgMessage(igClient, recipient.recipient_igsid, broadcast.message_type, messageBody);
        await completeBroadcastQueueItem(db, {
          id: recipient.id,
          broadcastId,
          followerId: recipient.follower_id,
          recipientIgsid: recipient.recipient_igsid,
          status: 'success',
        });
        // Delivery is already checkpointed. Auxiliary chat logging must not
        // turn a successful send into a retry or duplicate.
        await db
          .prepare(
            `INSERT INTO messages_log (follower_id, direction, message_type, body, trigger_source)
             VALUES (?, 'out', ?, ?, 'broadcast')`,
          )
          .bind(recipient.follower_id, broadcast.message_type, broadcast.body)
          .run()
          .catch((err) => console.error(`Broadcast success logging failed for follower ${recipient.follower_id}:`, err));
      } catch (err) {
        const failure = describeBroadcastFailure(err);
        console.error(`Broadcast send failed for follower ${recipient.follower_id}:`, err);
        await completeBroadcastQueueItem(db, {
          id: recipient.id,
          broadcastId,
          followerId: recipient.follower_id,
          recipientIgsid: recipient.recipient_igsid,
          status: 'failed',
          errorCode: failure.code,
          errorMessage: failure.message,
        });
        await recordDmFailure(db, accountId ?? broadcast.account_id ?? 'unknown').catch(() => {});
      }
    }

    const counts = await getBroadcastQueueCounts(db, broadcastId);
    const complete = counts.pending === 0 && counts.processing === 0;
    const lastError = counts.failed > 0
      ? `${counts.failed}件の送信に失敗しました。配信結果から理由を確認してください。`
      : null;
    await updateBroadcastStatus(
      db,
      broadcastId,
      complete && broadcast.auto_append_recipients !== 1 ? 'sent' : 'sending',
      {
      totalSent: counts.success,
      totalTarget: counts.total,
      successCount: counts.success,
      failureCount: counts.failed,
      lastError,
      },
    );
  } catch (err) {
    const failure = describeBroadcastFailure(err);
    const counts = await getBroadcastQueueCounts(db, broadcastId).catch(() => ({
      total: broadcast.total_target,
      pending: 0,
      processing: 0,
      success: broadcast.success_count,
      failed: broadcast.failure_count,
    }));
    // Keep the job resumable. A later cron tick continues recipients that are
    // still pending; recipients checkpointed success/failed are not selected.
    await updateBroadcastStatus(db, broadcastId, 'sending', {
      totalSent: counts.success,
      totalTarget: counts.total,
      successCount: counts.success,
      failureCount: counts.failed,
      lastError: failure.message,
    });
    throw err;
  }

  return (await getBroadcastById(db, broadcastId))!;
}

export async function processScheduledBroadcasts(
  db: D1Database,
  igClient: InstagramClient,
  workerUrl?: string,
  accountId?: string,
  queue?: Queue<BroadcastWorkItem>,
): Promise<void> {
  if (isPostingPriorityWindow()) return;
  // When an accountId is given, the due extraction is scoped at the SQL level
  // so each account's cron tick only picks up its own scheduled broadcasts.
  const allBroadcasts = await getBroadcasts(db, accountId ? { accountId } : {});
  const nowMs = Date.now();

  const runnable = allBroadcasts.filter(
    (b) =>
      (b.status === 'sending' ||
        (b.status === 'scheduled' &&
          b.scheduled_at !== null &&
          new Date(b.scheduled_at).getTime() <= nowMs)) &&
        !hasReachedBroadcastDailyLimit(b) &&
        (b.backoff_until === null || new Date(b.backoff_until).getTime() <= nowMs) &&
        isWithinBroadcastDeliveryWindow(b) &&
        (b.auto_append_recipients === 1 ||
          getDeliveryWindow(b)?.highThroughput === true ||
          isBroadcastBatchMinute()),
  );

  // Exactly one small recipient batch per account/tick. Cron always processes
  // posts and campaign deliveries before reaching this function, and bulk
  // work therefore cannot consume the entire invocation.
  const broadcast = runnable[0];
  if (broadcast) {
    try {
      const window = getDeliveryWindow(broadcast);
      if (accountId && window?.pauseForPriorityWork && await hasRecentPriorityActivity(db, accountId)) {
        return;
      }
      if (queue && accountId) {
        await enqueueBroadcastWork(db, queue, broadcast.id, accountId);
      } else {
        await processBroadcastSend(db, igClient, broadcast.id, workerUrl, accountId);
      }
    } catch (err) {
      console.error(`Failed to send scheduled broadcast ${broadcast.id}:`, err);
    }
  }
}

export async function sendIgMessage(
  igClient: InstagramClient,
  recipientId: string,
  messageType: string,
  body: Record<string, unknown>,
): Promise<void> {
  switch (messageType) {
    case 'text':
      await igClient.sendText(recipientId, body.text as string);
      break;
    case 'image':
      await igClient.sendImage(recipientId, body.url as string);
      break;
    case 'template':
      if (Array.isArray(body.blocks)) {
        await igClient.sendRichMessage(recipientId, body.blocks as RichMessageBlock[]);
      } else {
        await igClient.sendGenericTemplate(recipientId, body.elements as never[]);
      }
      break;
    case 'quick_reply':
      await igClient.sendQuickReply(
        recipientId,
        body.text as string,
        body.quick_replies as never[],
      );
      break;
    default:
      if (typeof body.text === 'string') {
        await igClient.sendText(recipientId, body.text);
      }
  }
}
