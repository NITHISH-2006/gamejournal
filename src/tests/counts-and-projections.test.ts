import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exactCount } from '@/lib/count';

/**
 * Regression tests for the failure mode that broke this project twice.
 *
 * ── The bug ────────────────────────────────────────────────────────────────
 *
 * `follows` was keyed `(follower_id, following_id)` with **no `id` column**,
 * while the application addressed it by `id`:
 *
 *     .from('follows').select('id')        -> PGRST204, column not found
 *
 * The code destructured only `{ data }` and discarded the error, so the result
 * was `null`, the toggle always took the INSERT branch, and:
 *
 *   - the first click worked
 *   - the second click hit `duplicate key ... follows_pkey` and threw
 *   - **unfollow was impossible**
 *   - `getFollowCounts` used the same invalid read, so **every follower and
 *     following number on every profile rendered as 0**
 *
 * It was then *reintroduced* by the fix written to prevent it, because the
 * "does this row already exist?" read above the delete still selected `id`. That
 * regression passed `tsc`, `eslint`, `next build` and every route check, and was
 * caught only by an audit pass.
 *
 * ── Why a test is the only thing that reliably catches it ──────────────────
 *
 * Both times, the failure was a *silent wrong answer*, not a crash. There was no
 * error to surface, no red screen, and no failing check. Every static analysis
 * was green because the Supabase clients were untyped, so
 * `.select('this_column_does_not_exist')` was valid TypeScript.
 *
 * Two invariants are asserted below, and together they cover the whole class:
 *
 *   1. **Never name a column in a count projection.** `exactCount` passes `'*'`,
 *      which cannot fail for a missing column. Asserted structurally, because the
 *      original bug was reintroduced precisely because nobody could see it.
 *   2. **A failed count must be reported, not silently coerced to 0.** The
 *      `count ?? 0` pattern turned a database error into a confident zero, which
 *      is indistinguishable from "nobody follows this person".
 */

describe('exactCount', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('selects "*" so it can never fail for a missing column', async () => {
    // This is the whole point of the helper. `'*'` is the only projection that is
    // valid for every table, so it cannot reintroduce the `select('id')` class of
    // bug — on `follows` and `log_likes` before migration 002, on any table.
    let received = '';
    const builder = (sel: string) => {
      received = sel;
      return Promise.resolve({ count: 7, error: null });
    };

    const result = await exactCount(builder, 'test.projection');

    expect(received).toBe('*');
    expect(result).toBe(7);
  });

  it('returns the exact count on success', async () => {
    const result = await exactCount(
      () => Promise.resolve({ count: 42, error: null }),
      'test.ok'
    );
    expect(result).toBe(42);
  });

  it('returns 0 and LOGS when the count fails, rather than a silent zero', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await exactCount(
      () => Promise.resolve({ count: null, error: { message: 'permission denied' } }),
      'test.denied'
    );

    expect(result).toBe(0);
    // The log line is the only way anyone finds out the number is a fallback.
    // Without it, "broken query" and "genuinely nobody" look identical in the UI.
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0][0])).toContain('test.denied');
    expect(String(spy.mock.calls[0][0])).toContain('permission denied');
  });

  /**
   * PostgREST returns an **empty** error message for several error classes,
   * including a missing column. A log line reading `[follows] follower count
   * error:` with nothing after the colon is the exact symptom of the original
   * bug, and it is useless without a fallback.
   */
  it('produces a useful log line even when the error message is empty', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await exactCount(
      () => Promise.resolve({ count: null, error: { message: '' } }),
      'follows.empty'
    );

    expect(String(spy.mock.calls[0][0])).toContain('empty error message');
  });

  it('treats a null count with no error as 0', async () => {
    const result = await exactCount(
      () => Promise.resolve({ count: null, error: null }),
      'test.null'
    );
    expect(result).toBe(0);
  });
});

/**
 * Structural guard.
 *
 * A test asserting a *value* would have to mock a database. This asserts the
 * shape of the code itself, which is what actually failed: the projection string
 * is read out of the source file and checked for the column names that were the
 * subject of the bug.
 *
 * It is deliberately a source-level check. The alternative — trusting a reviewer
 * to notice — is exactly how the same bug was reintroduced.
 */
describe('join-table projections (source-level guard)', () => {
  const readFile = (p: string) =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('node:fs').readFileSync(p, 'utf8') as string;

  const sources = [
    'src/app/actions/follows.ts',
    'src/app/actions/likes.ts',
    'src/app/actions/discover.ts',
    'src/app/actions/notifications.ts',
  ];

  it('never selects a bare id from follows or log_likes', () => {
    for (const file of sources) {
      const src = readFile(file);

      // `.from('follows')` / `.from('log_likes')` followed closely by
      // `.select('id')` or `.select('id', {`.
      const offenders: string[] = [];
      const lines = src.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!/\.from\('(follows|log_likes)'\)/.test(lines[i])) continue;
        // Look at this line and the next two, since `.from()` and `.select()`
        // are usually on consecutive lines.
        const window = lines.slice(i, i + 3).join('\n');
        if (/\.select\(\s*'id'\s*[,)]/.test(window)) {
          offenders.push(`${file}:${i + 1} -> ${lines[i].trim()}`);
        }
      }

      expect(
        offenders,
        `select('id') against a table that has no id column:\n${offenders.join('\n')}`
      ).toEqual([]);
    }
  });

  it('deletes follows and likes by composite key, not by id', () => {
    const follows = readFile('src/app/actions/follows.ts');
    const likes = readFile('src/app/actions/likes.ts');

    // Both must delete by their real key so the toggle works whether or not the
    // surrogate `id` from migration 002 exists yet.
    expect(follows).toMatch(/\.eq\('follower_id'/);
    expect(follows).toMatch(/\.eq\('following_id'/);
    expect(likes).toMatch(/\.eq\('user_id'/);
    expect(likes).toMatch(/\.eq\('log_id'/);
  });

  it('does not hand-roll a count projection outside exactCount', () => {
    // Every count must go through `exactCount`, which uses '*' and checks the
    // error. A hand-rolled `select('x', { count, head: true })` is how the
    // silent-zero pattern creeps back in.
    for (const file of sources) {
      const lines = readFile(file).split('\n');
      const offenders: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        if (!/count:\s*'exact'/.test(lines[i])) continue;
        if (lines[i].trim().startsWith('//') || lines[i].trim().startsWith('*')) continue;

        // `exactCount((sel) => … .select(sel, { count: 'exact' …` is formatted
        // over several lines, with the parameter name three or four lines above
        // the count, so the preceding four lines are inspected.
        const window = lines.slice(Math.max(0, i - 4), i + 1).join('\n');
        const insideExactCount = /\(\s*(sel|select)\s*\)\s*=>/.test(window);

        if (!insideExactCount) offenders.push(`${file}:${i + 1} -> ${lines[i].trim()}`);
      }

      expect(
        offenders,
        `hand-rolled count projection (should use exactCount):\n${offenders.join('\n')}`
      ).toEqual([]);
    }
  });
});