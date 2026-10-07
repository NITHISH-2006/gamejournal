'use server';

import { createClient, requireUser } from '@/lib/supabase';
import { validateUuid } from '@/lib/validation';
import { enforce } from '@/lib/rate-limit';
import { callerKey } from '@/lib/limiter';
import { revalidateLogPaths } from '@/lib/revalidate';

/**
 * Play sessions — one row per sitting.
 *
 * `game_logs.playtime_hours` is a single running total. It cannot answer the
 * questions a player actually asks: when did I last play, how long was that
 * session, do I play more on weekends, was that a marathon or an hour. A row per
 * sitting can answer all of them, and `playtime_hours` is kept in step as a
 * denormalised total so the existing leaderboards and stats keep working.
 *
 * Migration 004 owns the table, its RLS and the indexes.
 */

export type PlaySession = {
  id: string;
  logId: string;
  playedOn: string;
  hours: number;
  platform: string | null;
  note: string | null;
};

/**
 * A session is capped at 24 hours.
 *
 * Matches the `play_sessions_hours_check` constraint. The bound is here as well
 * so the user gets a useful message instead of a raw constraint violation.
 */
const MAX_SESSION_HOURS = 24;
const MIN_SESSION_HOURS = 0.25;

function parseHours(value: unknown): number {
  const hours = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(hours)) {
    throw new Error('Enter how long you played for.');
  }
  const rounded = Math.round(hours * 100) / 100;
  if (rounded < MIN_SESSION_HOURS || rounded > MAX_SESSION_HOURS) {
    throw new Error(
      `Session length must be between ${MIN_SESSION_HOURS} and ${MAX_SESSION_HOURS} hours.`
    );
  }
  return rounded;
}

/**
 * Accepts `YYYY-MM-DD`, and rejects anything else.
 *
 * Not `new Date(value)`: that happily interprets `'March 3rd'` and
 * `'2026-13-45'` as *some* instant, so a typo becomes a real session on the
 * wrong day rather than a validation error.
 */
function parseDate(value: unknown, fallbackToToday: boolean): string {
  if (value === undefined || value === null || value === '') {
    if (!fallbackToToday) throw new Error('Choose a date for this session.');
    return new Date().toISOString().slice(0, 10);
  }

  const raw = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error('That date is not valid.');
  }
  // Round-trip through Date to reject 2026-02-31, which matches the shape but
  // is not a real day.
  const parsed = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    throw new Error('That date is not valid.');
  }

  // A future session is a typo, not a prediction.
  const today = new Date().toISOString().slice(0, 10);
  if (raw > today) throw new Error('You cannot log a session in the future.');

  return raw;
}

/** Confirms the caller owns the log. Returns the log's game for revalidation. */
async function assertOwnsLog(
  logId: string,
  userId: string
): Promise<{ gameId: number }> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('game_logs')
    .select('id, game_id')
    .eq('id', logId)
    .eq('user_id', userId)
    .maybeSingle();

  // A failed read is not evidence that the row is missing, and must not fall
  // through to a write — that is the shape of bug where a transient error
  // provokes an insert that then collides with the row it failed to read.
  if (error) {
    console.error('[sessions] ownership read error:', error.message);
    throw new Error('Could not check that log. Please try again.');
  }

  if (!data) {
    // Same message whether the log does not exist or belongs to someone else:
    // distinguishing them would let a caller probe for valid log ids.
    throw new Error('That log does not exist, or is not yours.');
  }

  return { gameId: data.game_id };
}

export async function addPlaySession(
  logId: unknown,
  input: { hours?: unknown; playedOn?: unknown; platform?: unknown; note?: unknown }
): Promise<{ id: string }> {
  const user = await requireUser();
  await enforce(await callerKey('session:write', user.id), 60, 60_000);

  const id = validateUuid(logId, 'log id');
  const hours = parseHours(input?.hours);
  const playedOn = parseDate(input?.playedOn, true);

  const platform = String(input?.platform ?? '').trim().slice(0, 40) || null;
  const note = String(input?.note ?? '').trim().slice(0, 280) || null;

  const { gameId } = await assertOwnsLog(id, user.id);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('play_sessions')
    .insert({ log_id: id, user_id: user.id, hours, played_on: playedOn, platform, note })
    .select('id')
    .single();

  if (error) throw new Error(error.message);

  // Keep the denormalised total in step. `playtime_hours` is read by the game
  // stats RPC, the profile dashboard and the leaderboard transfer, so leaving it
  // stale after a session write would make the three disagree.
  await resyncPlaytime(id, user.id);

  revalidateLogPaths(user.id, gameId);
  return { id: data.id };
}

