'use client';

import { useState } from 'react';
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

  const supabase = createBrowserSupabaseClient();

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    window.location.reload();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);

    if (mode === 'login') {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setError(error.message);
      else { setOpen(false); window.location.reload(); }
    } else {
      if (!usernameInput.trim()) { setError('Username is required'); setLoading(false); return; }
      if (!/^[a-z0-9_]{3,20}$/.test(usernameInput)) {
        setError('Username: 3–20 chars, lowercase letters, numbers, underscores only');
        setLoading(false);
        return;
      }
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { username: usernameInput.toLowerCase() } },
      });
      if (error) setError(error.message);
      else setMessage('Account created! Check your email to confirm.');
    }

    setLoading(false);
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
    <Dialog open={open} onOpenChange={setOpen}>
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
              required
              className="bg-zinc-900 border-zinc-700 text-white placeholder:text-zinc-500"
            />
          )}
          <Input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="bg-zinc-900 border-zinc-700 text-white placeholder:text-zinc-500"
          />
          <Input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className="bg-zinc-900 border-zinc-700 text-white placeholder:text-zinc-500"
          />

          {error && <p className="text-sm text-red-400">{error}</p>}
          {message && <p className="text-sm text-green-400">{message}</p>}

          <Button type="submit" disabled={loading} className="w-full bg-violet-600 hover:bg-violet-700 text-white">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : mode === 'login' ? 'Sign In' : 'Sign Up'}
          </Button>
        </form>

        <p className="text-center text-sm text-zinc-500">
          {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
          <button
            onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(null); setMessage(null); }}
            className="text-violet-400 hover:text-violet-300 underline"
          >
            {mode === 'login' ? 'Sign Up' : 'Sign In'}
          </button>
        </p>
      </DialogContent>
    </Dialog>
  );
}
