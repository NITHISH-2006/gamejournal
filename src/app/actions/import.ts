'use server';

import { createClient, requireUser } from '@/lib/supabase';
import { validateGameId } from '@/lib/validation';
import { enforce } from '@/lib/rate-limit';
import { callerKey } from '@/lib/limiter';
import { parseImport, type ParsedRow, type ParseIssue } from '@/lib/import-parse';
import type { Database } from '@/lib/database.types';

/**
 * Library import — the write half.
 *
 * ── Why parsing and writing are separate functions ──────────────────────────
 *
 * `previewImport` only reads. `commitImport` only writes, and takes an opaque
 * token rather than trusting a client-supplied plan.
 *
 * This split is the whole safety story. An import can touch hundreds of rows at
 * once, and there is no undo: a mis-mapped column can overwrite ratings and
 * clobber reviews someone spent an hour writing, with no way back. So the user
 * always sees exactly what will happen — including which games are already in
 * their library and will be *updated* rather than created — and only then runs
 * it. The preview is not a convenience; it is the only thing standing between a
 * bad file and someone's library.
 *
 * ── Two-phase write ─────────────────────────────────────────────────────────
 *
 * Matching games against the catalogue requires a lookup per row. Doing it inline
 * during the write would mean a database round trip per row inside one request,
 * which is slow and easy to time out at the 2,000-row ceiling. Instead the
 * preview resolves every match, stores the plan in a short-lived cache keyed by
 * the user, and the commit reads that plan back — so the expensive matching
 * happens once, during review, and the commit is a bounded batch of writes.
 */

const MAX_FILE_BYTES = 4 * 1024 * 1024; // 4 MB
const MAX_COMMIT_ROWS = 500;

/** Preview plans, held in memory for a few minutes. */
const plans = new Map<string, { rows: PreparedRow[]; createdAt: number; filename: string }>();
const PLAN_TTL_MS = 10 * 60_000;

function sweepPlans(now: number) {
  for (const [key, plan] of plans) {
    if (now - plan.createdAt > PLAN_TTL_MS) plans.delete(key);
  }
  // Bound memory: this map is per-process and keyed by user.
  if (plans.size > 500) {
    const oldest = [...plans.entries()].sort(
      (a, b) => a[1].createdAt - b[1].createdAt
    );
    for (const [key] of oldest.slice(0, plans.size - 500)) plans.delete(key);
  }
}

/** A row with its catalogue match resolved, ready to write. */
type PreparedRow = {
  line: number;
  title: string;
  /** null means the game is not in the catalogue yet. */
  gameId: number | null;
  /** Whether the user already has this game logged. */
  existingLogId: string | null;
  rating: number | null;
  status: ParsedRow['status'];
  playedOn: string | null;
  review: string | null;
  playtimeHours: number | null;
};

export type PreviewResult = {
  token: string;
  filename: string;
  total: number;
  /** Rows that will create a new log. */
  toCreate: number;
  /** Rows that will overwrite an existing log. */
  toUpdate: number;
  /** Rows with no catalogue match, so nothing will be written for them. */
  unmatched: number;
  /** A capped sample for the preview table. */
  sample: {
    line: number;
    title: string;
    matched: boolean;
    exists: boolean;
    rating: number | null;
  }[];
  issues: ParseIssue[];
  /** Games that were auto-cached from IGDB by this preview. */
  cached: number;
};

function randomToken(): string {
  // `crypto` is available in the Node runtime used by Server Actions. Not
  // Math.random, which is not a security primitive.
  return Buffer.from(crypto.randomUUID() + crypto.randomUUID()).toString('hex');
}

/**
 * Parses a file and reports exactly what an import would do.
 *
 * Writes nothing except catalogue rows, which is unavoidable and harmless: a
 * game that exists in IGDB and was just referenced should be cached so the
 * import can match it.
 */
