import { getFriendByIgsid, upsertFriend } from '@ig-harness/db';
import type { InstagramClient, ConversationParticipant } from '@ig-harness/ig-sdk';

export interface ConversationSyncResult {
  conversationsScanned: number;
  contactsFound: number;
  added: number;
  updated: number;
  skipped: number;
  nextCursor: string | null;
  hasMore: boolean;
}

interface ConversationBackfillState {
  cursor: string | null;
  done: boolean;
  completedAt: string | null;
  conversationsScanned: number;
  added: number;
  updated: number;
  skipped: number;
}

const CONVERSATION_RESCAN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Import one Conversations API page into the account-scoped followers table.
 * Repeating the operation is safe: followers.igsid is unique and upsertFriend
 * updates existing rows rather than creating duplicates.
 */
export async function syncConversationPage(
  db: D1Database,
  igClient: InstagramClient,
  account: { id: string; ig_user_id: string },
  after?: string,
): Promise<ConversationSyncResult> {
  const page = await igClient.getConversations(after);
  const conversations = page.data ?? [];
  const contacts = new Map<string, ConversationParticipant>();
  let skipped = 0;

  for (const conversation of conversations) {
    const participants = conversation.participants?.data ?? [];
    const external = participants.filter(
      (participant) => participant.id && participant.id !== account.ig_user_id,
    );
    if (external.length === 0) {
      skipped++;
      continue;
    }
    for (const participant of external) contacts.set(participant.id, participant);
  }

  let added = 0;
  let updated = 0;
  const contactList = [...contacts.values()];
  // Each upsert includes several D1 operations. Ten-at-a-time avoids the long
  // wall-clock time of 50 fully serial contacts while keeping concurrency low.
  for (let offset = 0; offset < contactList.length; offset += 10) {
    const outcomes = await Promise.all(contactList.slice(offset, offset + 10).map(async (participant) => {
      const existing = await getFriendByIgsid(db, participant.id);
      // A globally-existing row owned by another account must never be moved.
      // This is rare in the current one-account-per-environment deployments,
      // but skipping is safer than cross-account data leakage.
      if (existing?.account_id && existing.account_id !== account.id) return 'skipped' as const;
      await upsertFriend(db, {
        igsid: participant.id,
        username: participant.username ?? null,
        displayName: participant.name ?? participant.username ?? null,
        accountId: account.id,
      });
      return existing ? 'updated' as const : 'added' as const;
    }));
    for (const outcome of outcomes) {
      if (outcome === 'added') added++;
      else if (outcome === 'updated') updated++;
      else skipped++;
    }
  }

  const nextCursor = page.paging?.cursors?.after ?? null;
  return {
    conversationsScanned: conversations.length,
    contactsFound: contacts.size,
    added,
    updated,
    skipped,
    nextCursor,
    hasMore: Boolean(page.paging?.next && nextCursor),
  };
}

/**
 * Automatic backfill driven by the existing five-minute cron. It processes
 * one page per tick and persists the cursor immediately. A completed inbox is
 * scanned again weekly so contacts missed by a webhook or added after the
 * initial import are eventually reconciled without a manual admin action.
 * The cursor is account-scoped and persisted in integration_settings.
 */
async function runConversationBackfill(
  db: D1Database,
  igClient: InstagramClient,
  account: { id: string; ig_user_id: string },
): Promise<ConversationBackfillState> {
  const key = `conversation_backfill_v1:${account.id}`;
  const stored = await db
    .prepare('SELECT value FROM integration_settings WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  let state: ConversationBackfillState = {
    cursor: null,
    done: false,
    completedAt: null,
    conversationsScanned: 0,
    added: 0,
    updated: 0,
    skipped: 0,
  };
  if (stored?.value) {
    try { state = { ...state, ...JSON.parse(stored.value) as Partial<ConversationBackfillState> }; }
    catch { /* restart a corrupt cursor safely from the first page */ }
  }
  if (state.done) {
    const completedAtMs = state.completedAt ? Date.parse(state.completedAt) : Number.NaN;
    const completedRecently =
      Number.isFinite(completedAtMs) && Date.now() - completedAtMs < CONVERSATION_RESCAN_INTERVAL_MS;
    if (completedRecently) return state;

    state = {
      cursor: null,
      done: false,
      completedAt: null,
      conversationsScanned: 0,
      added: 0,
      updated: 0,
      skipped: 0,
    };
  }

  for (let pageIndex = 0; pageIndex < 1; pageIndex++) {
    const result = await syncConversationPage(db, igClient, account, state.cursor ?? undefined);
    // One-to-one Instagram conversations should expose the other participant.
    // Treat a whole non-empty page without participants as an API-shape error,
    // otherwise we could mark a backfill complete while importing nobody.
    if (result.conversationsScanned > 0 && result.contactsFound === 0) {
      throw new Error('Conversations API returned conversations without participants');
    }
    state.conversationsScanned += result.conversationsScanned;
    state.added += result.added;
    state.updated += result.updated;
    state.skipped += result.skipped;
    state.cursor = result.nextCursor;
    state.done = !result.hasMore;
    if (state.done) state.completedAt = new Date().toISOString();
    if (state.done) break;
  }

  await db
    .prepare(
      `INSERT INTO integration_settings (key, value, updated_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now')))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, JSON.stringify(state))
    .run();
  return state;
}

/** Run the cron backfill while retaining a redacted failure reason for
 * operators. Access tokens are never written to D1. */
export async function processConversationBackfill(
  db: D1Database,
  igClient: InstagramClient,
  account: { id: string; ig_user_id: string },
): Promise<ConversationBackfillState> {
  const errorKey = `conversation_backfill_error_v1:${account.id}`;
  try {
    const result = await runConversationBackfill(db, igClient, account);
    await db.prepare('DELETE FROM integration_settings WHERE key = ?').bind(errorKey).run();
    return result;
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const safe = raw
      .replace(/access_token=[^&\s]+/gi, 'access_token=[REDACTED]')
      .replace(/"access_token"\s*:\s*"[^"]+"/gi, '"access_token":"[REDACTED]"')
      .slice(0, 800);
    await db
      .prepare(
        `INSERT INTO integration_settings (key, value, updated_at)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now')))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(errorKey, JSON.stringify({ error: safe, checkedAt: new Date().toISOString() }))
      .run();
    throw error;
  }
}
