'use client';

import { useState, useTransition } from 'react';
import { createList } from '@/app/actions/lists';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { useToast } from '@/components/Toast';
import { Plus, Loader2, Globe, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { LIMITS } from '@/lib/validation';

export default function CreateListModal({
  onCreated,
}: {
  onCreated?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const [pending, startTransition] = useTransition();
  const { toast } = useToast();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    startTransition(async () => {
      try {
        await createList(name, description, isPublic);
        toast(`"${name.trim()}" created`);
        setOpen(false);
        setName('');
        setDescription('');
        setIsPublic(false);
        onCreated?.();
      } catch (err) {
        toast((err as Error).message ?? 'Could not create the list', 'error');
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="primary" size="sm">
          <Plus />
          New list
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a list</DialogTitle>
          <DialogDescription>
            Group games however you like. You can change visibility any time.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="list-name" className="text-xs font-medium text-muted-foreground">
              Name
            </label>
            <Input
              id="list-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Best RPGs of 2026"
              required
              maxLength={LIMITS.listNameMax}
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label
                htmlFor="list-description"
                className="text-xs font-medium text-muted-foreground"
              >
                Description
              </label>
              <span className="text-[0.65rem] tabular-nums text-muted-foreground">
                {description.length}/{LIMITS.listDescriptionMax}
              </span>
            </div>
            <Textarea
              id="list-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional. What ties these together?"
              maxLength={LIMITS.listDescriptionMax}
              className="min-h-20"
            />
          </div>

          <div className="flex gap-2">
            {[
              { value: false, label: 'Private', icon: Lock, hint: 'Only you can see it' },
              { value: true, label: 'Public', icon: Globe, hint: 'Anyone with the link' },
            ].map((option) => (
              <button
                key={option.label}
                type="button"
                onClick={() => setIsPublic(option.value)}
                aria-pressed={isPublic === option.value}
                className={cn(
                  'flex flex-1 items-start gap-2.5 rounded-xl border p-3 text-left transition-all duration-200',
                  isPublic === option.value
                    ? 'border-brand/45 bg-brand/10'
                    : 'border-white/8 hover:border-white/15'
                )}
              >
                <option.icon
                  className={cn(
                    'mt-0.5 size-4 shrink-0',
                    isPublic === option.value ? 'text-brand' : 'text-muted-foreground'
                  )}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{option.label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {option.hint}
                  </span>
                </span>
              </button>
            ))}
          </div>

          <Button type="submit" variant="primary" disabled={pending} className="w-full">
            {pending ? <Loader2 className="animate-spin" /> : null}
            Create list
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
