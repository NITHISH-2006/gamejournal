/**
 * Centralised, validated access to environment variables.
 *
 * Previously `process.env.NEXT_PUBLIC_SUPABASE_URL!` used a non-null
 * assertion, so a missing variable produced `undefined` deep inside the
 * Supabase SDK at request time with an opaque error. We now fail fast with a
 * readable message and expose a client-safe subset for the browser bundle.
 *
 * The check is deliberately *lazy* (`getSupabaseConfig()`) rather than a
 * module-scope throw. Throwing on import meant that merely importing this
 * module failed, so `next build` could not even collect page data for routes
 * that never touch the database (sitemap, robots, static pages) without a
 * populated `.env.local`. Now a missing variable only fails the code paths that
 * actually need Supabase, with the same clear message.
 */

const isServer = typeof window === 'undefined';

/** Formats the actionable "you forgot to set this" message. */
function missing(name: string): string {
  return (
    `Missing required environment variable: ${name}. ` +
    `Copy .env.example to .env.local and fill in the values.`
  );
}

/**
 * NEXT_PUBLIC_* values MUST be referenced statically.
 *
 * Next.js inlines these into the client bundle by literal substitution, and it
 * can only do that when it can statically see the exact expression
 * `process.env.NEXT_PUBLIC_SUPABASE_URL`. A dynamic lookup —
 * `process.env[name]`, a loop, a helper that takes the name as an argument —
 * is NOT statically analysable, so nothing is inlined. The value is then
 * `undefined` in the browser while the server is perfectly happy, which
 * produces the worst possible failure mode: every route returns 200 and the
 * app only explodes on hydration, with "Missing required environment variable"
 * pointing at a file that clearly has one.
 *
 * Keep these as literal `process.env.NEXT_PUBLIC_*` expressions. Do not
 * "tidy" them into a helper.
 */
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

/** Public config — safe to reference from client components. May be empty when
 * the variables are unset; use `getSupabaseConfig()` to assert.
 */
export const publicEnv = {
  supabaseUrl,
  supabaseAnonKey,
} as const;

/** Whether the app is running with a real (non-placeholder) Supabase project. */
export const hasSupabaseConfig =
  supabaseUrl.startsWith('https://') && supabaseAnonKey.length > 20;

/**
 * Returns the Supabase connection details, throwing a readable error if they
 * are missing. Call this immediately before constructing a client.
 */
export function getSupabaseConfig(): { supabaseUrl: string; supabaseAnonKey: string } {
  if (!supabaseUrl) throw new Error(missing('NEXT_PUBLIC_SUPABASE_URL'));
  if (!supabaseAnonKey) throw new Error(missing('NEXT_PUBLIC_SUPABASE_ANON_KEY'));
  return { supabaseUrl, supabaseAnonKey };
}

/**
 * IGDB (Twitch) credentials are server-only. They gate the game-search
 * feature, so they are optional — the rest of the app works without them.
 */
export function getIgdbConfig(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.IGDB_CLIENT_ID;
  const clientSecret = process.env.IGDB_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  if (clientId === 'placeholder' || clientSecret === 'placeholder') return null;
  return { clientId, clientSecret };
}

/** Absolute site URL, used for canonical links, sitemap and OG images. */
export function getSiteUrl(): string {
  const explicit =
    process.env.NEXT_PUBLIC_SITE_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : undefined) ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined);

  if (explicit) return explicit.replace(/\/$/, '');

  if (isServer) {
    const port = process.env.PORT ?? '3000';
    return `http://localhost:${port}`;
  }
  return 'http://localhost:3000';
}
