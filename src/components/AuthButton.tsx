'use client';

import { useState, useRef } from 'react';
import { createBrowserSupabaseClient } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Loader2 } from 'lucide-react';
import Link from 'next/link';

type Props = {
  user: { email?: string } | null;
  username?: string | null;
};

export default function AuthButton({ user, username }: Props) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [usernameInput, setUsernameInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Ref guard prevents double-submit even if button re-renders before state updates
  const submitting = useRef(false);

  const supabase = createBrowserSupabaseClient();

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    window.location.reload();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting.current) return; // hard guard against double-submit
    submitting.current = true;
    setLoading(true);
    setError(null);
    setMessage(null);

    try {
      if (mode === 'login') {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) setError(error.message);
        else { setOpen(false); window.location.reload(); }
      } else {
        if (!usernameInput.trim()) { setError('Username is required'); return; }
        if (!/^[a-z0-9_]{3,20}$/.test(usernameInput)) {
          setError('Username: 3–20 chars, lowercase letters, numbers, underscores only');
          return;
        }
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { username: usernameInput.toLowerCase() } },
        });
        if (error) {
          // Surface rate limit clearly instead of raw Supabase message
          if (error.message.toLowerCase().includes('rate limit')) {
            setError('Too many sign-up attempts. Please wait a few minutes and try again.');
          } else {
            setError(error.message);
          }
        } else {
          setMessage('Account created! Check your email to confirm, then sign in.');
        }
      }
    } finally {
      setLoading(false);
      submitting.current = false;
    }
  };

  const switchMode = (next: 'login' | 'signup') => {
    setMode(next);
    setError(null);
    setMessage(null);
    setEmail('');
    setPassword('');
    setUsernameInput('');
  };

  if (user) {
    return (
      <div className="flex items-center gap-3">
        {username ? (
          <Link href={`/user/${username}`} className="text-sm text-zinc-400 hover:text-white transition-colors hidden sm:block">
            @{username}
          </Link>
        ) : (
          <span className="text-sm text-zinc-400 hidden sm:block">{user.email}</span>
        )}
        <Button variant="outline" size="sm" onClick={handleSignOut} className="border-zinc-700 text-zinc-300 hover:text-white">
          Sign Out
        </Button>
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!loading) setOpen(v); }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="border-zinc-700 text-zinc-300 hover:text-white">
          Sign In
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-sm bg-zinc-950 border-zinc-800 text-white">
        <DialogHeader>
          <DialogTitle className="text-xl text-white">
            {mode === 'login' ? 'Sign In' : 'Create Account'}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-3">
          {mode === 'signup' && (
            <Input
              placeholder="Username (e.g. gamer42)"
              value={usernameInput}
              onChange={(e) => setUsernameInput(e.target.value.toLowerCase())}
              disabled={loading}
              required
              className="bg-zinc-900 border-zinc-700 text-white placeholder:text-zinc-500"
            />
          )}
          <Input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={loading}
            required
            className="bg-zinc-900 border-zinc-700 text-white placeholder:text-zinc-500"
          />
          <Input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={loading}
            required
            className="bg-zinc-900 border-zinc-700 text-white placeholder:text-zinc-500"
          />

          {error && (
            <p className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded-lg px-3 py-2">
              {error}
            </p>
          )}
          {message && (
            <p className="text-sm text-green-400 bg-green-950/40 border border-green-900 rounded-lg px-3 py-2">
              {message}
            </p>
          )}

          <Button
            type="submit"
            disabled={loading}
            className="w-full bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-60"
          >
            {loading
              ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />{mode === 'login' ? 'Signing in...' : 'Creating account...'}</>
              : mode === 'login' ? 'Sign In' : 'Sign Up'
            }
          </Button>
        </form>

        <p className="text-center text-sm text-zinc-500">
          {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
          <button
            type="button"
            onClick={() => switchMode(mode === 'login' ? 'signup' : 'login')}
            className="text-violet-400 hover:text-violet-300 underline"
          >
            {mode === 'login' ? 'Sign Up' : 'Sign In'}
          </button>
        </p>
      </DialogContent>
    </Dialog>
  );
}
