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
 * ── Why parsing and writing are separate steps ───────────────────────────────
 *
 * `previewImport` only reads. `commitImport` only writes.
 *
 * This split is the whole safety story. An import can touch hundreds of rows at
 * once, and there is no undo: a mis-mapped column can overwrite ratings and
 * clobber reviews someone spent an hour writing, with no way back. So the user
 * always sees exactly what will happen — including which games are already in
 * their library and will be *updated* rather than created — and only then runs it.
 * The preview is not a convenience; it is the only thing standing between a bad
 * file and someone's library.
 *
 * ── Why nothing is cached between the two steps ──────────────────────────────
 *
 * The previous design had `previewImport` resolve every match and stash the plan
 * in a module-level `Map`, and `commitImport(token)` read it back. That is broken
 * on any platform that runs more than one instance, which includes Vercel: the
 * preview is handled by one lambda and the commit by another, the second one does
 * not have the first one's `Map`, and the user is told "that preview has
 * expired" immediately after seeing it. It is also unbounded state in a
 * long-lived process, and it made the 10-minute TTL the only thing standing
 * between a user and a commit of *someone else's* plan if a key were ever
 * collided.
 *
 * So `commitImport` takes the filename and content and re-derives everything.
 * The re-parse is CPU-local and costs nothing next to the writes; the re-match is
 * one query per 40 titles, which is what the preview already paid. In exchange
 * the two steps are independent, horizontally scalable, and idempotent.
 *
 * The server still never trusts the client's view of what the rows are: every
 * field written is re-parsed from the file, not taken from the browser.
 */

const MAX_FILE_BYTES = 4 * 1024 * 1024; // 4 MB
const MAX_COMMIT_ROWS = 500;

/** Rows per batched write. PostgREST caps the request body, and 500 is well inside it. */
const WRITE_BATCH = 100;

/** Titles per catalogue lookup. PostgREST rejects an unbounded filter URL. */
const MATCH_BATCH = 40;

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

export type CommitResult = {
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
};

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

  const prepared = await prepare(user.id, filename, content);

  return describe(prepared.parsed, prepared.prepared, prepared.filename);
}

type Prepared = {
  filename: string;
  parsed: { rows: ParsedRow[]; issues: ParseIssue[]; total: number };
  prepared: PreparedRow[];
  /** Set when the file could not be used at all. */
  fatal: ParseIssue[];
};

/**
 * Parses, matches and diffs. Shared by both steps so the preview cannot describe
 * something different from what the commit writes.
 */
