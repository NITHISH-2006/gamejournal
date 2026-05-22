'use client';

import { useState } from 'react';
import { Search, Star, Loader2, CheckCircle, Calendar } from 'lucide-react';
import { searchGames } from '@/app/actions/igdb';
import { saveGameLog } from '@/app/actions/logs';
import { useToast } from '@/components/Toast';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';

type Game = {
  id: number;
  name: string;
  cover_url?: string | null;
  release_date?: string | null;
};

const statuses = [
  { value: 'backlog', label: 'Backlog' },
  { value: 'playing', label: 'Playing' },
  { value: 'completed', label: 'Completed' },
  { value: 'abandoned', label: 'Abandoned' },
];

function reset() {
  return {
    query: '', results: [] as Game[], selectedGame: null as Game | null,
    status: 'playing', rating: 8, review: '',
    diaryDate: new Date().toISOString().split('T')[0],
    tags: '',
    error: null as string | null, saved: false,
  };
}

export default function LogGameModal() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Game[]>([]);
  const [selectedGame, setSelectedGame] = useState<Game | null>(null);
  const [status, setStatus] = useState('playing');
  const [rating, setRating] = useState(8);
  const [review, setReview] = useState('');
  const [diaryDate, setDiaryDate] = useState(new Date().toISOString().split('T')[0]);
  const [tags, setTags] = useState('');
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  const handleOpenChange = (val: boolean) => {
    setOpen(val);
    if (!val) {
      const r = reset();
      setQuery(r.query); setResults(r.results); setSelectedGame(r.selectedGame);
      setStatus(r.status); setRating(r.rating); setReview(r.review);
      setDiaryDate(r.diaryDate); setTags(r.tags);
      setError(r.error); setSaved(r.saved);
    }
  };

  const handleSearch = async (q: string) => {
    setQuery(q);
    setSelectedGame(null);
    if (q.length < 2) { setResults([]); return; }
    setSearching(true);
    const data = await searchGames(q, 10);
    setResults(data);
    setSearching(false);
  };

  const handleSelectGame = (game: Game) => {
    setSelectedGame(game);
    setQuery(game.name);
    setResults([]);
    setError(null);
  };

  const handleLog = async () => {
    if (!selectedGame) return;
    setSaving(true);
    setError(null);
    try {
      await saveGameLog(selectedGame, status, rating, review, diaryDate || undefined, tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : []);
      setSaved(true);
      toast(`${selectedGame.name} logged!`);
      setTimeout(() => handleOpenChange(false), 1200);
    } catch (err: any) {
      const msg = err.message ?? 'Something went wrong. Please try again.';
      setError(msg);
      toast(msg, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="lg" className="bg-violet-600 hover:bg-violet-700 text-white">
          <Star className="mr-2 h-5 w-5" />
          Log a Game
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto bg-zinc-950 border-zinc-800 text-white">
        <DialogHeader>
          <DialogTitle className="text-2xl text-white">Log a Game</DialogTitle>
        </DialogHeader>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-zinc-500" />
          {searching && <Loader2 className="absolute right-3 top-2.5 h-4 w-4 text-zinc-500 animate-spin" />}
          <Input
            placeholder="Search for a game..."
            className="pl-9 bg-zinc-900 border-zinc-700 text-white placeholder:text-zinc-500"
            value={query}
            onChange={(e) => handleSearch(e.target.value)}
          />
        </div>

        {/* Dropdown results */}
        {results.length > 0 && (
          <div className="border border-zinc-800 rounded-lg divide-y divide-zinc-800 bg-zinc-900 max-h-64 overflow-y-auto">
            {results.map((game) => (
              <div
                key={game.id}
                onClick={() => handleSelectGame(game)}
                className="flex gap-3 p-3 cursor-pointer hover:bg-zinc-800 transition-colors"
              >
                {game.cover_url ? (
                  <img src={game.cover_url} alt={game.name} className="w-10 h-14 object-cover rounded flex-shrink-0" />
                ) : (
                  <div className="w-10 h-14 bg-zinc-700 rounded flex-shrink-0" />
                )}
                <div>
                  <p className="font-medium text-sm">{game.name}</p>
                  {game.release_date && <p className="text-xs text-zinc-500 mt-0.5">{game.release_date}</p>}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Log form — only shown after selecting a game */}
        {selectedGame && (
          <div className="space-y-5 pt-4 border-t border-zinc-800">
            {/* Selected game preview */}
            <div className="flex gap-4 items-center">
              {selectedGame.cover_url ? (
                <img src={selectedGame.cover_url} alt={selectedGame.name} className="w-14 h-20 object-cover rounded flex-shrink-0" />
              ) : (
                <div className="w-14 h-20 bg-zinc-800 rounded flex-shrink-0" />
              )}
              <div>
                <p className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Selected</p>
                <h3 className="text-lg font-bold">{selectedGame.name}</h3>
              </div>
            </div>

            {/* Status */}
            <div>
              <p className="text-xs text-zinc-400 uppercase tracking-wider mb-2">Status</p>
              <div className="flex flex-wrap gap-2">
                {statuses.map((s) => (
                  <Badge
                    key={s.value}
                    variant={status === s.value ? 'default' : 'secondary'}
                    className={`cursor-pointer select-none ${status === s.value ? 'bg-violet-600 hover:bg-violet-700' : 'hover:bg-zinc-700'}`}
                    onClick={() => setStatus(s.value)}
                  >
                    {s.label}
                  </Badge>
                ))}
              </div>
            </div>

            {/* Star rating */}
            <div>
              <p className="text-xs text-zinc-400 uppercase tracking-wider mb-2">Rating — {rating}/10</p>
              <div className="flex gap-0.5">
                {Array.from({ length: 10 }).map((_, i) => (
                  <Star
                    key={i}
                    className={`w-6 h-6 cursor-pointer transition-colors ${
                      i < rating ? 'fill-yellow-400 text-yellow-400' : 'text-zinc-700 hover:text-zinc-500'
                    }`}
                    onClick={() => setRating(i + 1)}
                  />
                ))}
              </div>
            </div>

            {/* Diary date */}
            <div>
              <p className="text-xs text-zinc-400 uppercase tracking-wider mb-2">Date Played</p>
              <div className="relative">
                <Calendar className="absolute left-3 top-2.5 h-4 w-4 text-zinc-500 pointer-events-none" />
                <Input
                  type="date"
                  value={diaryDate}
                  onChange={(e) => setDiaryDate(e.target.value)}
                  className="pl-9 bg-zinc-900 border-zinc-700 text-white"
                />
              </div>
            </div>

            {/* Review */}
            <div>
              <p className="text-xs text-zinc-400 uppercase tracking-wider mb-2">Review (optional)</p>
              <Textarea
                placeholder="What did you think?"
                value={review}
                onChange={(e) => setReview(e.target.value)}
                className="bg-zinc-900 border-zinc-700 text-white placeholder:text-zinc-500 min-h-[90px] resize-none"
              />
            </div>

            {/* Tags */}
            <div>
              <p className="text-xs text-zinc-400 uppercase tracking-wider mb-2">Tags (comma separated)</p>
              <Input
                placeholder="e.g. rpg, masterpiece, replay"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                className="bg-zinc-900 border-zinc-700 text-white placeholder:text-zinc-500"
              />
            </div>

            {/* Error */}
            {error && (
              <p className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            {/* Submit */}
            <Button
              onClick={handleLog}
              disabled={saving || saved}
              className="w-full bg-green-600 hover:bg-green-700 text-white h-11 text-base"
            >
              {saved ? (
                <><CheckCircle className="mr-2 h-5 w-5" /> Saved!</>
              ) : saving ? (
                <><Loader2 className="mr-2 h-5 w-5 animate-spin" /> Saving...</>
              ) : (
                'Save Log'
              )}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
