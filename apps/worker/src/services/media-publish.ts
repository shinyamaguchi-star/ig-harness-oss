import {
  getDueMediaPosts,
  getProcessingMediaPosts,
  getMediaPostById,
  getPendingCampaignMediaPosts,
  getEngagementGate,
  addGateTargetPost,
  updateEngagementGate,
  updateMediaPost,
  type MediaPost,
  type MediaPostMediaItem,
} from '@ig-harness/db';
import { jstNow } from '@ig-harness/db';
import type { InstagramClient } from '@ig-harness/ig-sdk';

const MAX_ATTEMPTS = 3;
const DEFAULT_QUOTA_TOTAL = 100;

/**
 * Cron entry — advances every media post of one account through the
 * state machine: scheduled → processing → published / failed.
 * Called every 5 minutes from the scheduled() handler.
 * `now` must be a JST (+09:00) string — scheduled_at comparison is a
 * plain SQL string compare, so formats must match (see Task 1 note).
 */
export async function processMediaPosts(
  db: D1Database,
  igClient: InstagramClient,
  accountId: string,
  now: string = jstNow(),
): Promise<void> {
  const due = await getDueMediaPosts(db, accountId, now);
  for (const post of due) {
    await startPost(db, igClient, post);
  }
  const processing = await getProcessingMediaPosts(db, accountId);
  for (const post of processing) {
    await advancePost(db, igClient, post);
  }
  // Retry campaign activation independently from publishing. Instagram may
  // already have accepted the post even if a later D1 write briefly failed.
  const pendingCampaigns = await getPendingCampaignMediaPosts(db, accountId);
  for (const post of pendingCampaigns) {
    await activateLinkedCampaign(db, post);
  }
}

/**
 * Immediate-post fast path: run one start+advance cycle right away (via
 * waitUntil from the route). Images publish in seconds; videos fall back
 * to the next cron cycle while Meta processes the container.
 */
export async function kickImmediate(
  db: D1Database,
  igClient: InstagramClient,
  postId: string,
): Promise<void> {
  const post = await getMediaPostById(db, postId);
  if (!post || post.status !== 'scheduled') return;
  const started = await startPost(db, igClient, post);
  if (!started) return;
  const refreshed = await getMediaPostById(db, postId);
  if (refreshed && refreshed.status === 'processing') {
    await advancePost(db, igClient, refreshed);
  }
}

