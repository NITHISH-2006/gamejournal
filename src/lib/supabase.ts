import { createBrowserClient, createServerClient } from '@supabase/ssr';
import { getSupabaseConfig } from '@/lib/env';

/**
 * Returns the signed-in Supabase user, or `null`.
 *
 * Thin wrapper so that call sites do not each repeat the destructure, and so
 * that `getUser()` (which validates the JWT against Supabase rather than
 * trusting the cookie) is used consistently. Trusting the cookie alone would
 * let a forged/expired token through to RLS.
 */
export async function getUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

/** Returns the current user or throws — for use inside Server Actions. */
export async function requireUser() {
  const user = await getUser();
  if (!user) {
    throw new Error('You must be signed in to do that.');
  }
  return user;
}

/**
 * Returns the user's profile row. Auto-provisions a profile if the database
 * trigger that creates rows on signup is missing, so the app degrades
 * gracefully instead of breaking with a null username.
 */
export async function requireProfile() {
  const supabase = await createClient();
  const user = await requireUser();

  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .maybeSingle();

  if (error) {
    // A failed *read* is not evidence that the row is missing. Previously the
    // error went unchecked, so a transient read failure fell through to the
    // self-heal INSERT below, which then collided with the very row it failed
    // to read (23505) and reported "Could not load your profile. Please sign
    // out and back in." — a write provoked by a read error, with instructions
    // that would not fix it.
    console.error('[supabase] requireProfile read error:', error.message);
    throw new Error('Could not load your profile. Please try again.');
  }

  if (data) return data;

  // Self-heal: the signup trigger is the intended path, but if it has not run
  // we create the row so the rest of the app has something to work with.
  const fallbackUsername = deriveUsername(user.email ?? 'player');
  const { data: created, error: insertError } = await supabase
    .from('profiles')
    .insert({ id: user.id, username: fallbackUsername })
    .select('*')
    .single();

  if (insertError) {
    console.error('[supabase] requireProfile self-heal error:', insertError.message);
    throw new Error('Could not load your profile. Please sign out and back in.');
  }
  return created;
}

/** Generates a valid, unique-ish username from an email address. */
function deriveUsername(email: string): string {
  const base = email
    .split('@')[0]
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 14);

  const safe = base.length >= 3 ? base : 'player';
  return `${safe}${Math.random().toString(36).slice(2, 7)}`;
}

// Server-side client (Server Components and Server Actions).
export async function createClient() {
  const { cookies } = await import('next/headers');
  const cookieStore = await cookies();
  const { supabaseUrl, supabaseAnonKey } = getSupabaseConfig();

  return createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components cannot set cookies — safe to ignore. Server
          // Actions and the proxy handle the refresh path.
        }
      },
    },
  });
}

/**
 * Client-side client (Client Components).
 *
 * Memoised: previously a new client was constructed on every render of every
 * component that needed it (AuthButton, ActivityFeed, …), which duplicated
 * realtime connections and needlessly churned memory.
 *
 * The type is preserved by inferring it from this factory rather than writing
 * `ReturnType<typeof createBrowserClient>`. `createBrowserClient` is generic,
 * so `ReturnType<...>` resolves the generics to their constraints and the
 * `SupabaseClient` type collapses — `auth.onAuthStateChange` then takes an
 * untyped callback and its `(event, session)` parameters come through as
 * `any`, silently losing the discriminated `AuthChangeEvent` union.
 */
function makeBrowserClient() {
  const { supabaseUrl, supabaseAnonKey } = getSupabaseConfig();
  return createBrowserClient(supabaseUrl, supabaseAnonKey);
}

let browserClient: ReturnType<typeof makeBrowserClient> | null = null;

export function createBrowserSupabaseClient() {
  browserClient ??= makeBrowserClient();
  return browserClient;
}

/**
 * Builds the session-less client.
 *
 * Kept as its own function so `createPublicClient` can memoise it while
 * preserving the full generic client type: `ReturnType<typeof createServerClient>`
 * would re-instantiate the generics and degrade every query result to `any`.
 */
function makePublicClient() {
  const { supabaseUrl, supabaseAnonKey } = getSupabaseConfig();
  return createServerClient(supabaseUrl, supabaseAnonKey, {
    // No request scope: reads only, and there is no session to persist.
    cookies: {
      getAll: () => [],
      setAll: () => {},
    },
  });
}

let publicClient: ReturnType<typeof makePublicClient> | null = null;

/**
 * Session-less client for reading public rows.
 *
 * Use this wherever no user session is involved — `sitemap.xml`, the OG image
 * routes, anything crawling the site. The cookie-bound `createClient()` reads
 * `cookies()` from `next/headers`, which opts the route out of static
 * generation: the sitemap failed with "couldn't be rendered statically because
 * it used `cookies`" and lost its hourly revalidation. A client with an empty,
 * non-persisting cookie jar never touches the request scope, so those routes
 * stay statically renderable.
 */
export function createPublicClient() {
  publicClient ??= makePublicClient();
  return publicClient;
}
