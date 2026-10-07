import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { getSupabaseConfig } from '@/lib/env';

/**
 * OAuth / magic-link / email-confirmation callback.
 *
 * This route was missing entirely. Supabase's browser client defaults to the
 * PKCE flow, so every confirmation and recovery link arrives as
 * `/auth/callback?code=...` and the authorization code has to be exchanged for
 * a session by a server route. Without this file the code was never exchanged,
 * so anyone who had to confirm their email address simply could not finish
 * signing in.
 *
 * `code` (PKCE) and `token_hash` (implicit / older links) are both handled,
 * because which one you get depends on the project's Auth settings.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get('code');
  const tokenHash = searchParams.get('token_hash');
  const type = searchParams.get('type');
  const next = sanitizeNext(searchParams.get('next'));

  // Always bounce back to the site root unless a safe internal path was given.
  const redirectTo = next ?? `${origin}/`;

  if (!code && !tokenHash) {
    return NextResponse.redirect(`${origin}/auth/error?reason=missing_code`);
  }

  try {
    const { supabaseUrl, supabaseAnonKey } = getSupabaseConfig();
    // Attributes Supabase asked for, per cookie, so the redirect can reapply
    // them verbatim instead of guessing.
    const cookieOptions = new Map<string, CookieOptions>();
    const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          // Recorded rather than applied. A Server Action could write cookies
          // straight to the response, but a `NextResponse.redirect` replaces the
          // response, so anything set on it is lost. The options are captured
          // here and re-applied to the redirect below, which is what keeps the
          // session's `max-age`/`expires` intact instead of turning the access
          // token into a session cookie.
          for (const { name, value, options } of cookiesToSet) {
            request.cookies.set(name, value);
            cookieOptions.set(name, options ?? {});
          }
        },
      },
    });

    let error: Error | null = null;

    if (code) {
      const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
      error = exchangeError;
    } else if (tokenHash) {
      const { error: verifyError } = await supabase.auth.verifyOtp({
        type: (type as 'email' | 'recovery' | 'invite' | 'magiclink') ?? 'email',
        token_hash: tokenHash,
      });
      error = verifyError;
    }

    if (error) {
      console.error('[auth/callback] exchange failed:', error.message);
      return NextResponse.redirect(
        `${origin}/auth/error?reason=${encodeURIComponent(error.message)}`
      );
    }

    // The session cookies are on `request.cookies` now; copy them onto the
    // redirect so the browser actually receives them. Every cookie is
    // httpOnly and sameSite=lax, but `secure` is conditional so the exchange
    // also works on http://localhost during development.
    const response = NextResponse.redirect(redirectTo);
    for (const cookie of request.cookies.getAll()) {
      const options = cookieOptions.get(cookie.name);
      response.cookies.set(cookie.name, cookie.value, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        ...options,
      });
    }
    return response;
  } catch (err) {
    console.error('[auth/callback] failed:', (err as Error).message);
    return NextResponse.redirect(
      `${origin}/auth/error?reason=${encodeURIComponent((err as Error).message)}`
    );
  }
}

/**
 * Rejects off-site redirects.
 *
 * Without this, `?next=https://evil.example` would turn the auth callback into
 * an open redirect: a victim clicks a legitimate-looking Supabase link, signs
 * in, and is handed straight to an attacker's page with a valid referrer.
 */
function sanitizeNext(value: string | null): string | null {
  if (!value) return null;
  // Must be a single-slash path: `//evil.com` and `/\evil.com` are both
  // treated as protocol-relative URLs by the browser.
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) {
    return null;
  }
  return value;
}
