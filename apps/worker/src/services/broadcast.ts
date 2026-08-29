import {
  getBroadcastById,
  getBroadcasts,
  updateBroadcastStatus,
  getFriendsByTag,
  clearBroadcastDeliveries,
  recordBroadcastDelivery,
} from '@ig-harness/db';
import type { Broadcast } from '@ig-harness/db';
import type { InstagramClient } from '@ig-harness/ig-sdk';
import { calculateStaggerDelay, sleep } from './stealth.js';
import { recordDmFailure } from '../lib/health.js';

const BATCH_SIZE = 50; // IG API is more conservative than LINE

type BroadcastRecipient = { id: number; igsid: string };

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

  await clearBroadcastDeliveries(db, broadcastId);
  await updateBroadcastStatus(db, broadcastId, 'sending', {
    totalSent: 0,
    totalTarget: 0,
    successCount: 0,
    failureCount: 0,
    lastError: null,
  });

  let totalSent = 0;
  let failureCount = 0;

  try {
    const messageBody = JSON.parse(broadcast.body) as Record<string, unknown>;
    let recipients: BroadcastRecipient[];

    if (!broadcast.tag_filter) {
      // No tag filter — send to all of the owning account's followers.
      // account_id NULL (legacy pre-backfill rows / single-account deploys
      // before seed) keeps the unscoped behavior.
      const stmt = broadcast.account_id
        ? db.prepare(`SELECT id, igsid FROM followers WHERE account_id = ?`).bind(broadcast.account_id)
        : db.prepare(`SELECT id, igsid FROM followers`);
      const followers = await stmt.all<{ id: number; igsid: string }>();
      recipients = followers.results;
    } else {
      // tag_filter present — parse and send to matching followers
      const tagFilter = JSON.parse(broadcast.tag_filter) as { tagId?: string };
      if (!tagFilter.tagId) {
        throw new Error('tag_filter must contain tagId');
      }

      recipients = await getFriendsByTag(db, tagFilter.tagId, {
        accountId: broadcast.account_id ?? undefined,
      });
    }

    await updateBroadcastStatus(db, broadcastId, 'sending', { totalTarget: recipients.length });

    for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
      const batch = recipients.slice(i, i + BATCH_SIZE);
      const batchIndex = Math.floor(i / BATCH_SIZE);

      if (batchIndex > 0) {
        const delay = calculateStaggerDelay(recipients.length, batchIndex);
        await sleep(delay);
      }

      for (const recipient of batch) {
        try {
          await sendIgMessage(igClient, recipient.igsid, broadcast.message_type, messageBody);
        } catch (err) {
          failureCount++;
          const failure = describeBroadcastFailure(err);
          console.error(`Broadcast send failed for follower ${recipient.id}:`, err);
          await Promise.all([
            recordBroadcastDelivery(db, {
              broadcastId,
              followerId: recipient.id,
              recipientIgsid: recipient.igsid,
              status: 'failed',
              errorCode: failure.code,
              errorMessage: failure.message,
            }),
            recordDmFailure(db, accountId ?? broadcast.account_id ?? 'unknown').catch(() => {}),
          ]);
          continue;
        }

        totalSent++;
        await Promise.all([
          db
            .prepare(
              `INSERT INTO messages_log (follower_id, direction, message_type, body, trigger_source)
               VALUES (?, 'out', ?, ?, 'broadcast')`,
            )
            .bind(recipient.id, broadcast.message_type, broadcast.body)
            .run(),
          recordBroadcastDelivery(db, {
            broadcastId,
            followerId: recipient.id,
            recipientIgsid: recipient.igsid,
            status: 'success',
          }),
        ]).catch((err) => {
          // The Instagram send already succeeded. Do not mislabel it as a
          // delivery failure just because auxiliary logging failed.
          console.error(`Broadcast success logging failed for follower ${recipient.id}:`, err);
        });
      }
    }

    const lastError = failureCount > 0
      ? `${failureCount}件の送信に失敗しました。配信結果から理由を確認してください。`
      : null;
    await updateBroadcastStatus(db, broadcastId, 'sent', {
      totalSent,
      totalTarget: recipients.length,
      successCount: totalSent,
      failureCount,
      lastError,
    });
  } catch (err) {
    const failure = describeBroadcastFailure(err);
    await updateBroadcastStatus(db, broadcastId, 'draft', {
      totalSent,
      successCount: totalSent,
      failureCount,
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
  // When an accountId is given, the due extraction is scoped at the SQL level
  // so each account's cron tick only picks up its own scheduled broadcasts.
  const allBroadcasts = await getBroadcasts(db, accountId ? { accountId } : {});
  const nowMs = Date.now();

  const scheduled = allBroadcasts.filter(
    (b) =>
      b.status === 'scheduled' &&
      b.scheduled_at !== null &&
      new Date(b.scheduled_at).getTime() <= nowMs,
  );

  for (const broadcast of scheduled) {
    try {
      await processBroadcastSend(db, igClient, broadcast.id, workerUrl, accountId);
    } catch (err) {
      console.error(`Failed to send scheduled broadcast ${broadcast.id}:`, err);
    }
  }
}

async function sendIgMessage(
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
      await igClient.sendGenericTemplate(recipientId, body.elements as never[]);
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
