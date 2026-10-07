import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { getSupabaseConfig, getSiteUrl } from '@/lib/env';

/**
 * OAuth / magic-link / email-confirmation / password-recovery callback.
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
  const { searchParams } = request.nextUrl;
  const code = searchParams.get('code');
  const tokenHash = searchParams.get('token_hash');
  const type = searchParams.get('type');
  const next = sanitizeNext(searchParams.get('next'));

  // `getSiteUrl()`, NOT `request.nextUrl.origin`.
  //
  // `nextUrl.origin` is derived from the incoming `Host` / `X-Forwarded-Host`
  // header, which a client controls. Using it to build the redirect target is
  // the mirror image of the `?next=` open redirect: a spoofed Host turns every
  // branch below into an off-site navigation. `getSiteUrl()` is the app's own
  // configured canonical origin.
  const origin = getSiteUrl();

  /**
   * A password recovery link must not land on the home page.
   *
   * `resetPasswordForEmail` is called with
   * `redirectTo: <origin>/auth/callback?next=/auth/update-password`, so `next`
   * already carries the destination. `type=recovery` is checked as well
   * because a project configured with the implicit flow sends the type in the
   * URL instead, and that path must not silently sign the user in and leave
   * them with no way to actually choose a new password.
   */
  const wantsPasswordUpdate = type === 'recovery' || next === PASSWORD_UPDATE_PATH;
  // A recovery link always wins over whatever `next` asked for, so no
  // combination of parameters can produce a signed-in user with no password
  // form in front of them.
  const redirectTo = wantsPasswordUpdate
    ? `${origin}${PASSWORD_UPDATE_PATH}`
    : (next ?? `${origin}/`);

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
      // `type` arrives from the query string, so it is validated rather than
      // cast. An unrecognised value would otherwise be forwarded to GoTrue and
      // surface as a raw Supabase error message on a public page.
      const { error: verifyError } = await supabase.auth.verifyOtp({
        type: OTP_TYPES.has(type ?? '') ? (type as OtpType) : 'email',
        token_hash: tokenHash,
      });
      error = verifyError;
    }

    if (error) {
      console.error('[auth/callback] exchange failed:', error.message);
      // The reason is mapped to a short code. Echoing `error.message` put
      // table and column names from PostgREST in front of an unauthenticated
      // visitor.
      return NextResponse.redirect(
        `${origin}/auth/error?reason=${classifyAuthError(error.message)}`
      );
    }

    // The session cookies are on `request.cookies` now; copy them onto the
    // redirect so the browser actually receives them.
    //
    // Iterating `cookieOptions` rather than `request.cookies.getAll()` is
    // deliberate. `getAll()` now also contains every cookie the visitor
    // already had — analytics, feature flags, consent — and stamping
    // `httpOnly: true` onto all of them silently makes them unreadable to
    // client-side JavaScript. Only the cookies Supabase asked us to set are
    // copied across.
    const response = NextResponse.redirect(redirectTo);
    const isProduction = process.env.NODE_ENV === 'production';
    for (const [name, options] of cookieOptions) {
      const cookie = request.cookies.get(name);
      if (!cookie) continue;
      response.cookies.set(name, cookie.value, {
        httpOnly: true,
        sameSite: 'lax',
        secure: isProduction,
        path: '/',
        ...options,
      });
    }

    return response;
  } catch (err) {
    console.error('[auth/callback] failed:', (err as Error).message);
    return NextResponse.redirect(
      `${origin}/auth/error?reason=${classifyAuthError((err as Error).message)}`
    );
  }
}

const PASSWORD_UPDATE_PATH = '/auth/update-password';

type OtpType = 'email' | 'recovery' | 'invite' | 'magiclink' | 'email_change';

const OTP_TYPES = new Set<string>([
  'email',
  'recovery',
  'invite',
  'magiclink',
  'email_change',
]);

/**
 * Maps a GoTrue/PostgREST message to a short, non-revealing code.
 *
 * The raw message was previously interpolated into the `?reason=` parameter and
 * rendered into the DOM on `/auth/error`. It is not an XSS risk — React escapes
 * it — but it does expose internal schema detail to an anonymous visitor.
 */
function classifyAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('expired')) return 'expired';
  if (m.includes('invalid') || m.includes('not found')) return 'invalid';
  if (m.includes('already') || m.includes('used')) return 'already_used';
  return 'unknown';
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

  // ASCII tab (U+0009), LF and CR are removed by the WHATWG URL parser before
  // the URL is parsed. `/\t/evil.com` therefore collapses to `//evil.com`, which
  // is protocol-relative — so stripping them here is what actually closes the
  // hole. A naive "must start with /" check does not.
  const v = value.replace(/[\u0009\u000a\u000d]/g, '');
  if (!v.startsWith('/')) return null;

  // `//evil.com` and `/\evil.com` are both protocol-relative to a browser.
  // `startsWith('/\\')` compares against `/` after JS string escaping, so it
  // matches nothing useful; reject backslashes outright instead.
  if (v.startsWith('//') || v.includes('\\')) return null;

  // Final authority: parse it and confirm the origin is unchanged. This is what
  // makes the check correct rather than merely plausible.
  try {
    const parsed = new URL(v, 'https://placeholder.invalid');
    if (parsed.origin !== 'https://placeholder.invalid') return null;
  } catch {
    return null;
  }

  return v;
}