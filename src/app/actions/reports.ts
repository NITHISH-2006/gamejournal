'use server';

import { createClient, requireUser } from '@/lib/supabase';
import { validateUuid } from '@/lib/validation';
import { enforce } from '@/lib/rate-limit';
import { callerKey } from '@/lib/limiter';

/**
 * Content reporting.
 *
 * ── Why this file exists twice over ─────────────────────────────────────────
 *
 * The previous version of this app shipped a `ReportButton` and a
 * `reportContent` action, and the README advertised "Report content
 * moderation" as a working feature. There was no `reports` table in any
 * migration, so every insert failed with PGRST205, and the error was thrown
 * straight at the user. The feature had never worked.
 *
 * The second problem was structural: `reportContent` took the reporter's id
 * nowhere — it read the session — but it accepted an arbitrary `contentType` and
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

/**
 * Derived from the type rather than declared alongside it.
 *
 * Two independent declarations of the same set — a union and a `Set` — can
 * drift: adding a value to the union compiles, then silently fails the runtime
 * check and the caller gets "that content type cannot be reported".
 */
const CONTENT_TYPES: ReadonlySet<string> = new Set<string>([
  'log',
  'review',
  'comment',
  'user',
] satisfies readonly ReportableType[]);

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

  /**
   * Confirm the target exists before filing.
   *
   * At 10 reports/minute an account could otherwise add 14,400 queue rows a
   * day, every one pointing at a random UUID that never existed. A moderation
   * queue that is mostly garbage costs a moderator real time and buries the
   * reports that matter.
   *
   * `report_target_exists` is `security definer` precisely so this works for the
   * many cases where the reporter cannot read the row they are reporting — a
   * deleted comment, a private profile. It returns a boolean and discloses
   * nothing.
   */
  const { data: exists, error: existsError } = await supabase.rpc('report_target_exists', {
    p_content_type: type,
    p_content_id: id,
  });

  if (existsError) {
    // Pre-005 database. The check is a safety net, so its absence must not block
    // reporting — but an operator should know the net is missing.
    console.error('[reports] target check unavailable:', existsError.message);
  } else if (exists === false) {
    throw new Error('That content no longer exists, so there is nothing to report.');
  }
  // `data` is a bare `boolean` here, so there is no `[0]` unwrap: a function
  // returning a scalar yields the scalar. Treating it as a row array is why the
  // earlier draft compared `{exists}[]` with `false` and could never have fired.

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

    /**
     * The table does not exist yet: migration 004 has not been applied.
     *
     * Branching on the code rather than `/reports/i.test(error.message)`,
     * which also matched `42501 permission denied for table reports` — so an
     * RLS misconfiguration was reported to users as a transient outage, while
     * the log told the operator to go and apply a migration that was already
     * applied. Two different faults, one message, and the diagnostic pointed at
     * the wrong one.
     *
     * PGRST205/204 and 42P01 are PostgREST's "relation not found" and Postgres'
     * undefined_table respectively; the two differ by which layer noticed.
     */
    const missingTable =
      error.code === 'PGRST205' || error.code === 'PGRST204' || error.code === '42P01';

    console.error(`[reports] insert failed [${error.code}]:`, error.message);

    if (missingTable) {
      console.error('[reports] the reports table is missing. Run migration 004.');
      throw new Error('Reporting is unavailable right now. Please try again later.');
    }

    // Anything else — including an RLS denial — is a genuine server-side fault,
    // so it is reported verbatim to the operator and generically to the user.
    throw new Error('Reporting is unavailable right now. Please try again later.');
  }

  return { ok: true };
}

/**
 * Whether the current user has already reported something.
 *
 * Read-only, and used so the button can say "Reported" instead of inviting a
 * duplicate that the unique index would silently discard.
 *
 * Rate limited because this is a `'use server'` export, so it is a public POST
 * endpoint, and it runs on every dialog open. Unthrottled, each call costs one
 * `auth.getUser()` round trip — a cheap way to make the auth server do work on
 * demand.
 */
export async function getExistingReports(contentId: unknown): Promise<ReportableType[]> {
  const id = validateUuid(contentId, 'content id');

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  await enforce(await callerKey('reports:read', user.id), 60, 60_000);

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