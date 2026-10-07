'use server';

import { createClient, requireUser } from '@/lib/supabase';
import { getIgdbConfig } from '@/lib/env';
import { enforce } from '@/lib/rate-limit';
import { callerKey } from '@/lib/limiter';
import { validateGamePayload } from '@/lib/validation';
import { GAME_SEARCH_UNAVAILABLE } from '@/lib/game-search-error';
import type { Game } from '@/lib/types';

/* -------------------------------------------------------------------------
   Twitch / IGDB access token
   ---------------------------------------------------------------------- */

// The unavailability sentinel lives in lib because a "use server" module may
// only export async functions.
let accessToken = '';
let tokenExpiresAt = 0;

type IgdbGame = {
  id: number;
  name: string;
  cover?: { url?: string } | null;
  first_release_date?: number | null;
  summary?: string | null;
  slug?: string | null;
};

function normaliseCover(url: string | undefined): string | null {
  if (!url) return null;
  // IGDB returns protocol-relative URLs and a thumbnail size we upscale.
  const absolute = url.startsWith('//') ? `https:${url}` : url;
  return absolute.replace('t_thumb', 't_cover_big');
}

async function getAccessToken(config: {
  clientId: string;
  clientSecret: string;
}): Promise<string> {
  if (accessToken && Date.now() < tokenExpiresAt) return accessToken;

  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'client_credentials',
    }),
    cache: 'no-store',
  });

  if (!res.ok) {
    throw new Error('Could not authenticate with IGDB.');
  }

  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };

  if (!data.access_token) throw new Error('IGDB returned no access token.');

  accessToken = data.access_token;
  // Refresh 60s early to avoid racing the expiry boundary.
  tokenExpiresAt = Date.now() + Math.max(60, (data.expires_in ?? 3600) - 60) * 1000;
  return accessToken;
}

