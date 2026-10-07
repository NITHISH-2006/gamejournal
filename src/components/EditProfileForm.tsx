'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { updateProfile } from '@/app/actions/profiles';
import { useToast } from '@/components/Toast';
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
import { Settings, Loader2 } from 'lucide-react';
import { LIMITS } from '@/lib/validation';

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

/**
 * Profile editor.
 *
 * `updateProfile` existed as a Server Action but was never called from any
 * component, so display name, bio and username were permanently unsettable
 * from the UI. This wires it up, with the same validation the server applies
 * and a clear message when a username is already taken.
 *
 * Two bugs this deliberately avoids, both of which destroyed user data:
 *
 *  1. The form used to initialise `displayName`/`bio` to `''` and send them on
 *     every save. Because the server maps an empty string to NULL, simply
 *     opening the dialog to change your username erased your display name and
 *     bio. The state is now seeded from the real profile row, and the patch
 *     only carries fields the user actually changed.
 *
 *  2. The username used to be seeded from `user.user_metadata.username`, which
 *     is written once at signup and never updated. After a rename the form
 *     re-seeded the *old* handle, so the next save silently renamed the user
 *     back. The caller now passes the value from the `profiles` table.
 */
export default function EditProfileForm({
  username: initialUsername,
  displayName: initialDisplayName,
  bio: initialBio,
  email,
}: {
  username: string;
  displayName?: string | null;
  bio?: string | null;
  email: string;
}) {
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState(initialUsername);
  const [displayName, setDisplayName] = useState(initialDisplayName ?? '');
  const [bio, setBio] = useState(initialBio ?? '');
  const [pending, startTransition] = useTransition();
  const { toast } = useToast();
  const router = useRouter();

  // Re-seed whenever the dialog opens: `router.refresh()` can deliver a new
  // profile row while the component stays mounted, and stale form state would
  // otherwise write the old values back over the new ones.
  const handleOpenChange = (next: boolean) => {
    if (next) {
      setUsername(initialUsername);
      setDisplayName(initialDisplayName ?? '');
      setBio(initialBio ?? '');
    }
    setOpen(next);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const handle = username.trim().toLowerCase();
    if (!USERNAME_RE.test(handle)) {
      toast(
        `Username must be ${LIMITS.usernameMin}-${LIMITS.usernameMax} lowercase letters, numbers or underscores.`,
        'error'
      );
      return;
    }

    // Send only what changed. This is the real fix for the data loss: a field
    // the user did not touch is absent from the patch, so the server cannot
    // null it out.
    const patch: {
      username: string;
      display_name?: string;
      bio?: string;
    } = { username: handle };

    if (displayName !== (initialDisplayName ?? '')) {
      patch.display_name = displayName;
    }
    if (bio !== (initialBio ?? '')) {
      patch.bio = bio;
    }

    startTransition(async () => {
      try {
        const result = await updateProfile(patch);
        toast('Profile updated');
        setOpen(false);
        router.refresh();
        if (result.username && result.username !== initialUsername) {
          router.push(`/user/${result.username}`);
        }
      } catch (err) {
        toast((err as Error).message ?? 'Could not update your profile', 'error');
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="glass" size="sm">
          <Settings />
          Edit profile
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit your profile</DialogTitle>
          <DialogDescription>
            Signed in as {email}. Changes to your username update your public
            profile link.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="pf-username" className="text-xs font-medium text-muted-foreground">
              Username
            </label>
            <Input
              id="pf-username"
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase())}
              required
              minLength={LIMITS.usernameMin}
              maxLength={LIMITS.usernameMax}
              pattern="[a-z0-9_]+"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="pf-display" className="text-xs font-medium text-muted-foreground">
              Display name
            </label>
            <Input
              id="pf-display"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Optional name shown on your profile"
              maxLength={LIMITS.displayNameMax}
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label htmlFor="pf-bio" className="text-xs font-medium text-muted-foreground">
                Bio
              </label>
              <span className="text-[0.65rem] tabular-nums text-muted-foreground">
                {bio.length}/{LIMITS.bioMax}
              </span>
            </div>
            <Textarea
              id="pf-bio"
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="Tell other players about your taste"
              maxLength={LIMITS.bioMax}
              className="min-h-20"
            />
          </div>

          <Button type="submit" variant="primary" disabled={pending} className="w-full">
            {pending ? <Loader2 className="animate-spin" /> : null}
            Save changes
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