export async function deletePlaySession(sessionId: unknown): Promise<void> {
  const user = await requireUser();
  await enforce(await callerKey('session:write', user.id), 60, 60_000);

  const id = validateUuid(sessionId, 'session id');
  const supabase = await createClient();

  // Ownership is enforced by the RLS policy as well as by this delete's own
  // filter. Both, deliberately: the policy is the guarantee, and the filter means
  // an unauthorised delete is a no-op rather than a policy error the user sees.
  const { data: session, error: readError } = await supabase
    .from('play_sessions')
    .select('id, log_id')
    .eq('id', id)
    .maybeSingle();

  if (readError) {
    console.error('[sessions] delete read error:', readError.message);
    throw new Error('Could not load that session. Please try again.');
  }
  if (!session) return;

  const { error } = await supabase
    .from('play_sessions')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id);

  if (error) throw new Error(error.message);

  const { gameId } = await assertOwnsLog(session.log_id as string, user.id);
  await resyncPlaytime(session.log_id as string, user.id);
  revalidateLogPaths(user.id, gameId);
}

/**
 * Recomputes `playtime_hours` from the session rows, in one statement.
 *
 * ── The bug ─────────────────────────────────────────────────────────────────
 *
 * This looked atomic and was not. It did three separate round trips:
 *
 *   1. `update({ playtime_hours: 0 })`          — zero the column
 *   2. `select('hours').eq('log_id', …)`       — read every session
 *   3. `update({ playtime_hours: total })`      — write the sum back
 *
 * Three round trips cannot be atomic, and step 1 made the damage worse than a
 * lost update. Any failure between them left the column at `0` — a fabricated
 * number, not a stale one — because step 1 committed before step 3 was attempted.
 * If step 2 failed on a network blip, the user's real playtime was simply gone.
 * And two sessions saved at once both read the same sessions, so the second
 * write overwrote the first with a total that excluded it.
 *
 * `sync_log_playtime` (migration 005) does the whole thing as one `UPDATE` with a
 * correlated aggregate, so there is no window in which the value is wrong. It is
 * `security invoker`, so the caller's own RLS applies, and it re-checks ownership
 * in SQL rather than trusting the `p_user_id` it is handed.
 */
async function resyncPlaytime(logId: string, userId: string): Promise<void> {
  const supabase = await createClient();

  const { error } = await supabase.rpc('sync_log_playtime', {
    p_log_id: logId,
    p_user_id: userId,
  });

  /*
   * A pre-005 database does not have the function.
   *
   * Failing here would surface as "could not save your session" after the
   * session row had already been written, so the caller would retry and produce
   * duplicates. The session itself is the source of truth and the stored total
   * is derived, so an unavailable RPC is logged and the write is left to the next
   * successful call — deliberately better than reporting a failure that did not
   * happen.
   */
  if (error) {
    console.error(
      '[sessions] sync_log_playtime unavailable, playtime total not refreshed:',
      error.message
    );
  }
}

/**
 * Every session for one log, newest first.
 *
 * Returns the rows *and* whether the query failed, because "this log has no
 * sessions" and "we could not ask" are different answers and the caller renders
 * them identically. The previous version returned `[]` on error, which the UI
 * then displayed as an empty state — so a failed read looked like a game nobody
 * had played.
 *
 * Public: logs are world-readable.
 */
export async function getSessionsForLog(
  logId: unknown
): Promise<{ sessions: PlaySession[]; error: string | null }> {
  const id = validateUuid(logId, 'log id');
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('play_sessions')
    .select('id, log_id, played_on, hours, platform, note')
    .eq('log_id', id)
    .order('played_on', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    console.error('[sessions] getSessionsForLog error:', error.message);
    // Distinguishable from an empty list by `error` being set.
    return { sessions: [], error: 'Could not load play sessions.' };
  }

  const sessions: PlaySession[] = (data ?? []).map((r) => ({
    id: r.id,
    logId: r.log_id,
    playedOn: r.played_on,
    hours: Number(r.hours ?? 0),
    platform: r.platform ?? null,
    note: r.note ?? null,
  }));

  return { sessions, error: null };
}