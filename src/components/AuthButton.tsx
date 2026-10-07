'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createBrowserSupabaseClient } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Loader2, Mail, KeyRound, ArrowLeft } from 'lucide-react';
import { useToast } from '@/components/Toast';
import { ProfileAvatar } from '@/components/ui-primitives';
import { LIMITS } from '@/lib/validation';

type Mode = 'login' | 'signup' | 'reset';

type Props = {
  user: { email?: string } | null;
  username?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
};

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

export default function AuthButton({
  user,
  username,
  displayName,
  avatarUrl,
}: Props) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [usernameInput, setUsernameInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Guards against double submits, which previously produced duplicate
  // sign-up attempts and hit Supabase's rate limiter.
  const submitting = useRef(false);

  // Not during render: `createBrowserClient` constructs a whole Supabase client
  // (including a GoTrue instance) and this is a Client Component, so it is
  // also evaluated during SSR. Lazily created on first use instead.
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const { toast } = useToast();
  const router = useRouter();

  // Keep the server-rendered tree in sync with the session.
  //
  // Without this, signing in from the dialog updated nothing: the navbar kept
  // rendering "Sign in" and /profile kept redirecting, because the RSC payload
  // was never refetched. A hard `window.location.href` used to paper over this
  // for password sign-in — but not for the email-confirmation link, where the
  // session is established by /auth/callback *after* the page has rendered, so
  // the user was left looking at a signed-out page with no way forward.
  useEffect(() => {
    // `/auth/error` links here with `?signin=1` so "Sign in again" actually
    // reopens the dialog. The previous version pointed both of its buttons at
    // `/`, so the CTA was a second link to the same place under a different
    // label and the user had to hunt for the navbar trigger.
    if (user) return;
    if (new URLSearchParams(window.location.search).get('signin') !== '1') return;

    // Strip the parameter first so a refresh or Back does not re-trigger it.
    const url = new URL(window.location.href);
    url.searchParams.delete('signin');
    window.history.replaceState(null, '', url.toString());

    // Deferred to the next frame rather than set synchronously in the effect
    // body: React 19 flags a synchronous setState there as a cascading render.
    // Same pattern as `LogGameModal`'s `?log=1` handling.
    const id = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(id);
  }, [user]);

  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      // `PASSWORD_RECOVERY` was previously absent. The recovery session is
      // established by `/auth/callback` *after* the page has rendered, so
      // without this the server-rendered tree never learns the user is signed
      // in.
      if (
        event === 'SIGNED_IN' ||
        event === 'SIGNED_OUT' ||
        event === 'TOKEN_REFRESHED' ||
        event === 'PASSWORD_RECOVERY'
      ) {
        // `getSession()` inside the callback can deadlock, so only the event
        // is used here.
        if (event === 'SIGNED_OUT') {
          router.refresh();
          return;
        }
        if (session) router.refresh();
      }
    });
    return () => subscription.unsubscribe();
  }, [supabase, router]);

  /**
   * OAuth sign-in.
   *
   * `redirectTo` points at `/auth/callback` rather than `/`, because that is the
   * only route that exchanges the PKCE code for a session — landing on `/` would
   * bounce back to a signed-out page. The route already rejects an off-site
   * `?next=`, so the return path here is a fixed constant rather than anything
   * derived from the current URL.
   */
  const handleOAuth = async (provider: 'google' | 'discord') => {
    if (submitting.current) return;
    submitting.current = true;
    setLoading(true);
    setError(null);

    try {
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
        },
      });

      // `signInWithOAuth` navigates away on success, so anything after an
      // absence of error is unreachable in practice. An error means the
      // provider is not enabled on the Supabase project, which is the common
      // case and deserves an explanation rather than a raw SDK message.
      if (oauthError) {
        setError(
          /not enabled|provider/i.test(oauthError.message)
            ? `${provider === 'google' ? 'Google' : 'Discord'} sign-in is not enabled for this site. Use email and password.`
            : oauthError.message
        );
        toast('Could not start sign-in', 'error');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      submitting.current = false;
      setLoading(false);
    }
  };

  const handleSignOut = async () => {
    setLoading(true);
    try {
      // `signOut()` resolves with `{ error }` on an API failure rather than
      // throwing, so the error has to be read explicitly — otherwise a failed
      // sign-out still shows the success toast and navigates away.
      const { error: signOutError } = await supabase.auth.signOut();
      if (signOutError) throw new Error(signOutError.message);
      toast('Signed out. See you soon!');
      router.refresh();
      window.location.href = '/';
    } catch {
      toast('Could not sign out. Please try again.', 'error');
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setLoading(true);
    setError(null);
    setMessage(null);

    try {
      if (mode === 'reset') {
        if (!email.trim()) {
          setError('Enter your email address.');
          return;
        }
        const { error: resetError } = await supabase.auth.resetPasswordForEmail(
          email.trim(),
          // Must land on the callback route first — that is the only place the
          // PKCE code can be exchanged for a session. `next` then carries the
          // user on to the password form, so they actually get to choose a new
          // password instead of being silently signed in on their old one.
          { redirectTo: `${window.location.origin}/auth/callback?next=/auth/update-password` }
        );
        if (resetError) {
          setError(resetError.message);
          toast(resetError.message, 'error');
        } else {
          setMessage(
            'If an account exists for that email, a password reset link is on its way.'
          );
          toast('Reset link sent');
        }
        return;
      }

      if (mode === 'login') {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (signInError) {
          setError(
            signInError.message.toLowerCase().includes('invalid')
              ? 'That email and password combination is not recognised.'
              : signInError.message
          );
        } else {
          toast('Welcome back!');
          window.location.href = '/';
        }
        return;
      }

      // signup
      const handle = usernameInput.trim().toLowerCase();
      if (!handle) {
        setError('Username is required.');
        return;
      }
      if (!USERNAME_RE.test(handle)) {
        setError(
          `Username must be ${LIMITS.usernameMin}-${LIMITS.usernameMax} characters, lowercase letters, numbers or underscores only.`
        );
        return;
      }
      if (password.length < LIMITS.passwordMin) {
        setError(`Password must be at least ${LIMITS.passwordMin} characters.`);
        return;
      }

      const { data, error: signUpError } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: { username: handle },
          // Without this, Supabase falls back to the GoTrue "Site URL" project
          // setting. That is unverifiable from the code, and it means a
          // confirmation link generated while running locally points at
          // localhost — so the email-confirmation path could never complete.
          // This route is the PKCE exchange point; see src/app/auth/callback.
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      });

      if (signUpError) {
        const m = signUpError.message.toLowerCase();
        if (m.includes('rate limit') || m.includes('too many')) {
          setError('Too many sign-up attempts. Please wait a few minutes and try again.');
        } else if (m.includes('already registered') || m.includes('already exists')) {
          setError('An account with that email already exists. Try signing in instead.');
        } else {
          setError(signUpError.message);
        }
        return;
      }

      // When email confirmation is disabled, signUp returns a session and the
      // user is already authenticated. The old code ignored this and made
      // people sign in again manually.
      if (data.session) {
        toast('Account created. Welcome to GameJournal!');
        window.location.href = '/';
      } else {
        setMode('login');
        setMessage('Account created. Check your email to confirm it, then sign in.');
        toast('Check your inbox to confirm your email');
      }
    } catch (err) {
      setError((err as Error).message ?? 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
      submitting.current = false;
    }
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
    setMessage(null);
    setPassword('');
    if (next !== 'signup') setUsernameInput('');
  };

  if (user) {
    return (
      <div className="flex items-center gap-2">
        {username ? (
          <div className="hidden items-center gap-2 sm:flex">
            <ProfileAvatar username={username} avatarUrl={avatarUrl} size={28} />
            <span className="max-w-24 truncate text-sm text-muted-foreground">
              {displayName ?? `@${username}`}
            </span>
          </div>
        ) : (
          <span className="hidden max-w-32 truncate text-sm text-muted-foreground sm:block">
            {user.email}
          </span>
        )}
        <Button
          variant="glass"
          size="sm"
          onClick={handleSignOut}
          disabled={loading}
        >
          {loading ? <Loader2 className="animate-spin" /> : null}
          Sign out
        </Button>
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!loading) setOpen(v); }}>
      <DialogTrigger asChild>
        <Button variant="primary" size="sm">
          Sign in
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          {mode === 'reset' ? (
            <>
              <button
                type="button"
                onClick={() => switchMode('login')}
                className="mb-1 inline-flex w-fit items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <ArrowLeft className="size-3" />
                Back to sign in
              </button>
              <DialogTitle>Reset your password</DialogTitle>
              <DialogDescription>
                Enter your email and we will send you a link to choose a new password.
              </DialogDescription>
            </>
          ) : (
            <>
              <DialogTitle>
                {mode === 'login' ? 'Welcome back' : 'Create your account'}
              </DialogTitle>
              <DialogDescription>
                {mode === 'login'
                  ? 'Sign in to log games and see your friends activity.'
                  : 'Pick a handle and start your gaming journal.'}
              </DialogDescription>
            </>
          )}
        </DialogHeader>

        {/* OAuth, shown on sign-in only.
            Not available in reset mode: a password-reset link is tied to an
            existing account, so offering "continue with Google" there is a
            dead end for anyone who signed up with a password. */}
        {mode !== 'reset' && (
          <>
            <div className="flex items-center gap-3" aria-hidden="true">
              <span className="h-px flex-1 bg-white/10" />
              <span className="text-xs text-ink-faint">or continue with</span>
              <span className="h-px flex-1 bg-white/10" />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant="glass"
                disabled={loading}
                onClick={() => handleOAuth('google')}
              >
                <svg className="size-4" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    fill="#4285F4"
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1Z"
                  />
                  <path
                    fill="#34A853"
                    d="M12 23c2.97 0 5.46-.98 7.28-2.65l-3.57-2.77c-.99.66-2.26 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M5.84 14.11a6.6 6.6 0 0 1 0-4.22V7.05H2.18a11 11 0 0 0 0 9.9l3.66-2.84Z"
                  />
                  <path
                    fill="#EA4335"
                    d="M12 4.75c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 1.46 14.97.5 12 .5A11 11 0 0 0 2.18 7.05l3.66 2.84C6.71 6.68 9.14 4.75 12 4.75Z"
                  />
                </svg>
                Google
              </Button>

              <Button
                type="button"
                variant="glass"
                disabled={loading}
                onClick={() => handleOAuth('discord')}
              >
                <svg className="size-4" viewBox="0 0 24 24" fill="#5865F2" aria-hidden="true">
                  <path d="M20.32 4.57A19.79 19.79 0 0 0 15.43 3c-.24.42-.5.99-.69 1.44a18.3 18.3 0 0 0-5.48 0C9.07 3.99 8.8 3.42 8.56 3a19.74 19.74 0 0 0-4.89 1.57C.56 9.2-.28 13.71.14 18.16A19.9 19.9 0 0 0 6.15 21c.49-.66.92-1.36 1.29-2.1-.71-.27-1.39-.6-2.02-.98.17-.12.34-.25.5-.38a14.2 14.2 0 0 0 12.16 0c.16.13.33.26.5.38-.63.38-1.31.71-2.02.98.37.74.8 1.44 1.29 2.1a19.87 19.87 0 0 0 6.01-2.84c.5-5.15-.85-9.63-3.54-13.59ZM8.02 15.44c-1.18 0-2.15-1.08-2.15-2.4 0-1.32.95-2.4 2.15-2.4 1.21 0 2.18 1.09 2.16 2.4 0 1.32-.95 2.4-2.16 2.4Zm7.96 0c-1.18 0-2.15-1.08-2.15-2.4 0-1.32.95-2.4 2.15-2.4 1.21 0 2.18 1.09 2.16 2.4 0 1.32-.95 2.4-2.16 2.4Z" />
                </svg>
                Discord
              </Button>
            </div>
          </>
        )}

        <form onSubmit={handleSubmit} className="space-y-3">
          {mode === 'signup' && (
            <div className="space-y-1.5">
              <label htmlFor="username" className="text-xs font-medium text-muted-foreground">
                Username
              </label>
              <Input
                id="username"
                placeholder="e.g. pixel_wanderer"
                value={usernameInput}
                onChange={(e) => setUsernameInput(e.target.value.toLowerCase())}
                disabled={loading}
                required
                autoComplete="username"
                minLength={LIMITS.usernameMin}
                maxLength={LIMITS.usernameMax}
              />
            </div>
          )}

          <div className="space-y-1.5">
            <label htmlFor="email" className="text-xs font-medium text-muted-foreground">
              Email
            </label>
            <div className="relative">
              <Mail className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={loading}
                required
                autoComplete="email"
                className="pl-10"
              />
            </div>
          </div>

          {mode !== 'reset' && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label htmlFor="password" className="text-xs font-medium text-muted-foreground">
                  Password
                </label>
                {mode === 'login' && (
                  <button
                    type="button"
                    onClick={() => switchMode('reset')}
                    className="text-xs text-brand transition-colors hover:underline"
                  >
                    Forgot password?
                  </button>
                )}
              </div>
              <div className="relative">
                <KeyRound className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="password"
                  type="password"
                  placeholder={
                    mode === 'signup'
                      ? `At least ${LIMITS.passwordMin} characters`
                      : 'Your password'
                  }
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={loading}
                  required
                  minLength={LIMITS.passwordMin}
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  className="pl-10"
                />
              </div>
            </div>
          )}

          {error && (
            <p
              role="alert"
              className="rounded-xl border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
            >
              {error}
            </p>
          )}
          {message && (
            <p
              role="status"
              className="rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200"
            >
              {message}
            </p>
          )}

          <Button
            type="submit"
            variant="primary"
            disabled={loading}
            className="w-full"
          >
            {loading ? (
              <>
                <Loader2 className="animate-spin" />
                {mode === 'login' ? 'Signing in...' : mode === 'signup' ? 'Creating account...' : 'Sending link...'}
              </>
            ) : mode === 'login' ? (
              'Sign in'
            ) : mode === 'signup' ? (
              'Create account'
            ) : (
              'Send reset link'
            )}
          </Button>
        </form>

        {mode !== 'reset' && (
          <p className="text-center text-sm text-muted-foreground">
            {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
            <button
              type="button"
              onClick={() => switchMode(mode === 'login' ? 'signup' : 'login')}
              className="text-brand transition-colors hover:underline"
            >
              {mode === 'login' ? 'Sign up' : 'Sign in'}
            </button>
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
