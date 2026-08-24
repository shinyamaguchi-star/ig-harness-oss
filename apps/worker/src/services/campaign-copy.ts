import {
  createEngagementGate,
  deleteEngagementGate,
  getRichMessage,
  setGateTargetPosts,
  type EngagementGate,
} from '@ig-harness/db';

/**
 * Duplicate one campaign as a safe, independent draft.
 *
 * - The new gate is always paused to prevent accidental double delivery.
 * - Delivery history and analytics are not copied.
 * - Referenced rich messages are reused by default. The campaign editor uses
 *   copy-on-write: only a DM slot that the operator changes creates a new
 *   rich message, while unchanged slots keep these shared ids.
 * - The LINE tracked-link cache is intentionally cleared; the copy gets its
 *   own gate-specific link on first delivery.
 */
export async function copyEngagementGate(
  db: D1Database,
  source: EngagementGate,
  accountId: string,
): Promise<EngagementGate> {
  const copyName = `${source.name}（コピー）`;

  // Validate every shared reference before writing anything. If the source
  // has a broken template id, this prevents a copied campaign that cannot
  // send one of its DM slots.
  const referencedIds = Array.from(
    new Set(
      [
        source.initial_dm_rich_message_id,
        source.reward_dm_rich_message_id,
        source.follow_reminder_dm_rich_message_id,
      ].filter((id): id is string => !!id),
    ),
  );
  for (const id of referencedIds) {
    const message = await getRichMessage(db, id);
    if (!message) throw new Error(`参照中のDMテンプレートが見つかりません: ${id}`);
  }

  const targetIds =
    source.target_post_ids && source.target_post_ids.length > 0
      ? source.target_post_ids
      : source.target_post_id
        ? [source.target_post_id]
        : [];

  let copied: EngagementGate | null = null;
  try {
    copied = await createEngagementGate(db, {
      name: copyName,
      status: 'paused',
      trigger_type: source.trigger_type,
      target_post_id: targetIds[0] ?? null,
      trigger_keyword: source.trigger_keyword,
      trigger_keywords: source.trigger_keywords ?? null,
      require_follow: source.require_follow,
      initial_dm_text: source.initial_dm_text,
      initial_dm_button_label: source.initial_dm_button_label,
      follow_reminder_dm_text: source.follow_reminder_dm_text,
      follow_reminder_button_label: source.follow_reminder_button_label,
      reward_dm_text: source.reward_dm_text,
      reward_url: source.reward_url,
      max_loops: source.max_loops,
      initial_dm_rich_message_id: source.initial_dm_rich_message_id,
      reward_dm_rich_message_id: source.reward_dm_rich_message_id,
      follow_reminder_dm_rich_message_id: source.follow_reminder_dm_rich_message_id,
      comment_reply_text: source.comment_reply_text,
      followup_dm_sequence: source.followup_dm_sequence,
      line_connection_id: source.line_connection_id,
      line_pool_slug: source.line_pool_slug,
      line_tracked_link_short: null,
      allow_repeat: source.allow_repeat,
      accountId,
    });

    await setGateTargetPosts(db, copied.id, targetIds);
    copied.target_post_ids = targetIds;
    return copied;
  } catch (error) {
    // Best-effort rollback of records created by this operation only.
    if (copied) await deleteEngagementGate(db, copied.id).catch(() => undefined);
    throw error;
  }
}