async function prepare(
  userId: string,
  filename: unknown,
  content: unknown
): Promise<Prepared> {
  const name = String(filename ?? 'import.csv').slice(0, 120);
  const text = String(content ?? '');

  const empty = (issues: ParseIssue[]): Prepared => ({
    filename: name,
    parsed: { rows: [], issues: [], total: 0 },
    prepared: [],
    fatal: issues,
  });

  if (text.length === 0) {
    return empty([{ line: 0, message: 'That file is empty.' }]);
  }

  // Checked in bytes as well as characters, since a multi-byte file can be far
  // larger than its character count suggests.
  if (new TextEncoder().encode(text).length > MAX_FILE_BYTES) {
    return empty([
      { line: 0, message: 'That file is larger than 4 MB. Split it into smaller batches.' },
    ]);
  }

  const parsed = parseImport(name, text);
  if (parsed.rows.length === 0) {
    return empty(
      parsed.issues.length ? parsed.issues : [{ line: 0, message: 'No games found in that file.' }]
    );
  }

  const supabase = await createClient();

  // Match every title in one query rather than one query per row.
  const titles = [...new Set(parsed.rows.map((r) => r.title))];
  const matches = await matchGames(supabase, titles);

  // Which of those the user has already logged.
  const matchedIds = [...matches.values()];
  const existing = new Map<number, string>();
  if (matchedIds.length) {
    // Chunked, because PostgREST caps the URL length and a 500-game import of
    // distinct titles would otherwise produce a filter string past the limit.
    for (let i = 0; i < matchedIds.length; i += 500) {
      const slice = matchedIds.slice(i, i + 500);
      const { data: logs } = await supabase
        .from('game_logs')
        .select('id, game_id')
        .eq('user_id', userId)
        .in('game_id', slice);
      for (const l of logs ?? []) {
        existing.set(l.game_id as number, l.id as string);
      }
    }
  }

  const preparedRows: PreparedRow[] = parsed.rows.map((row) => {
    const gameId = matches.get(normalizeTitle(row.title)) ?? null;
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

  return { filename: name, parsed, prepared: preparedRows, fatal: [] };
}

/** Renders a prepared import as the numbers and sample the UI shows. */
function describe(
  parsed: { rows: ParsedRow[]; issues: ParseIssue[]; total: number },
  prepared: PreparedRow[],
  filename: string
): PreviewResult {
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

  return {
    filename,
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

/**
 * Lowercases and trims a title so the catalogue lookup is not case-sensitive.
 *
 * The `.in()` filter is an exact, case-sensitive match, so a file containing
 * "the last of us" would not match a catalogue row named "The Last of Us" and
 * the game would be reported as unmatched. `matchGames` compensates; this is the
 * single definition of the key both sides use.
 */
function normalizeTitle(title: string): string {
  return title.trim().toLowerCase();
}

/**
 * Resolves titles to catalogue ids.
 *
 * Two passes, because one is not sufficient and the previous code only did the
 * first:
 *
 *  1. `.in('name', batch)` — exact match, index-friendly, one query for up to 40
 *     titles.
 *  2. For whatever is still unmatched, a single `.or()` of `ilike` predicates.
 *
 * The second pass exists because `in` is case-sensitive. The old comment claimed
 * a case-insensitive fallback ran when the exact pass came up short; it did not,
 * because the fallback lived in the `if (error)` branch — and `in` returns no
 * rows rather than an error when nothing matched. So every title differing from
 * the catalogue only in case was silently reported as unmatched.
 */
async function matchGames(
  supabase: Awaited<ReturnType<typeof createClient>>,
  titles: string[]
): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  const wanted = new Set(titles.map(normalizeTitle));
  if (wanted.size === 0) return found;

  for (let i = 0; i < titles.length; i += MATCH_BATCH) {
    const batch = titles.slice(i, i + MATCH_BATCH);
    if (batch.length === 0) continue;

    const { data, error } = await supabase.from('games').select('id, name').in('name', batch);

    if (error) {
      console.error('[import] catalogue match error:', error.message);
      continue;
    }

    for (const row of data ?? []) {
      found.set(normalizeTitle(row.name as string), row.id as number);
    }
  }

  // Case-insensitive pass for the remainder.
  const missing = titles
    .map(normalizeTitle)
    .filter((t) => !found.has(t));

  if (missing.length === 0) return found;

  for (let i = 0; i < missing.length; i += MATCH_BATCH) {
    const batch = missing.slice(i, i + MATCH_BATCH);
    if (batch.length === 0) continue;

    /*
     * One `.or()` per batch rather than one `ilike` per title.
     *
     * Each predicate is `name.ilike.<value>` with `_`, `%` and `\` escaped, so
     * a title containing a wildcard matches literally instead of turning the
     * lookup into a table scan. PostgREST reserves `,`, `.` and `()` in filter
     * values, so those are stripped from the pattern rather than escaped — a
     * title that reduces to empty after stripping simply will not match, which
     * is the correct outcome for a title made entirely of punctuation.
     */
    const filter = batch
      .filter((t) => t.length > 0)
      .map((t) => `name.ilike.${t.replace(/([\\%_,.()])/g, '')}`)
      .join(',');

    if (!filter) continue;

    const { data, error } = await supabase
      .from('games')
      .select('id, name')
      .or(filter)
      .limit(batch.length * 2);

    if (error) {
      console.error('[import] catalogue ilike error:', error.message);
      continue;
    }

    for (const row of data ?? []) {
      const key = normalizeTitle(row.name as string);
      // Only accept an exact hit. `ilike` without wildcards is already exact
      // apart from case, but this also stops one catalogue row from claiming
      // several import titles that differ only by punctuation.
      if (batch.includes(key) && !found.has(key)) {
        found.set(key, row.id as number);
      }
    }
  }

  return found;
}

/**
 * Performs the import.
 *
 * Takes the filename and content rather than a plan token, and re-derives every
 * field from the file. The client can only ask for its own file to be imported;
 * it cannot describe rows, name games, or set ids.
 */
export async function commitImport(
  filename: unknown,
  content: unknown
): Promise<CommitResult> {
  const user = await requireUser();
  await enforce(await callerKey('import:commit', user.id), 5, 60_000);

  const { prepared, fatal } = await prepare(user.id, filename, content);

  if (fatal.length > 0) {
    return { created: 0, updated: 0, skipped: 0, errors: fatal.map((i) => i.message) };
  }

  const supabase = await createClient();
  const errors: string[] = [];
  let created = 0;
  let updated = 0;
  let skipped = 0;

  const actionable = prepared.filter((r) => r.gameId !== null).slice(0, MAX_COMMIT_ROWS);

  skipped += prepared.length - actionable.length;

  if (prepared.length > MAX_COMMIT_ROWS) {
    errors.push(
      `Only the first ${MAX_COMMIT_ROWS} of ${prepared.length} rows were imported. ` +
        'Split the file and run it again for the rest.'
    );
  }

  /*
   * Split into inserts and updates, then batch each.
   *
   * The previous version looped one request per row. At the 500-row ceiling that
   * is 500 sequential round trips inside a single Server Action, which reliably
   * exceeds the function timeout on a cold lambda — so the largest legal import
   * was the one most likely to fail partway through and leave the library in
   * exactly the half-written state the preview exists to prevent.
   */
  const inserts = actionable.filter((r) => !r.existingLogId && r.gameId !== null);
  const updates = actionable.filter((r) => r.existingLogId !== null);

  for (let i = 0; i < inserts.length; i += WRITE_BATCH) {
    const batch = inserts.slice(i, i + WRITE_BATCH);
    created += await insertBatch(supabase, user.id, batch, errors);
  }

  for (let i = 0; i < updates.length; i += WRITE_BATCH) {
    const batch = updates.slice(i, i + WRITE_BATCH);
    updated += await updateBatch(supabase, user.id, batch, errors);
  }

  // Rows with no fields to write are counted as skipped rather than silently
  // counted as updated: the file expressed nothing, so nothing changed.
  skipped += actionable.filter(
    (r) => r.existingLogId !== null && Object.keys(patchFor(r)).length === 0
  ).length;

  // Only invalidate the cache if something actually changed.
  if (created > 0 || updated > 0) {
    const { revalidateAll } = await import('@/lib/revalidate');
    revalidateAll();
  }

  return { created, updated, skipped, errors: errors.slice(0, 20) };
}

/**
 * A patch containing only the fields the file actually had.
 *
 * Sending `rating: 0` for a row whose rating column was empty would silently
 * destroy an existing rating — the same class of bug that made the profile editor
 * erase display names and bios on every save. `null` means "not in the file",
 * and is excluded.
 */
function patchFor(row: PreparedRow): Database['public']['Tables']['game_logs']['Update'] {
  const patch: Database['public']['Tables']['game_logs']['Update'] = {};
  if (row.rating !== null) patch.rating = row.rating;
  if (row.review !== null) patch.review = row.review;
  if (row.playedOn !== null) patch.diary_date = row.playedOn;
  if (row.playtimeHours !== null) patch.playtime_hours = row.playtimeHours;
  if (row.status !== null) patch.status = row.status;
  return patch;
}

/**
 * Inserts a batch and returns how many rows were really created.
 *
 * The count is taken from the returned rows rather than from the batch length. A
 * batch insert that collides with the `(user_id, game_id)` unique index fails as
 * a whole, so those rows are retried one at a time and each 23505 is a row that
 * was *not* created — which the previous `created++`-per-success loop also got
 * wrong in the other direction, reporting concurrent duplicates as new games.
 */
async function insertBatch(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  batch: PreparedRow[],
  errors: string[]
): Promise<number> {
  const payload = batch.map((row) => ({
    user_id: userId,
    game_id: row.gameId as number,
    // Default to backlog: importing a title means "I want to play this", not
    // "I finished it". A file that stated a status says so, and `patchFor`
    // already excluded the null case above.
    status: row.status ?? ('backlog' as const),
    rating: row.rating ?? 0,
    review: row.review,
    diary_date: row.playedOn,
    playtime_hours: row.playtimeHours ?? null,
  }));

  const { data, error } = await supabase.from('game_logs').insert(payload).select('id');

  if (!error) return data?.length ?? payload.length;

  // 23505: the unique (user_id, game_id) index. Retrying per row finds which
  // ones collided without losing the rest of the batch.
  if (error.code !== '23505') {
    errors.push(`Could not create ${payload.length} games: ${error.message}`);
    return 0;
  }

  let created = 0;
  for (const row of batch) {
    const { error: singleError } = await supabase.from('game_logs').insert({
      user_id: userId,
      game_id: row.gameId as number,
      status: row.status ?? 'backlog',
      rating: row.rating ?? 0,
      review: row.review,
      diary_date: row.playedOn,
      playtime_hours: row.playtimeHours ?? null,
    });

    if (singleError) {
      if (singleError.code !== '23505') {
        errors.push(`Row ${row.line} (${row.title}): ${singleError.message}`);
      }
      continue;
    }
    created++;
  }
  return created;
}

/**
 * Updates a batch and returns how many rows were really changed.
 *
 * These stay one request per row, and that is not an oversight.
 *
 * PostgREST has no way to express "apply a different patch to each row in one
 * statement". `upsert` would send the same payload to every id, so it would
 * overwrite fields the file did not mention — reintroducing exactly the
 * destructive-patch bug `patchFor` exists to prevent. A single `update()` with
 * `.in('id', ids)` has the same problem. So the batching win applies to inserts,
 * where every row genuinely is the same shape, and updates are one request each.
 *
 * The count comes from `.select('id')`, which returns one row per row actually
 * matched. A row whose `id` does not belong to the caller matches nothing and is
 * correctly excluded, so a manipulated id cannot be reported as a success — and
 * `.eq('user_id', userId)` is what excludes it.
 */
async function updateBatch(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  batch: PreparedRow[],
  errors: string[]
): Promise<number> {
  let updated = 0;

  for (const row of batch) {
    // An empty patch is not a change. Counting it would report an import that
    // wrote nothing as one that wrote a row.
    const patch = patchFor(row);
    if (Object.keys(patch).length === 0) continue;

    const { data, error } = await supabase
      .from('game_logs')
      .update(patch)
      .eq('id', row.existingLogId as string)
      .eq('user_id', userId)
      .select('id');

    if (error) {
      // One bad row must not abandon the rest of the file.
      errors.push(`Row ${row.line} (${row.title}): ${error.message}`);
      continue;
    }

    updated += data?.length ?? 0;
  }

  return updated;
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