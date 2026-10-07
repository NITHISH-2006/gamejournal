import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { getSupabaseConfig } from '@/lib/env';

/**
 * Proxy — security headers, Content-Security-Policy, cache policy and Supabase
 * session refresh.
 *
 * (Next 16 renamed `middleware` to `proxy`; the file must sit next to `app`,
 * i.e. `src/proxy.ts`, or it is silently never executed.)
 *
 * ── The bug that broke sign-in, Server Actions and rate limiting ────────────
 *
 * This used to build the request headers like this:
 *
 *     const headers = new Headers();                       // EMPTY
 *     NextResponse.next({ request: { headers } });
 *
 * Passing headers to `request.headers` is an **override**, not a merge. Next
 * collects the keys you supply into `x-middleware-override-headers` and then,
 * in `server/lib/router-utils/resolve-routes.js`, deletes every request header
 * that is not in that list:
 *
 *     for (const key of Object.keys(req.headers)) {
 *       if (!overriddenHeaders.has(key)) { delete req.headers[key]; }
 *     }
 *
 * So this proxy was silently deleting, on every matched request:
 *
 *   `cookie`          -> the server never saw a session. Sign-in appeared to do
 *                        nothing: the navbar kept rendering "Sign in", and
 *                        `/profile` kept redirecting to `/`.
 *   `next-action`     -> Server Actions were no longer recognised as Server
 *                        Actions, so every `'use server'` call came back
 *                        "An unexpected response was received from the server".
 *   `content-type`    -> same problem, for the body parser.
 *   `x-forwarded-for` -> the rate limiter fell through to its single 'global'
 *                        bucket, so every anonymous visitor shared one limit.
 *
 * The fix is to clone the incoming headers and *add* to them. Request headers
 * and response headers are also kept in separate objects below; sharing one
 * object was the reason the response headers appeared at all.
 *
 * ── Why this now clones rather than forwarding by reference ────────────────
 *
 * The previous fix passed the live `request.headers` object straight through,
 * which happens to work today only because it enumerates every key. It is one
 * refactor away from the bug above: add any filtering, or forward a subset, and
 * every unlisted header is silently deleted again. It also gave up the nonce
 * hook, which is the whole reason this file builds its own header set.
 */

/**
 * A per-request nonce.
 *
 * `crypto.randomUUID()` is available in the Edge runtime. The base64 characters
 * are stripped so the value is safe to embed in a CSP directive and an HTML
 * attribute without escaping.
 */
function createNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString('base64').replace(/[^a-zA-Z0-9+/=]/g, '');
}

const securityHeaders: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-DNS-Prefetch-Control': 'on',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
};

/** Requests whose responses must never be written to a shared cache. */
function isPrivateRoute(pathname: string): boolean {
  return (
    pathname.startsWith('/profile') ||
    pathname.startsWith('/user/') ||
    pathname.startsWith('/list/') ||
    pathname.startsWith('/game/') ||
    // `/auth/error?reason=…` renders the failure reason, and
    // `/auth/update-password` is only meaningful to the signed-in recovery
    // session. Neither should be cached.
    pathname.startsWith('/auth')
  );
}

export async function proxy(request: NextRequest) {
  const { pathname } = await request.nextUrl;
  const nonce = createNonce();

  // Clone, then add. Never construct a bare `Headers` here.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);

  // --- Supabase session refresh ------------------------------------------------
  // A Server Component cannot set cookies, so `setAll` in lib/supabase.ts
  // silently drops refreshed tokens. Doing it here — where the response is
  // mutable — is the documented Supabase pattern and is what keeps a session
  // alive past the ~1h access-token lifetime.
  let response = NextResponse.next({ request: { headers: requestHeaders } });

  const skipSessionRefresh =
    pathname.startsWith('/auth') ||
    pathname.includes('/api/og/') ||
    pathname.startsWith('/_next');

  if (!skipSessionRefresh) {
    try {
      const { supabaseUrl, supabaseAnonKey } = getSupabaseConfig();
      const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(cookiesToSet) {
            for (const { name, value } of cookiesToSet) {
              request.cookies.set(name, value);
            }
            // Re-snapshot: the refresh above mutated `request.cookies`, and this
            // is what actually propagates the new value downstream. Built from
            // `requestHeaders` so the nonce is not dropped either.
            response = NextResponse.next({ request: { headers: requestHeaders } });
            for (const { name, value, options } of cookiesToSet) {
              response.cookies.set(name, value, options);
            }
          },
        },
      });

      // `getUser()` validates the JWT against Supabase rather than trusting the
      // cookie, and triggers a refresh when the access token has expired.
      await supabase.auth.getUser();
    } catch {
      // A misconfigured project must not take the whole site down; the pages
      // themselves surface the real error.
    }
  }

  // --- Response headers -------------------------------------------------------
  const headers = new Headers(response.headers);

  if (process.env.NODE_ENV === 'production') {
    /**
     * `'strict-dynamic'` with a per-request nonce.
     *
     * `'unsafe-inline'` is gone, which is the point: it is what made injected
     * markup executable, and inline `<script>` is exactly what an XSS payload
     * is. Under `strict-dynamic` a nonce-bearing script may load further scripts
     * at runtime, which is how Next's ~60 dynamically-injected chunks still work
     * without `'unsafe-inline'`.
     *
     * `https://*.supabase.co` has also been dropped from `script-src`. It was
     * never needed — the Supabase JS is bundled from `'self'` — and a Supabase
     * project's *public Storage bucket* is served from that same host, so anyone
     * able to upload an object there could host arbitrary JavaScript that this
     * directive would then execute with the app's origin.
     *
     * `blob:` is likewise dropped from `img-src`: unused, and it is another way
     * to smuggle attacker-controlled bytes into the page.
     */
    const csp = [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
      // Required: inline `style={{}}` is used throughout, as is
      // `tw-animate-css`. `style-src` cannot use nonces the same way.
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https://images.igdb.com https://*.supabase.co",
      "font-src 'self' data:",
      // The browser talks to Supabase directly for auth and realtime, so both the
      // HTTPS and WSS origins have to be here. IGDB is server-side only.
      `connect-src 'self' https://*.supabase.co wss://*.supabase.co`,
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
      'upgrade-insecure-requests',
    ].join('; ');
    headers.set('Content-Security-Policy', csp);
  }

  for (const [key, value] of Object.entries(securityHeaders)) {
    headers.set(key, value);
  }

  // Authenticated areas must never be cached by a shared cache.
  if (isPrivateRoute(pathname)) {
    headers.set('Cache-Control', 'private, no-store, max-age=0');
  }

  // Rebuild the response so the new headers are actually sent.
  const final = new NextResponse(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  // Copy any cookies set by the refresh above.
  for (const cookie of response.cookies.getAll()) {
    final.cookies.set(cookie);
  }
  return final;
}

export const config = {
  matcher: [
    // Everything except Next internals and static assets.
    //
    // `avif`, `json` and `webmanifest` are excluded too. They were previously
    // matched, so a request for a cover image in AVIF — which is the first
    // format `next.config.ts` asks for — paid a full `auth.getUser()` round trip
    // to the Supabase auth server.
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|txt|xml|json|webmanifest|woff2?)$).*)',
  ],
};