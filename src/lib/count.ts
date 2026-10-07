/**
 * Row counting that does not depend on a particular column existing.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * The obvious way to count with supabase-js is:
 *
 *     supabase.from('follows').select('id', { count: 'exact', head: true })
 *
 * `head: true` means no rows come back, so the column you name is only ever
 * used by PostgREST to validate the projection. Naming a column that does not
 * exist makes the *entire request* fail with `42703`, and the failure is
 * especially hard to read: PostgREST returns a null `count` and an error whose
 * `message` is an empty string, so the code silently fell back to `0`.
 *
 * That is not hypothetical. `follows` and `log_likes` are keyed on composite
 * primary keys — `(follower_id, following_id)` and `(user_id, log_id)` — and
 * have never had an `id` column. So every follower count and every like count
 * in the app was reporting 0 against a database that had real rows, and the
 * only evidence was a log line reading `[follows] follower count error: ` with
 * nothing after the colon.
 *
 * Selecting `'*'` cannot fail this way: the star projection is always valid.
 * The count still comes back from the `Content-Range` header, so nothing is
 * transferred.
 */

/** The slice of a PostgREST response this helper needs. */
type CountResult = {
  count: number | null;
  error: { message: string } | null;
};

/** A query builder, so the filter chain stays at the call site. */
type CountBuilder = (select: string) => PromiseLike<CountResult>;

/**
 * Counts rows matching an already-filtered query.
 *
 * @param build   Receives the projection to use. Pass your filters here:
 *                `(sel) => supabase.from('follows').select(sel, { count: 'exact', head: true }).eq('following_id', id)`
 * @param label   Used in the log line if the count fails.
 * @returns The exact count, or 0 if the query failed.
 */
export async function exactCount(build: CountBuilder, label: string): Promise<number> {
  const { count, error } = await build('*');

  if (error) {
    // PostgREST returns an empty message for several error classes, so the
    // fallback text is there to make the log line itself useful.
    console.error(`[count] ${label}: ${error.message || '(empty error message)'}`);
    return 0;
  }

  return count ?? 0;
}
