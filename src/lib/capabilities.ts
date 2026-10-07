import { createClient } from '@/lib/supabase';

/**
 * Runtime capability detection.
 *
 * New optional features (playtime, favourites, log comments, badge columns)
 * require columns that a freshly-cloned project may not have yet. Rather than
 * hard-failing every query, we probe once per server instance and cache the
 * result. The UI hides features the database cannot support, and writes simply
 * omit the unsupported columns.
 *
 * Run `supabase/migrations/001_init.sql` to enable the full feature set.
 */

export type Capabilities = {
  logPlaytime: boolean;
  logFavorite: boolean;
  logSpoiler: boolean;
  profileFields: boolean;
  reviewed: boolean;
};

const DEFAULT_CAPABILITIES: Capabilities = {
  logPlaytime: false,
  logFavorite: false,
  logSpoiler: false,
  profileFields: false,
  reviewed: false,
};

let cached: Capabilities | null = null;
let cachedAt = 0;
let inflight: Promise<Capabilities> | null = null;

/**
 * How long a conclusive answer is reused.
 *
 * Even a successful probe was previously cached for the entire lifetime of the
 * instance, so applying the migration required a redeploy. And a *failed*
 * probe was cached too, which is the real bug: a single 5xx or network blip
 * silently disabled playtime, favourites and spoilers for the whole process.
 */
const TTL_MS = 5 * 60_000;

function looksLikeMissingColumn(message: string, column: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('column') &&
    (m.includes('does not exist') || m.includes('unknown column')) &&
    m.includes(column.toLowerCase())
  );
}

async function probe(): Promise<Capabilities> {
  const supabase = await createClient();

  // Single cheap query: select a column that only exists in the enhanced schema.
  // A successful query means every enhanced column is present, because the
  // migration adds them together.
  const { error } = await supabase
    .from('game_logs')
    .select('id, playtime_hours, is_favorite, has_spoilers')
    .limit(1);

  if (!error) {
    return {
      logPlaytime: true,
      logFavorite: true,
      logSpoiler: true,
      profileFields: true,
      reviewed: true,
    };
  }

  const caps: Capabilities = { ...DEFAULT_CAPABILITIES };

  if (looksLikeMissingColumn(error.message, 'has_spoilers')) {
    // Enhanced schema absent — confirm the base schema still works.
    const { error: baseError } = await supabase
      .from('game_logs')
      .select('id, status, rating')
      .limit(1);
    if (baseError) {
      // Neither schema is present. Report nothing so the UI degrades and the
      // server logs point at the missing migration.
      console.error(
        '[capabilities] game_logs is missing the expected columns. Apply supabase/migrations/001_init.sql. ' +
          `Supabase said: ${baseError.message}`
      );
      return { ...DEFAULT_CAPABILITIES };
    }
  } else {
    // The probe failed for a reason that says nothing about the schema — a 5xx,
    // a statement timeout, a pooler hiccup. The previous code fell through to
    // DEFAULT_CAPABILITIES here, cached it permanently and logged nothing, so
    // one blip disabled the enhanced features for the life of the instance.
    // Degrade for this request only, and let the next call retry.
    console.error(
      '[capabilities] probe failed, will retry on next request:',
      error.message
    );
    return { ...DEFAULT_CAPABILITIES };
  }

  return caps;
}

/** Returns the cached capability set, probing on first use. */
export async function getCapabilities(): Promise<Capabilities> {
  if (cached && Date.now() - cachedAt < TTL_MS) return cached;
  inflight ??= probe()
    .then((caps) => {
      cached = caps;
      cachedAt = Date.now();
      return caps;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Test seam. */
export function __resetCapabilitiesCache(): void {
  cached = null;
  cachedAt = 0;
  inflight = null;
}
