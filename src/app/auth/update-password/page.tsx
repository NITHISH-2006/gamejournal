'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createBrowserSupabaseClient } from '@/lib/supabase';
import { LIMITS } from '@/lib/validation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * Set a new password after following a recovery link.
 *
 * This page did not exist, and that made the whole reset flow a dead end.
 * `/auth/callback` exchanged the recovery code for a real session and then
 * redirected to `/`, so the user was signed in and still held their old
 * password, with no interface anywhere in the app able to change it.
 * `PASSWORD_RECOVERY` had zero references and `updateUser` had zero references.
 *
 * The session at this point is a *recovery* session: the user proved control of
 * their email, which is what authorises the password change.
 */
export default function UpdatePasswordPage() {
  const router = useRouter();

  const [ready, setReady] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // `pending` is mirrored into a ref so two clicks in the same frame cannot both
  // pass the guard. State is not updated synchronously, so guarding on state
  // alone allows a double submit — the same bug this pattern fixed in
  // `AuthButton`.
  const submitting = useRef(false);

  useEffect(() => {
    const supabase = createBrowserSupabaseClient();

    // The recovery session is established by the callback route *before* this
    // page loads, so it should already be readable. Checking once on mount is
    // enough; there is no token left to exchange here.
    void supabase.auth.getSession().then(({ data }) => {
      setHasSession(Boolean(data.session));
      setReady(true);
    });
  }, []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting.current) return;

    setError(null);
    setMessage(null);

    if (password.length < LIMITS.passwordMin) {
      setError(`Password must be at least ${LIMITS.passwordMin} characters.`);
      return;
    }
    if (password !== confirm) {
      setError('Those two passwords do not match.');
      return;
    }

    submitting.current = true;
    setPending(true);

    try {
      const supabase = createBrowserSupabaseClient();
      const { error: updateError } = await supabase.auth.updateUser({ password });

      if (updateError) {
        // Almost always an expired recovery session: Supabase keeps the link
        // valid for a limited window, and `getSession()` above can succeed on a
        // session that can no longer authorise a credential change.
        setError(
          /session|token|expired|auth/i.test(updateError.message)
            ? 'This reset link has expired. Request a new one from the sign-in dialog.'
            : updateError.message
        );
        return;
      }

      setMessage('Password updated. Taking you to your profile…');
      // Replace rather than push: Back must not return to a spent recovery URL.
      router.replace('/profile');
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-md flex-col justify-center px-4 py-16">
      <h1 className="text-2xl font-bold tracking-tight">Choose a new password</h1>

      {!ready ? (
        <p className="mt-6 text-ink-muted" role="status">
          Checking your reset link…
        </p>
      ) : !hasSession ? (
        <div className="mt-6 space-y-4">
          <p className="text-ink-muted">
            This page needs a valid reset link. Open the most recent link from
            your email, or request a new one.
          </p>
          <Button variant="primary" onClick={() => router.push('/')}>
            Back to home
          </Button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="mt-6 space-y-5" noValidate>
          <div className="space-y-2">
            <label htmlFor="new-password" className="text-sm font-medium">
              New password
            </label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={password}
              disabled={pending}
              onChange={(e) => setPassword(e.target.value)}
              aria-describedby="new-password-hint"
              required
            />
            <p id="new-password-hint" className="text-xs text-ink-faint">
              At least {LIMITS.passwordMin} characters.
            </p>
          </div>

          <div className="space-y-2">
            <label htmlFor="confirm-password" className="text-sm font-medium">
              Confirm new password
            </label>
            <Input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirm}
              disabled={pending}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {message && (
            <p role="status" className="text-sm text-success">
              {message}
            </p>
          )}

          <Button
            type="submit"
            variant="primary"
            disabled={pending}
            className="w-full"
          >
            {pending ? 'Updating…' : 'Update password'}
          </Button>
        </form>
      )}
    </main>
  );
}