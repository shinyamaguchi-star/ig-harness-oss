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
} from '@ig-harness/db';
import type { Broadcast } from '@ig-harness/db';
import type { InstagramClient, RichMessageBlock } from '@ig-harness/ig-sdk';
import { recordDmFailure } from '../lib/health.js';

const BATCH_SIZE = 50; // IG API is more conservative than LINE
const STALE_CLAIM_MS = 10 * 60 * 1000;

/** Cloudflare Cron has minute precision. With one every-minute trigger, these
 * minute slots produce alternating 2- and 3-minute gaps (average 2.5 min)
 * without consuming two cron-trigger slots per Worker. */
export function isBroadcastBatchMinute(date = new Date()): boolean {
  const minuteInFive = date.getUTCMinutes() % 5;
  return minuteInFive === 0 || minuteInFive === 2;
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

    const batch = await getPendingBroadcastQueue(db, broadcastId, BATCH_SIZE);
    for (const recipient of batch) {
      if (!(await claimBroadcastQueueItem(db, recipient.id))) continue;
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
    await updateBroadcastStatus(db, broadcastId, complete ? 'sent' : 'sending', {
      totalSent: counts.success,
      totalTarget: counts.total,
      successCount: counts.success,
      failureCount: counts.failed,
      lastError,
    });
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
): Promise<void> {
  if (!isBroadcastBatchMinute()) return;
  // When an accountId is given, the due extraction is scoped at the SQL level
  // so each account's cron tick only picks up its own scheduled broadcasts.
  const allBroadcasts = await getBroadcasts(db, accountId ? { accountId } : {});
  const nowMs = Date.now();

  const runnable = allBroadcasts.filter(
    (b) =>
      b.status === 'sending' ||
      (b.status === 'scheduled' &&
        b.scheduled_at !== null &&
        new Date(b.scheduled_at).getTime() <= nowMs),
  );

  // Exactly one 50-recipient batch per account/tick. Cron always processes
  // posts and campaign deliveries before reaching this function, and bulk
  // work therefore cannot consume the entire invocation.
  const broadcast = runnable[0];
  if (broadcast) {
    try {
      await processBroadcastSend(db, igClient, broadcast.id, workerUrl, accountId);
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
