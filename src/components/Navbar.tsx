import Link from 'next/link';
import { createClient } from '@/lib/supabase';
import { getCurrentProfile } from '@/app/actions/profiles';
import AuthButton from '@/components/AuthButton';
import LogGameModal from '@/components/LogGameModal';
import { Gamepad2 } from 'lucide-react';

export default async function Navbar() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const profile = user ? await getCurrentProfile() : null;

  return (
    <header className="fixed top-0 inset-x-0 z-50 h-16 border-b border-zinc-800 bg-zinc-950/90 backdrop-blur-sm">
      <div className="max-w-5xl mx-auto h-full px-6 flex items-center justify-between">

        <Link href="/" className="flex items-center gap-2 font-bold text-lg tracking-tight hover:text-violet-400 transition-colors">
          <Gamepad2 className="h-5 w-5 text-violet-500" />
          GameJournal
        </Link>

        <nav className="hidden sm:flex items-center gap-6 text-sm text-zinc-400">
          <Link href="/" className="hover:text-white transition-colors">Home</Link>
          <Link href="/discover" className="hover:text-white transition-colors">Discover</Link>
          {profile && (
            <Link href={`/user/${profile.username}`} className="hover:text-white transition-colors">
              Profile
            </Link>
          )}
        </nav>

        <div className="flex items-center gap-3">
          {user && <LogGameModal />}
          <AuthButton user={user} username={profile?.username} />
        </div>
      </div>
    </header>
  );
}