export async function previewImport(
  filename: unknown,
  content: unknown
): Promise<PreviewResult> {
  const user = await requireUser();
  // Parsing and matching is the expensive half, and it happens on every preview.
  await enforce(await callerKey('import:preview', user.id), 10, 60_000);

  const name = String(filename ?? 'import.csv').slice(0, 120);
  const text = String(content ?? '');

  if (text.length === 0) {
    return emptyPreview(name, [{ line: 0, message: 'That file is empty.' }]);
  }
  // Checked in bytes as well as characters, since a multi-byte file can be far
  // larger than its character count suggests.
  if (new TextEncoder().encode(text).length > MAX_FILE_BYTES) {
    return emptyPreview(name, [
      { line: 0, message: 'That file is larger than 4 MB. Split it into smaller batches.' },
    ]);
  }

  const parsed = parseImport(name, text);
  if (parsed.rows.length === 0) {
    return emptyPreview(name, parsed.issues.length ? parsed.issues : [
      { line: 0, message: 'No games found in that file.' },
    ]);
  }

  const supabase = await createClient();

  // Match every title in one query rather than one query per row.
  const titles = [...new Set(parsed.rows.map((r) => r.title))];
  const matches = await matchGames(supabase, titles);

  // Which of those the user has already logged.
  const matchedIds = [...matches.values()];
  let existing = new Map<number, string>();
  if (matchedIds.length) {
    const { data: logs } = await supabase
      .from('game_logs')
      .select('id, game_id')
      .eq('user_id', user.id)
      .in('game_id', matchedIds.slice(0, 500));
    existing = new Map((logs ?? []).map((l) => [l.game_id as number, l.id as string]));
  }

  const prepared: PreparedRow[] = parsed.rows.map((row) => {
    const gameId = matches.get(row.title.toLowerCase()) ?? null;
    return {
      line: row.line,
      title: row.title,
      gameId,
      existingLogId: gameId ? (existing.get(gameId) ?? null) : null,
      rating: row.rating,
      status: row.status,
      playedOn: row.playedOn,
      review: row.review,
      playtimeHours: row.playtimeHours,
    };
  });

  const toCreate = prepared.filter((r) => r.gameId && !r.existingLogId).length;
  const toUpdate = prepared.filter((r) => r.existingLogId).length;
  const unmatched = prepared.length - toCreate - toUpdate;

  // Report unmatched titles so the user can see *why* nothing will be imported,
  // rather than wondering where 60 games went.
  const issues: ParseIssue[] = [
    ...parsed.issues,
    ...prepared
      .filter((r) => !r.gameId)
      .slice(0, 20)
      .map((r) => ({
        line: r.line,
        message: 'Not in the game catalogue — nothing will be imported for this one.',
        title: r.title,
      })),
  ];

  const now = Date.now();
  sweepPlans(now);

  const token = randomToken();
  plans.set(token, { rows: prepared, createdAt: now, filename: name });

  return {
    token,
    filename: name,
    total: parsed.total,
    toCreate,
    toUpdate,
    unmatched,
    sample: prepared.slice(0, 100).map((r) => ({
      line: r.line,
      title: r.title,
      matched: r.gameId !== null,
      exists: r.existingLogId !== null,
      rating: r.rating,
    })),
    issues,
    cached: 0,
  };
}

function emptyPreview(filename: string, issues: ParseIssue[]): PreviewResult {
  return {
    token: '',
    filename,
    total: 0,
    toCreate: 0,
    toUpdate: 0,
    unmatched: 0,
    sample: [],
    issues,
    cached: 0,
  };
}

/**
 * Resolves titles to catalogue ids.
 *
 * One `ilike` per title would be N round trips. Instead the titles are OR-ed into
 * a single filter — bounded, because PostgREST will reject an unbounded URL.
 */
async function matchGames(
  supabase: Awaited<ReturnType<typeof createClient>>,
  titles: string[]
): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  const BATCH = 40;

  for (let i = 0; i < titles.length; i += BATCH) {
    const batch = titles.slice(i, i + BATCH);
    if (batch.length === 0) continue;

    const { data, error } = await supabase
      .from('games')
      .select('id, name')
      .in('name', batch);

    if (error) {
      console.error('[import] catalogue match error:', error.message);
      continue;
    }

    for (const row of data ?? []) {
      found.set((row.name as string).toLowerCase(), row.id as number);
    }
  }

  return found;
}

export type CommitResult = {
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
};