/** scheduled → processing (creates the IG container). Returns true on success. */
async function startPost(
  db: D1Database,
  igClient: InstagramClient,
  post: MediaPost,
): Promise<boolean> {
  try {
    const media = JSON.parse(post.media) as MediaPostMediaItem[];
    const limit = await igClient.getPublishingLimit();
    const total = limit.config?.quota_total ?? DEFAULT_QUOTA_TOTAL;
    // A carousel uses one publishing slot, while every Story frame is an
    // independent Instagram publication. Do not start a Story batch unless
    // the whole batch fits; otherwise only part of it could be published.
    const requiredSlots = post.post_type === 'story' ? media.length : 1;
    if (limit.quota_usage + requiredSlots > total) {
      // Not a failure — quota is a rolling 24h window, so carry the post
      // over to the next cycle without touching status/attempt_count.
      await updateMediaPost(db, post.id, {
        error: `publishing quota insufficient (${limit.quota_usage}/${total}, required=${requiredSlots}); will retry next cycle`,
      });
      return false;
    }

    let creationId: string;
    let childIds: string[] | null = null;

    if (post.post_type === 'carousel') {
      childIds = [];
      for (const item of media) {
        const child = await igClient.createMediaContainer({
          imageUrl: item.type === 'image' ? item.url : undefined,
          videoUrl: item.type === 'video' ? item.url : undefined,
          // Video carousel children require media_type=VIDEO.
          mediaType: item.type === 'video' ? 'VIDEO' : undefined,
          isCarouselItem: true,
        });
        childIds.push(child.id);
      }
      const parent = await igClient.createMediaContainer({
        mediaType: 'CAROUSEL',
        children: childIds,
        caption: post.caption ?? undefined,
      });
      creationId = parent.id;
    } else if (post.post_type === 'reel') {
      const created = await igClient.createMediaContainer({
        videoUrl: media[0].url,
        mediaType: 'REELS',
        caption: post.caption ?? undefined,
        coverUrl: post.cover_url ?? undefined,
        thumbOffsetMs: post.cover_url ? undefined : post.thumb_offset_ms ?? undefined,
      });
      creationId = created.id;
    } else if (post.post_type === 'story') {
      // Meta has no carousel-style multi-asset Story container. Create one
      // container per frame and retain their selected order. advancePost()
      // publishes them sequentially and never overtakes a video still being
      // processed.
      childIds = [];
      for (const item of media) {
        const created = await igClient.createMediaContainer({
          imageUrl: item.type === 'image' ? item.url : undefined,
          videoUrl: item.type === 'video' ? item.url : undefined,
          mediaType: 'STORIES',
        });
        childIds.push(created.id);
      }
      creationId = childIds[0];
    } else {
      const created = await igClient.createMediaContainer({
        imageUrl: media[0].url,
        caption: post.caption ?? undefined,
      });
      creationId = created.id;
    }

    await updateMediaPost(db, post.id, {
      status: 'processing',
      creation_id: creationId,
      child_creation_ids: childIds ? JSON.stringify(childIds) : undefined,
      error: null,
    });
    return true;
  } catch (err) {
    await recordFailure(db, post, err);
    return false;
  }
}

/** processing → published / failed (polls container status, then publishes). */
async function advancePost(
  db: D1Database,
  igClient: InstagramClient,
  post: MediaPost,
): Promise<void> {
  if (!post.creation_id) {
    await updateMediaPost(db, post.id, {
      status: 'failed',
      error: 'processing post without creation_id',
      campaign_activation_status: post.campaign_gate_id ? 'failed' : undefined,
      campaign_error: post.campaign_gate_id ? '投稿に失敗したため自動応答を開始できません' : undefined,
    });
    return;
  }
  if (post.post_type === 'story') {
    await advanceStoryPost(db, igClient, post);
    return;
  }
  try {
    const status = await igClient.getContainerStatus(post.creation_id);
    if (status.status_code === 'FINISHED') {
      const result = await igClient.publishMedia(post.creation_id);
      const published = await updateMediaPost(db, post.id, {
        status: 'published',
        published_media_id: result.id,
        error: null,
      });
      if (published?.campaign_gate_id) await activateLinkedCampaign(db, published);
    } else if (status.status_code === 'PUBLISHED') {
      // Container was already published (e.g., if the previous updateMediaPost write
      // failed or the worker was terminated after publishMedia succeeded). Recover
      // to published state without re-publishing.
      await updateMediaPost(db, post.id, {
        status: 'published',
        error: 'recovered: container already PUBLISHED; media id unrecorded',
      });
    } else if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') {
      await updateMediaPost(db, post.id, {
        status: 'failed',
        error: `container ${status.status_code}: ${status.status ?? ''}`.trim(),
        campaign_activation_status: post.campaign_gate_id ? 'failed' : undefined,
        campaign_error: post.campaign_gate_id ? '投稿に失敗したため自動応答を開始できません' : undefined,
      });
    }
    // IN_PROGRESS → leave for the next cron cycle (video encoding takes minutes).
  } catch (err) {
    await recordFailure(db, post, err);
  }
}

/** Publish Story frames in the operator-selected order.
 *
 * A multi-frame Story is represented by multiple independent Meta containers.
 * We stop at the first IN_PROGRESS frame so a later image can never overtake
 * an earlier video. Already-PUBLISHED containers are safe recovery markers if
 * the Worker stopped after Meta accepted a frame but before D1 was updated.
 */
