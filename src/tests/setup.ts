import '@testing-library/jest-dom/vitest';
import { vi, beforeEach } from 'vitest';

/**
 * Global test setup.
 *
 * `src/lib/env.ts` reads `process.env.NEXT_PUBLIC_*` into module-level constants,
 * and its own documentation explains that those must be literal expressions for
 * Next to inline them. Vitest has no bundler, so the values can simply be set
 * before any module under test is imported.
 *
 * They are deliberately *valid-shaped* rather than empty, because
 * `hasSupabaseConfig` checks `supabaseUrl.startsWith('https://')` and
 * `anonKey.length > 20`. A placeholder that fails those checks would make every
 * code path take its "no database configured" branch and quietly test nothing.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??=
  'sb_publishable_placeholder_key_for_tests_only';
process.env.NEXT_PUBLIC_SITE_URL ??= 'http://localhost:3000';

// No IGDB credentials, so `getIgdbConfig()` returns null and the search path
// takes its documented fallback. A test that needs IGDB sets them explicitly.
delete process.env.IGDB_CLIENT_ID;
delete process.env.IGDB_CLIENT_SECRET;

/**
 * `next/cache` throws outside a request scope.
 *
 * `revalidate.ts` is imported by most actions, so anything that touches a
 * server action needs this. Recording the calls lets a test assert that a
 * mutation invalidated the paths it should have.
 */
export const revalidateCalls: string[] = [];

vi.mock('next/cache', () => ({
  revalidatePath: (path: string) => {
    revalidateCalls.push(path);
  },
  revalidateTag: (tag: string) => {
    revalidateCalls.push(tag);
  },
  unstable_cache: <T>(fn: () => T) => fn,
}));

/**
 * `next/headers` also needs a request scope. `callerKey()` falls back to
 * `headers()` for anonymous callers, so this is reachable from any test that
 * exercises rate limiting without a session.
 */
const headerStore = new Map<string, string>();

export function __setHeaders(headers: Record<string, string>) {
  headerStore.clear();
  for (const [k, v] of Object.entries(headers)) headerStore.set(k, v);
}

vi.mock('next/headers', () => ({
  headers: async () => new Headers(Object.fromEntries(headerStore)),
  cookies: async () => ({
    getAll: () => [],
    // A test never depends on reading a cookie, so an always-undefined `get`
    // is honest rather than a stub that hides a real lookup.
    get: () => undefined,
    set: () => {},
    delete: () => {},
  }),
}));

beforeEach(() => {
  revalidateCalls.length = 0;
  headerStore.clear();
});