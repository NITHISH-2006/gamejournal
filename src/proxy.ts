import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { getSupabaseConfig } from '@/lib/env';

/**
 * Proxy — security headers, cache policy and Supabase session refresh.
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
 */

const securityHeaders: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-DNS-Prefetch-Control': 'on',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
};

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // --- Supabase session refresh ------------------------------------------------
  // A Server Component cannot set cookies, so `setAll` in lib/supabase.ts
  // silently drops refreshed tokens. Doing it here — where the response is
  // mutable — is the documented Supabase pattern and is what keeps a session
  // alive past the ~1h access-token lifetime.
  let response = NextResponse.next({ request: { headers: request.headers } });

  const isAuthRoute =
    pathname.startsWith('/auth') ||
    pathname.includes('/api/og/') ||
    pathname.startsWith('/_next');

  if (!isAuthRoute) {
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
            response = NextResponse.next({ request: { headers: request.headers } });
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
    // Content-Security-Policy: no unsafe-eval in production. Supabase and IGDB
    // are allow-listed because the browser talks to Supabase directly (auth,
    // realtime) and IGDB only from the server.
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://*.supabase.co",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://images.igdb.com https://*.supabase.co",
      "font-src 'self' data:",
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
  if (
    pathname.startsWith('/profile') ||
    pathname.startsWith('/user/') ||
    pathname.startsWith('/list/') ||
    pathname.startsWith('/game/')
  ) {
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
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|woff2?)$).*)',
  ],
};