async function advanceStoryPost(
  db: D1Database,
  igClient: InstagramClient,
  post: MediaPost,
): Promise<void> {
  let containerIds: string[] = [post.creation_id!];
  if (post.child_creation_ids) {
    try {
      const parsed = JSON.parse(post.child_creation_ids) as unknown;
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every((id) => typeof id === 'string' && id.length > 0)
      ) {
        containerIds = parsed;
      }
    } catch {
      // Backwards compatibility: older single-frame rows have no child list.
    }
  }

  let lastPublishedMediaId = post.published_media_id;
  try {
    for (let index = 0; index < containerIds.length; index += 1) {
      const containerId = containerIds[index];
      const status = await igClient.getContainerStatus(containerId);
      if (status.status_code === 'IN_PROGRESS') return;
      if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') {
        await updateMediaPost(db, post.id, {
          status: 'failed',
          error: `story ${index + 1}/${containerIds.length} container ${status.status_code}: ${status.status ?? ''}`.trim(),
        });
        return;
      }
      if (status.status_code === 'PUBLISHED') continue;
      if (status.status_code !== 'FINISHED') return;

      const result = await igClient.publishMedia(containerId);
      lastPublishedMediaId = result.id;
    }

    await updateMediaPost(db, post.id, {
      status: 'published',
      published_media_id: lastPublishedMediaId,
      error: null,
    });
  } catch (err) {
    await recordFailure(db, post, err);
  }
}

/** Append the real IG media id to the prepared gate, then activate it. Both
 * new and existing campaigns linked to a reservation follow this lifecycle;
 * activation never happens before a real published Instagram media id exists. */
async function activateLinkedCampaign(db: D1Database, post: MediaPost): Promise<void> {
  if (!post.campaign_gate_id || !post.published_media_id) return;
  try {
    const gate = await getEngagementGate(db, post.campaign_gate_id);
    if (!gate) throw new Error('linked campaign not found');
    if (gate.status === 'archived') {
      await updateMediaPost(db, post.id, {
        campaign_activation_status: 'canceled',
        campaign_error: 'キャンペーンがアーカイブされているため開始しませんでした',
      });
      return;
    }
    await addGateTargetPost(db, gate.id, post.published_media_id);
    if (gate.status === 'paused') {
      const activated = await updateEngagementGate(db, gate.id, { status: 'active' });
      if (!activated) throw new Error('linked campaign could not be activated');
    }
    await updateMediaPost(db, post.id, {
      campaign_activation_status: 'active',
      campaign_error: null,
    });
  } catch (err) {
    await updateMediaPost(db, post.id, {
      campaign_activation_status: 'failed',
      campaign_error: `自動応答の有効化に失敗しました: ${String(err instanceof Error ? err.message : err)}`,
    });
  }
}

/**
 * Transient errors bump attempt_count and retry next cycle; the 3rd
 * failure is terminal. Permission errors get an actionable message.
 */
async function recordFailure(db: D1Database, post: MediaPost, err: unknown): Promise<void> {
  const attempts = post.attempt_count + 1;
  const message = describeError(err);
  if (attempts >= MAX_ATTEMPTS) {
    await updateMediaPost(db, post.id, {
      status: 'failed',
      attempt_count: attempts,
      error: message,
      campaign_activation_status: post.campaign_gate_id ? 'failed' : undefined,
      campaign_error: post.campaign_gate_id ? '投稿に失敗したため自動応答を開始できません' : undefined,
    });
  } else {
    await updateMediaPost(db, post.id, { attempt_count: attempts, error: message });
  }
}

function describeError(err: unknown): string {
  const message = String(err instanceof Error ? err.message : err);
  if (/\(#10\)|permission|not authorized|oauth/i.test(message)) {
    return `権限エラー: トークンに instagram_business_content_publish スコープが必要です。設定画面からアカウントを再認可してください。 (${message})`;
  }
  return message;
}
