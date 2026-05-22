'use client';

import { useState, useTransition } from 'react';
import { searchProfiles } from '@/app/actions/profiles';
import { Input } from '@/components/ui/input';
import { Search, Loader2 } from 'lucide-react';
import Link from 'next/link';

type Profile = { id: string; username: string; display_name?: string; avatar_url?: string };

export default function UserSearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Profile[]>([]);
  const [pending, startTransition] = useTransition();

  const handleSearch = (q: string) => {
    setQuery(q);
    if (q.length < 2) { setResults([]); return; }
    startTransition(async () => {
      const data = await searchProfiles(q);
      setResults(data as unknown as Profile[]);
    });
  };

  return (
    <div className="relative">
      <div className="relative">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-zinc-500" />
        {pending && <Loader2 className="absolute right-3 top-2.5 h-4 w-4 text-zinc-500 animate-spin" />}
        <Input
          placeholder="Search users by username..."
          value={query}
          onChange={(e) => handleSearch(e.target.value)}
          className="pl-9 bg-zinc-900 border-zinc-700 text-white placeholder:text-zinc-500"
        />
      </div>

      {results.length > 0 && (
        <div className="absolute top-full mt-1 w-full bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden z-10 shadow-xl">
          {results.map((p) => (
            <Link
              key={p.id}
              href={`/user/${p.username}`}
              onClick={() => { setQuery(''); setResults([]); }}
              className="flex items-center gap-3 px-4 py-3 hover:bg-zinc-800 transition-colors"
            >
              <div className="w-8 h-8 rounded-full bg-violet-600 flex items-center justify-center text-sm font-bold flex-shrink-0">
                {p.username[0].toUpperCase()}
              </div>
              <div>
                <p className="text-sm font-medium">@{p.username}</p>
                {p.display_name && <p className="text-xs text-zinc-500">{p.display_name}</p>}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
