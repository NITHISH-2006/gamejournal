import type { MetadataRoute } from 'next';
import { createPublicClient } from '@/lib/supabase';
import { getSiteUrl, hasSupabaseConfig } from '@/lib/env';

export const revalidate = 3600; // regenerate hourly

/**
 * Sitemap for public pages.
 *
 * Only lists pages that are actually public: private lists are excluded so
 * their existence is not disclosed through the sitemap.
 *
 * This previously emitted `/api/og/log/<uuid>` for the 500 most recent logs.
 * Those are PNG endpoints, not HTML documents, so the sitemap contained 500
 * image URLs and *zero* entries for the pages that actually deserve indexing.
 * It now lists `/game/<id>`, deduplicated, which is the real canonical page.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = getSiteUrl();

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: base, changeFrequency: 'hourly', priority: 1 },
    { url: `${base}/discover`, changeFrequency: 'hourly', priority: 0.9 },
  ];

  // Without credentials (e.g. a local build) there is no database to read
  // URLs from. Emitting the static routes alone is a valid sitemap, and
  // letting it throw would break `next build` outright.
  if (!hasSupabaseConfig) return staticRoutes;

  try {
    // Session-less client: reading public rows must not touch `cookies()`, or
    // the route opts out of static generation and loses its hourly revalidate.
    const supabase = createPublicClient();

    const [{ data: logs, error: logsError }, { data: lists, error: listsError }] =
      await Promise.all([
        supabase
          .from('game_logs')
          .select('game_id, created_at')
          .order('created_at', { ascending: false })
          .limit(2000),
        // `updated_at` is absent on a database created from an older revision
        // of 001, which failed the whole query with
        // "column lists.updated_at does not exist" and silently dropped every
        // list URL. Selecting only `id` makes the query resilient; `created_at`
        // is requested separately and falls back to "no lastModified".
        supabase
          .from('lists')
          .select('id')
          .eq('is_public', true)
          .limit(200),
      ]);

    // Both queries previously destructured for `data` only, so a permission
    // error looked exactly like an empty result and the sitemap silently
    // shipped with no dynamic URLs at all.
    if (logsError) console.error('[sitemap] game_logs error:', logsError.message);
    if (listsError) console.error('[sitemap] lists error:', listsError.message);

    // Deduplicate: 2000 logs routinely cover far fewer than 2000 distinct
    // games, and repeating a URL in a sitemap is a quality signal.
    const seenGames = new Set<number>();
    const gameRoutes: MetadataRoute.Sitemap = [];
    for (const log of logs ?? []) {
      const id = Number(log.game_id);
      if (!Number.isInteger(id) || id <= 0 || seenGames.has(id)) continue;
      seenGames.add(id);
      gameRoutes.push({
        url: `${base}/game/${id}`,
        lastModified: new Date(log.created_at),
        changeFrequency: 'weekly',
        priority: 0.7,
      });
    }

    const listRoutes: MetadataRoute.Sitemap = (lists ?? []).map((list) => ({
      url: `${base}/list/${list.id}`,
      changeFrequency: 'weekly',
      priority: 0.6,
    }));

    return [...staticRoutes, ...listRoutes, ...gameRoutes];
  } catch (err) {
    console.error('[sitemap] failed to extend sitemap:', (err as Error).message);
    return staticRoutes;
  }
}
