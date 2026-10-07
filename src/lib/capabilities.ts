import { createClient } from '@/lib/supabase';
import type { Database } from '@/lib/database.types';

/**
 * Runtime capability detection.
 *
 * New optional features (playtime, favourites, log comments, badge columns)
 * require schema artefacts that a database predating migration 002 does not
 * have. Rather than hard-failing every query, we probe once per server instance
 * and cache the result. The UI hides features the database cannot support, and
 * writes simply omit the unsupported columns.
 *
 * Run `supabase/migrations/002_fixes_and_features.sql` and
 * `003_verify_and_harden.sql` to enable the full feature set.
 */

export type Capabilities = {
  logPlaytime: boolean;
  logFavorite: boolean;
  logSpoiler: boolean;
  profileFields: boolean;
  reviewed: boolean;
  /** Comment threads. Requires the `comments` table from 002. */
  comments: boolean;
};

const DEFAULT_CAPABILITIES: Capabilities = {
  logPlaytime: false,
  logFavorite: false,
  logSpoiler: false,
  profileFields: false,
  reviewed: false,
  comments: false,
};

const ALL_CAPABILITIES: Capabilities = {
  logPlaytime: true,
  logFavorite: true,
  logSpoiler: true,
  profileFields: true,
  reviewed: true,
  comments: true,
};

let cached: Capabilities | null = null;
let cachedAt = 0;
let inflight: Promise<Capabilities> | null = null;

/**
 * How long a conclusive answer is reused.
 *
 * Even a successful probe was previously cached for the entire lifetime of the
 * instance, so applying the migration required a redeploy. And a *failed* probe
 * was cached too, which is the real bug: a single 5xx or network blip silently
 * disabled playtime, favourites and spoilers for the whole process.
 */
const TTL_MS = 5 * 60_000;

type TableName = keyof Database['public']['Tables'];

type ProbeTarget = { table: TableName; column?: string };

/**
 * What to probe — and why not what the previous version probed.
 *
 * The old probe selected `playtime_hours, is_favorite, has_spoilers`, but all
 * three are created by `001_init.sql`, not `002`. On a correctly-migrated
 * database that probe therefore always succeeded and always returned
 * all-true, which made the whole degradation mechanism dead code: the flags it
 * gated could never be anything but on, and a pre-002 database silently
 * pretended to be fully featured.
 *
 * Each target below is an artefact a *later* migration creates, so its absence
 * genuinely distinguishes an unmigrated database. Probing several means one
 * missing artefact does not disable everything.
 */
const PROBES: ProbeTarget[] = [
  { table: 'comments' },
  { table: 'lists', column: 'kind' },
  { table: 'game_logs', column: 'has_spoilers' },
];

/**
 * Distinguishes "this schema artefact is genuinely absent" from "the query
 * failed for an unrelated reason".
 *
 * The distinction matters enormously: the first is a cacheable, permanent fact
 * about the database, the second is a transient condition that must not be
 * cached. Conflating them is what made one network blip disable features until
 * the next deploy.
 *
 * PostgREST reports a missing relation as PGRST205 and a missing column as
 * PGRST204 / `42703`; Supabase's own errors surface as `does not exist`. Matching
 * on the *shape* rather than one exact message keeps this working across error
 * sources.
 */
function looksLikeMissingRelation(message: string, target: ProbeTarget): boolean {
  const m = (message ?? '').toLowerCase();
  const mentionsTarget =
    m.includes(target.table.toLowerCase()) ||
    (target.column ? m.includes(target.column.toLowerCase()) : false);

  return (
    m.includes('pgrst205') ||
    m.includes('pgrst204') ||
    m.includes('42703') ||
    (m.includes('does not exist') && mentionsTarget) ||
    (m.includes('could not find the table') && mentionsTarget) ||
    (m.includes('schema cache') && mentionsTarget)
  );
}

async function probe(): Promise<Capabilities> {
  let supabase;
  try {
    supabase = await createClient();
  } catch (err) {
    // `createClient()` calls `getSupabaseConfig()`, which throws *synchronously*
    // when the environment is unconfigured. `saveGameLog` and `updateGameLog`
    // await this unguarded, so without the catch a missing env var turned every
    // attempt to log a game into an unhandled throw rather than the readable
    // "Missing required environment variable" message.
    console.error('[capabilities] could not construct a client:', (err as Error).message);
    return { ...DEFAULT_CAPABILITIES };
  }

  for (const target of PROBES) {
    try {
      const { error } = await supabase
        .from(target.table)
        .select(target.column ?? '*')
        .limit(1);

      if (!error) return { ...ALL_CAPABILITIES };

      if (!looksLikeMissingRelation(error.message, target)) {
        // A 5xx, a statement timeout, a pooler hiccup — says nothing about the
        // schema. Degrade for this request only and let the next call retry.
        console.error(
          `[capabilities] probe of ${target.table} failed, will retry next request:`,
          error.message
        );
        return { ...DEFAULT_CAPABILITIES };
      }
      // Genuinely absent — fall through to the next probe.
    } catch (err) {
      console.error(
        `[capabilities] probe of ${target.table} threw, will retry next request:`,
        (err as Error).message
      );
      return { ...DEFAULT_CAPABILITIES };
    }
  }

  // Every probe target is absent: a pre-002 database. This IS cacheable — it is
  // a property of the database, not of the request — and the TTL means applying
  // the migration is picked up within five minutes without a redeploy.
  return { ...DEFAULT_CAPABILITIES };
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