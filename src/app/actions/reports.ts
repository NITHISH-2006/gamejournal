'use server';

import { createClient, requireUser } from '@/lib/supabase';
import { validateUuid } from '@/lib/validation';
import { enforce } from '@/lib/rate-limit';
import { callerKey } from '@/lib/limiter';

/**
 * Content reporting.
 *
 * â”€â”€ Why this file exists twice over â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 *
 * The previous version of this app shipped a `ReportButton` and a
 * `reportContent` action, and the README advertised "Report content
 * moderation" as a working feature. There was no `reports` table in any
 * migration, so every insert failed with PGRST205, and the error was thrown
 * straight at the user. The feature had never worked.
 *
 * The second problem was structural: `reportContent` took the reporter's id
 * nowhere â€” it read the session â€” but it accepted an arbitrary `contentType` and
 * `contentId` from the client with no validation, no rate limit, and a `reason`
 * that was never length-checked against the column's constraint. An insert into
 * an unconstrained column is a free-text storage primitive.
 *
 * Migration 004 creates the table with RLS. The policies are the real
 * enforcement: insert is permitted only where `auth.uid() = reporter_id`, so a
 * browser cannot file a report against someone else's name. There is no update
 * or delete policy at all, which is why the type declares `Update: never`.
 */

export type ReportableType = 'log' | 'review' | 'comment' | 'user';

const CONTENT_TYPES = new Set<string>(['log', 'review', 'comment', 'user']);

export type ReportReason =
  | 'spam'
  | 'harassment'
  | 'offensive'
  | 'misinformation'
  | 'copyright'
  | 'other';

/**
 * Reasons are a closed set rather than free text.
 *
 * A moderation queue is only usable if reports can be grouped and counted. A
 * free-text field cannot be filtered, and "other" with a comment covers the long
 * tail. `notes` exists for the detail.
 */
const REASONS = new Set<string>([
  'spam',
  'harassment',
  'offensive',
  'misinformation',
  'copyright',
  'other',
]);

export async function reportContent(
  contentType: unknown,
  contentId: unknown,
  reason: unknown,
  notes?: unknown
): Promise<{ ok: true }> {
  const user = await requireUser();
  // Tight: this is a write to a table anyone can insert into, and a report
  // queue is exactly the kind of thing that gets flooded.
  await enforce(await callerKey('report:create', user.id), 10, 60_000);

  const type = String(contentType ?? '');
  if (!CONTENT_TYPES.has(type)) {
    throw new Error('That content type cannot be reported.');
  }

  const id = validateUuid(contentId, 'content id');

  const reasonKey = String(reason ?? '');
  if (!REASONS.has(reasonKey)) {
    throw new Error('Please choose a reason.');
  }

  let note: string | null = null;
  if (notes !== undefined && notes !== null && String(notes).trim().length > 0) {
    note = String(notes).trim().slice(0, 2000);
  }

  const supabase = await createClient();
  const { error } = await supabase.from('reports').insert({
    reporter_id: user.id,
    content_type: type,
    content_id: id,
    reason: reasonKey,
    notes: note,
  });

  if (error) {
    // 23505 is the partial unique index: this user already reported this item.
    // That is the desired outcome, not a failure, so it must not surface as an
    // error the user has to interpret.
    if (error.code === '23505') return { ok: true };

    // PGRST205 means migration 004 has not been applied. Say so plainly rather
    // than reporting a missing table to someone who just clicked a button.
    if (error.code === 'PGRST205' || /reports/i.test(error.message)) {
      console.error('[reports] the reports table is missing. Run migration 004.');
      throw new Error(
        'Reporting is unavailable right now. Please try again later.'
      );
    }

    throw new Error(error.message);
  }

  return { ok: true };
}

/**
 * Whether the current user has already reported something.
 *
 * Read-only, and used so the button can say "Reported" instead of inviting a
 * duplicate that the unique index would silently discard.
 */
export async function getExistingReports(contentId: unknown): Promise<ReportableType[]> {
  const id = validateUuid(contentId, 'content id');

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from('reports')
    .select('content_type')
    .eq('reporter_id', user.id)
    .eq('content_id', id)
    .limit(10);

  if (error) {
    // Pre-004 database. Absent feature, not an error the user needs to see.
    console.error('[reports] getExistingReports error:', error.message);
    return [];
  }

  return (data ?? []).map((r) => r.content_type as ReportableType);
}