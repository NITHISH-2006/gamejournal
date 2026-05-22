'use client';

import { useState, useTransition } from 'react';
import { createList } from '@/app/actions/lists';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { useToast } from '@/components/Toast';
import { Plus, Loader2 } from 'lucide-react';

export default function CreateListModal({ onCreated }: { onCreated?: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [pending, startTransition] = useTransition();
  const { toast } = useToast();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    startTransition(async () => {
      try {
        await createList(name, description);
        toast('List created!');
        setOpen(false);
        setName('');
        setDescription('');
        onCreated?.();
      } catch (err: any) {
        toast(err.message ?? 'Failed to create list', 'error');
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="bg-violet-600 hover:bg-violet-700 text-white">
          <Plus className="h-4 w-4 mr-1" /> New List
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-sm bg-zinc-950 border-zinc-800 text-white">
        <DialogHeader>
          <DialogTitle className="text-white">Create a List</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            placeholder="List name (e.g. Best RPGs 2026)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="bg-zinc-900 border-zinc-700 text-white placeholder:text-zinc-500"
          />
          <Textarea
            placeholder="Description (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="bg-zinc-900 border-zinc-700 text-white placeholder:text-zinc-500 resize-none min-h-[80px]"
          />
          <Button type="submit" disabled={pending} className="w-full bg-violet-600 hover:bg-violet-700 text-white">
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create List'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