async function queryIgdb(
  body: string,
  config: { clientId: string; clientSecret: string }
): Promise<IgdbGame[]> {
  const token = await getAccessToken(config);

  const res = await fetch('https://api.igdb.com/v4/games', {
    method: 'POST',
    headers: {
      'Client-ID': config.clientId,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'text/plain',
    },
    body,
    cache: 'no-store',
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error('[igdb] request failed:', res.status, detail.slice(0, 300));
    // Surface a friendly error rather than returning [] so the UI can tell
    // "nothing found" apart from "search is broken".
    throw new Error(
      res.status === 401 || res.status === 403
        ? 'Game search is temporarily unavailable. Please try again soon.'
        : 'Game search failed. Please try again.'
    );
  }

  const json = await res.json();
  return Array.isArray(json) ? (json as IgdbGame[]) : [];
}

function toRow(g: IgdbGame) {
  return {
    id: g.id,
    name: g.name,
    cover_url: normaliseCover(g.cover?.url),
    release_date: g.first_release_date
      ? new Date(g.first_release_date * 1000).toISOString().slice(0, 10)
      : null,
    summary: g.summary ?? null,
  };
}

/* -------------------------------------------------------------------------
   Public API
   ---------------------------------------------------------------------- */

/**
 * Searches for games.
 *
 * Behavioural fix: the old implementation returned the *first* cache hit and
 * never consulted IGDB, so a query like "witcher" could permanently return
 * only the one title already cached and hide every other match. Cached rows
 * are now merged with live IGDB results, and the cached rows for a query are
 * ranked by match quality rather than alphabetical order.
 *
 * Also added: authentication + rate limiting, so a signed-out visitor can no
 * longer use this endpoint to drain the IGDB quota, and IGDB/network errors
 * are caught and reported instead of throwing an opaque 500.
 */
export async function searchGames(query: string, limit = 10): Promise<Game[]> {
  const trimmed = String(query ?? '').trim();
  if (trimmed.length < 2) return [];
  if (!Number.isFinite(limit) || limit < 1) limit = 10;
  limit = Math.min(limit, 25);

  await enforce(await callerKey('igdb:search'), 40, 60_000);

  const supabase = await createClient();

  // 1. Cached rows first (fast, and they include games already logged here).
  let cached: Game[] = [];
  const { data: cachedRows, error: cacheError } = await supabase
    .from('games')
    .select('id, name, cover_url, release_date, summary')
    .ilike('name', `%${trimmed.replace(/([\\%_])/g, '\\$1')}%`)
    .limit(50);

  // Previously unchecked, so a transient read failure left `cached` empty and
  // the function threw `GAME_SEARCH_UNAVAILABLE` below — telling the user the
  // whole feature was permanently down when the catalogue may well have had
  // matching rows.
  if (cacheError) {
    console.error('[igdb] cached search error:', cacheError.message);
  }

  if (cachedRows) {
    const needle = trimmed.toLowerCase();
    cached = (cachedRows as Game[])
      .map((row) => ({
        id: row.id,
        name: row.name,
        cover_url: row.cover_url ?? null,
        release_date: row.release_date ?? null,
        summary: (row as { summary?: string | null }).summary ?? null,
        // Lower is better: exact match, then prefix, then substring.
        _rank: row.name.toLowerCase() === needle
          ? 0
          : row.name.toLowerCase().startsWith(needle)
            ? 1
            : 2,
      }))
      .sort((a, b) => a._rank - b._rank || a.name.length - b.name.length)
      .slice(0, limit)
      .map(({ _rank, ...rest }) => {
        void _rank;
        return rest;
      });
  }

  // 2. Always ask IGDB as well, unless we are missing credentials.
  const config = getIgdbConfig();
  if (!config) {
    // No IGDB credentials configured: serve whatever is already cached, and
    // signal unavailability by throwing a recognisable message the UI can show.
    if (!cached.length) {
      throw new Error(GAME_SEARCH_UNAVAILABLE);
    }
    return cached;
  }

  let live: Game[] = [];
  try {
    const safe = trimmed.replace(/["\\]/g, ' ').slice(0, 80);
    const games = await queryIgdb(
      `search "${safe}"; fields name, cover.url, first_release_date, summary, slug; ` +
        `sort search_rank; limit ${limit * 2};`,
      config
    );
    live = games.map(toRow);
  } catch (err) {
    if (cached.length) {
      // Degrade to cache-only rather than failing the whole search.
      console.error('[igdb] falling back to cache:', (err as Error).message);
      return cached;
    }
    throw err;
  }

  // 3. Merge and persist any newly discovered games so FKs stay satisfiable.
  const merged = new Map<number, Game>();
  for (const g of live) merged.set(g.id, g);
  for (const g of cached) if (!merged.has(g.id)) merged.set(g.id, g);

  const results = [...merged.values()].slice(0, limit);

  const toPersist = results
    .filter((g) => g.id > 0 && g.name)
    .map((g) => ({
      id: g.id,
      name: g.name,
      cover_url: g.cover_url ?? null,
      release_date: g.release_date ?? null,
      ...(g.summary ? { summary: g.summary } : {}),
    }));

  if (toPersist.length) {
    // Routed through the `upsert_game` RPC rather than a direct table upsert.
    //
    // 002 revokes `insert, update` on `games` from every client role and
    // replaces it with a SECURITY DEFINER function. That is deliberate: the
    // table is a shared catalogue, and the old `using (true)` update policy let
    // any signed-in user rewrite any game's title or point its cover art at an
    // arbitrary host (which then 500s every page rendering that game, because
    // next/image rejects unlisted image hosts at render time).
    //
    // Sequential rather than a bulk table write because the RPC is one row per
    // call. 20 results worst case, and only on a cache miss.
    for (const g of toPersist) {
      const { error } = await supabase.rpc('upsert_game', {
        p_id: g.id,
        p_name: g.name,
        p_cover_url: g.cover_url,
        p_release_date: g.release_date,
        p_summary: g.summary ?? null,
      });
      if (error) {
        // Non-fatal: search still returns live IGDB results, and the log flow
        // calls ensureGameCached() again.
        console.error(
          `[igdb] upsert_game failed [${error.code}]: ${error.message}`
        );
      }
    }
  }

  return results;
}

/**
 * Removed: `getGameDetails`.
 *
 * It had no callers, and being an `export async function` in a `'use server'`
 * module it was a public endpoint that spent the project's IGDB quota on
 * demand — with no `requireUser()` and no `enforce(...)`, unlike `searchGames`
 * directly above it, whose own doc comment notes that a signed-out visitor
 * draining the quota was a bug worth closing. Every failure was swallowed to
 * `null` with no log, so abuse was invisible.
 *
 * The live paths are `searchGames` for discovery and `ensureGameCached` below
 * for caching, and both are rate-limited.
 */

/**
 * Ensures a game row exists so a foreign key insert cannot fail.
 *
 * Preferred path is the `upsert_game` RPC. 002 revokes client
 * `insert`/`update` on the shared `games` catalogue and routes writes through a
 * SECURITY DEFINER function, because the old `using (true)` policy let any
 * signed-in user rewrite any game's title or repoint its cover art at an
 * arbitrary host — which then 500s every page rendering that game, because
 * next/image rejects unlisted image hosts at render time.
 *
 * Falls back to a direct table upsert when the RPC is not installed, i.e. on a
 * database where 002 has not been applied yet. Without this the app would be
 * *less* functional before the migration than after it, and "log a game" would
 * break the moment the RPC path became the only one. The direct path stops
 * working once 002 lands (revoked), at which point the RPC path is live, so the
 * two are complementary rather than redundant.
 *
 * The SQL `on conflict` clause deliberately does not update `name`, so a client
 * cannot rename a canonical title; only `cover_url`, `release_date` and
 * `summary` are refreshed, and only when the new value is non-null.
 */
export async function ensureGameCached(game: unknown): Promise<void> {
  const parsed = validateGamePayload(game);

  // Authenticated and rate-limited, like every other mutator here.
  //
  // The only reason this was left open is that RLS happened to cover it — but
  // that is not a rate limit, and `upsert_game` is SECURITY DEFINER, so any
  // signed-in user could invoke this endpoint directly and repoint a
  // canonical game's `cover_url`, bypassing the limiter that `searchGames`
  // applies. It is also called from the log flow and the watchlist, both of
  // which already resolved a session, so requiring one costs nothing.
  await requireUser();
  await enforce(await callerKey('game:write'), 30, 60_000);

  const supabase = await createClient();

  const { data: existing, error: existingError } = await supabase
    .from('games')
    .select('id')
    .eq('id', parsed.id)
    .maybeSingle();

  if (existing) return; // already cached, nothing to do

  // Distinguish "already cached" from "could not check". A failed read used to
  // leave `existing` null and fall through to a write attempt, which then failed
  // with a permissions error and surfaced a message about *write* permissions
  // when the real problem was the read.
  if (existingError) {
    console.error('[igdb] ensureGameCached lookup error:', existingError.message);
    throw new Error('Could not check whether that game is cached. Please try again.');
  }

  const payload = {
    id: parsed.id,
    name: parsed.name,
    cover_url: parsed.cover_url ?? null,
    release_date: parsed.release_date ?? null,
    // Included so the direct-upsert fallback (below) writes the same row the
    // RPC would. Without it, a game cached pre-002 lost its description while
    // the identical game cached post-002 kept it.
    summary: parsed.summary ?? null,
  };

  let error: { code?: string; message: string } | null = null;

  const rpc = await supabase.rpc('upsert_game', {
    p_id: parsed.id,
    p_name: parsed.name,
    p_cover_url: parsed.cover_url ?? null,
    p_release_date: parsed.release_date ?? null,
    p_summary: parsed.summary ?? null,
  });

  if (!rpc.error) return;
  error = rpc.error;

  // PGRST202 = the function does not exist, i.e. 002 has not been applied.
  // Fall back to the direct write rather than failing the user's action.
  if (error.code === 'PGRST202' || /could not find the function/i.test(error.message)) {
    const direct = await supabase.from('games').upsert(payload, { onConflict: 'id' });
    if (!direct.error) return;
    error = direct.error;
  }

  if (error) {
    // Re-check: a concurrent request may have inserted it.
    const { data: raced } = await supabase
      .from('games')
      .select('id')
      .eq('id', parsed.id)
      .maybeSingle();
    if (raced) return;

    if (error.code === '42501') {
      console.error(
        `[igdb] ensureGameCached write denied [${error.code}]: ${error.message}. ` +
          'Apply supabase/migrations/002_fixes_and_features.sql to create upsert_game().'
      );
      throw new Error(
        'Could not save that game. The database is missing write permissions for the games table.'
      );
    }
    console.error(`[igdb] ensureGameCached [${error.code}]:`, error.message);
    throw new Error(`Could not save "${parsed.name}". Please try again.`);
  }
}