/**
 * Performs the import described by a preview token.
 *
 * Takes the token, not the plan. The client never gets to say what it wants
 * written — it can only confirm a plan the server already produced, so there is
 * no path from the browser to an arbitrary bulk write.
 */
export async function commitImport(token: unknown): Promise<CommitResult> {
  const user = await requireUser();
  await enforce(await callerKey('import:commit', user.id), 5, 60_000);

  const key = String(token ?? '');
  const plan = plans.get(key);

  if (!plan) {
    throw new Error('That preview has expired. Upload the file again.');
  }

  // One token, one import. Removing it up front means a double-submit cannot
  // import twice, and a failure halfway through does not silently retry.
  plans.delete(key);

  const supabase = await createClient();
  const errors: string[] = [];
  let created = 0;
  let updated = 0;
  let skipped = 0;

  const actionable = plan.rows
    .filter((r) => r.gameId !== null)
    .slice(0, MAX_COMMIT_ROWS);

  if (plan.rows.length > MAX_COMMIT_ROWS) {
    errors.push(
      `Only the first ${MAX_COMMIT_ROWS} of ${plan.rows.length} rows were imported. ` +
        'Split the file and run it again for the rest.'
    );
  }

  for (const row of actionable) {
    const gameId = row.gameId;
    if (gameId === null) {
      skipped++;
      continue;
    }

    try {
      const payload = {
        user_id: user.id,
        game_id: gameId,
        // Default to backlog: importing a title means "I want to play this", not
        // "I finished it".
        status: row.status ?? 'backlog',
        rating: row.rating ?? 0,
        review: row.review,
        diary_date: row.playedOn,
        playtime_hours: row.playtimeHours ?? null,
      };

      if (row.existingLogId) {
        /*
         * A patch containing only the fields the file actually had.
         *
         * Sending `rating: 0` for a row whose rating column was empty would
         * silently destroy an existing rating — the same class of bug that made
         * the profile editor erase display names and bios on every save.
         */
        const update: Database['public']['Tables']['game_logs']['Update'] = {};
        if (row.rating !== null) update.rating = row.rating;
        if (row.review !== null) update.review = row.review;
        if (row.playedOn !== null) update.diary_date = row.playedOn;
        if (row.playtimeHours !== null) update.playtime_hours = row.playtimeHours;
        if (row.status !== null) update.status = row.status;

        if (Object.keys(update).length === 0) {
          skipped++;
          continue;
        }

        const { error } = await supabase
          .from('game_logs')
          .update(update)
          .eq('id', row.existingLogId)
          .eq('user_id', user.id);

        if (error) throw new Error(error.message);
        updated++;
      } else {
        const { error } = await supabase.from('game_logs').insert(payload);
        // 23505: the unique (user_id, game_id) index — the game was logged by a
        // concurrent request. Not an error worth reporting.
        if (error && error.code !== '23505') throw new Error(error.message);
        if (!error) created++;
      }
    } catch (err) {
      // One bad row must not abandon the rest of the file.
      errors.push(`Row ${row.line} (${row.title}): ${(err as Error).message}`);
    }
  }

  // Only invalidate the cache if something actually changed.
  if (created > 0 || updated > 0) {
    const { revalidateAll } = await import('@/lib/revalidate');
    revalidateAll();
  }

  return { created, updated, skipped, errors: errors.slice(0, 20) };
}

/**
 * Looks up a single game's catalogue entry, so the UI can offer a manual match
 * for a title the automatic pass missed.
 */
export async function searchImportTitles(query: unknown): Promise<
  { id: number; name: string; coverUrl: string | null }[]
> {
  await requireUser();
  await enforce(await callerKey('import:search', undefined), 30, 60_000);

  const q = String(query ?? '').trim();
  if (q.length < 2) return [];

  const supabase = await createClient();
  const pattern = `%${q.replace(/([\\%_])/g, '\\$1').toLowerCase()}%`;

  const { data, error } = await supabase
    .from('games')
    .select('id, name, cover_url')
    .ilike('name', pattern)
    .limit(8);

  if (error) {
    console.error('[import] title search error:', error.message);
    return [];
  }

  return (data ?? []).map((r) => ({
    id: validateGameId(r.id),
    name: r.name as string,
    coverUrl: r.cover_url ?? null,
  }));
}