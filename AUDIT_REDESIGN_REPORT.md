# Audit, Redesign & Feature Build — Full Record

**Date:** 30 September 2026
**Scope:** Full codebase analysis, bug fixing, glassmorphism/neumorphism redesign,
and four new feature areas.
**Final state:** `eslint` clean · `tsc --noEmit` clean · `next build` green (14 routes).

---

> **Part 2 (§12) documents a second pass** in which the root cause of the
> sign-in failures, the Server Action failures and a shared rate-limit bucket was
> found to be a single line in the proxy — plus roughly forty further defects
> from two fresh audit passes. Read §12 if you are here about sign-in,
> notifications, counts reading zero, or pagination losing rows.

---

## 0. How this was done, and what could not be

### Method

Three parallel deep-audit passes were run over the codebase, each instructed to
report only defects it could point at with a `file:line` and justify:

| Pass | Scope |
|---|---|
| Server actions + `lib/` | authorization, SQL injection, validation, rate limiting, logic, caching |
| Components + pages | hydration, `'use client'` boundaries, state/races, a11y, realtime, XSS, responsive, dead code |
| SQL migration + schema | schema mismatch vs. app code, RLS gaps, `security definer`, constraints, indexes, RPC correctness, idempotency, triggers |

Every critical claim was then **independently re-verified by hand** before any
code was written, because acting on an unverified audit is how you introduce
bugs while fixing them. The three headline findings were confirmed directly
against `001_init.sql` and the calling code (§1).

### The constraint that shaped this session

There is **no Docker and no local Postgres** in this environment. `supabase`
CLI is installed but `supabase start` requires Docker. So the app could not be
run against a real database during this work.

Two consequences, stated plainly:

1. **Everything in §1–§6 is verified statically** — by reading the schema
   against the call sites, by typechecking, by linting, by building, and by
   exercising routes over HTTP against a production build. The failures in §1
   are not inferences; they are provable from the two files quoted.
2. **The fixes cannot be confirmed end-to-end until `002` is applied to a real
   project.** Schema-level fixes (§1) are the part that most needs a live
   database to prove. The action you need to take is in §8.

Runtime verification that *was* possible, and was done, is in §7.

---

## 1. The headline finding: three features could never work

These are not polish items. Each is a feature that was shipped, wired to the
UI, and structurally incapable of functioning. I verified all three myself.

### 1.1 Unfollow and un-like were impossible

`supabase/migrations/001_init.sql:98-104` and `:109-114` define both toggle
tables with a **composite primary key and no `id` column**:

```sql
create table if not exists public.follows (
  follower_id  uuid not null references public.profiles (id) on delete cascade,
  following_id uuid not null references public.profiles (id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (follower_id, following_id),
  check (follower_id <> following_id)
);
```

But the application addresses them by `id`:

```
src/app/actions/follows.ts:34   .from('follows').select('id')
src/app/actions/follows.ts:42   .from('follows').delete().eq('id', existing.id)
src/app/actions/follows.ts:57   .select('id', { count: 'exact', head: true })
src/app/actions/likes.ts:31     .from('log_likes').select('id')
src/app/actions/likes.ts:42       .delete().eq('id', existing.id)
```

**Why it breaks.** PostgREST rejects `select('id')` against a table with no
such column: `PGRST204 Could not find the 'id' column of 'follows' in the
schema cache`. The code destructures only `{ data: existing }` and **discards
the error**, so `existing` is `null` on every call. The toggle therefore always
takes the INSERT branch. First click works. Second click hits
`duplicate key value violates unique constraint "follows_pkey"` and throws.

Consequences, all of which were live:
- Unfollow is impossible. The button fills on click one and throws on click two.
- Un-like is impossible, identically.
- `getFollowCounts` (`follows.ts:86-91`) uses the same invalid `select('id',
  {count, head})`, so it returns `null` for both counts. **Every follower and
  following number on `/profile` and `/user/[username]` rendered as 0.**
- `toggleLike` returned `{ count: 0 }` every time, so the heart count desynced
  from reality (the displayed count came from the `get_log_likes` RPC, which
  reads a different way and did work).

**Fix:** `002` adds a surrogate `id` to both tables, backfills it, promotes it
to the primary key, and preserves the composite invariant as a unique index.
The app was additionally hardened to **delete by composite key** rather than by
`id`, so it works correctly both with and without `002` applied, and a
`23505` on a concurrent double-click is now resolved by re-reading rather than
surfaced as a raw constraint error.

### 1.2 Notifications were rejected 100% of the time

`001_init.sql:472-474`:

```sql
create policy "own notifications" on public.notifications
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

Every insert in the app sets `user_id` to the **recipient** and `actor_id` to
the **caller**:

```
src/app/actions/notifications.ts:139   .insert({ user_id: userId, actor_id: actorId, ... })
src/app/actions/likes.ts:55           createNotification(log.user_id, user.id, 'like', id)
src/app/actions/follows.ts:52         createNotification(targetId, user.id, 'follow')
```

`with check (auth.uid() = user_id)` compares the caller to the recipient. It is
false in every case, so **100% of inserts fail with 42501**. The failure is
invisible: `createNotification` only `console.error`s, and both call sites use
`.catch(() => {})`.

Consequences: the notification bell, its realtime subscription, the migration's
`pg_publication` entry, and the README's "Notifications for likes and follows"
were all permanently non-functional.

**Why the fix is not just "loosen the policy".** Splitting the read and write
concerns is required:

| Question | Policy | Why |
|---|---|---|
| May I read my notifications? | `auth.uid() = user_id` | Unchanged. You still cannot read anyone else's. |
| May I insert a notification *here*? | `auth.uid() = actor_id and user_id <> actor_id` | A caller can only ever write into a bell they cannot read. Worst case is a stray notification, never a disclosure. |

`actor_id` is `NOT NULL` with `on delete cascade` (`001:147-148`), so it is
always populated and cannot be spoofed by omission. `002` also adds
`require`-equivalent defence in depth: `createNotification` now resolves the
live session and refuses to insert if `actorId` does not match it.

`createNotification` was also **removed from the public action surface** — it
lived in a `'use server'` module, so exporting it registered a public endpoint
accepting arbitrary `userId`/`type`/`logId` with no auth and no rate limit.
RLS was the only thing stopping it from being a spam primitive, and §1.2 shows
how close that was.

### 1.3 Every public list 404'd for signed-out visitors

`001_init.sql:505-506` grants `select` to `anon` on six tables. `lists` is not
among them, despite a public-read policy existing for it at `:448-450`. A
policy without a table grant is inert.

- `getListById` returned null for anonymous callers → `notFound()` → **404 for
  every public list**, signed out.
- `getUserLists` errored → the "Lists" section never rendered on public profiles.
- `sitemap.ts` queried it through the anon client and **silently emitted zero
  list URLs** — the error was destructured away, so a permission failure looked
  exactly like an empty result.

`002` adds `grant select on public.lists to anon`. The existing policies still
scope anon to `is_public = true`, so nothing is exposed.

---

## 2. Critical: one unvalidated field could take the site down

**`src/lib/validation.ts`** accepted any `https://` cover URL from the client:

```ts
const coverUrl = raw.cover_url.startsWith('https://') ? raw.cover_url.slice(0, 500) : null;
```

That value was upserted into the shared `games` table by `ensureGameCached`,
and `001_init.sql:392-398` granted authenticated users `insert, update` with
`using (true)` — no row scoping at all.

`next.config.ts` allow-lists image hosts. **`next/image` throws at render time**
on an unlisted host. So one signed-up user calling `saveGameLog` with
`cover_url: 'https://evil.example/x.png'` permanently 500'd `/game/[id]`, `/`,
`/discover`, `/profile` and `/list/[id]` for every visitor, with no recovery.
The OG routes additionally became an open fetch proxy to any HTTPS host.

**Fix, at both ends, because either alone is insufficient:**

- **Write side** — new `src/lib/images.ts` exports `isAllowedImageUrl` /
  `safeCoverUrl`, matching a regex for `images.igdb.com` and
  `*.supabase.co`. `validateGamePayload` now uses it.
- **Render side** — `GameCover` and `ProfileAvatar` check the same predicate
  and fail *closed* to the placeholder. This is the guarantee that no page can
  500, because it also covers rows already poisoned in the database, which the
  write-side fix cannot retroactively clean.
- **Database** — `002` revokes `insert, update` on `games` from
  `anon, authenticated` and routes writes through a `security definer`
  `upsert_game()` whose `on conflict` clause deliberately does **not** update
  `name`, so a client cannot rename a canonical title.

---

## 3. Silent data loss

`EditProfileForm` initialised `displayName` and `bio` to `''` and sent them on
**every** save. The server maps an empty string to `NULL`. So opening the dialog
to change your username and pressing Save silently erased your display name and
bio — with a success toast.

Compounding it, the username was seeded from `user.user_metadata.username`,
which Supabase writes once at signup and never updates. After a rename the form
re-seeded the **old** handle, so the next save renamed the user back.

**Fix:** state is seeded from the real `profiles` row (the page now fetches it
via `getOwnProfile()`), re-seeded whenever the dialog opens so a
`router.refresh()` cannot be clobbered, and the server action now receives a
**patch containing only changed fields**. An untouched field is absent from the
patch, so the server cannot null it. The server already handled `undefined`
correctly — the bug was entirely client-side.

---

## 4. Correctness bugs fixed

| # | Bug | Why it was wrong | Fix |
|---|---|---|---|
| 4.1 | `unfollowUser` / `unlikeLog` performed the **opposite** action | Both delegated to `toggle*`, so calling them on someone you didn't follow *created* the follow and fired a notification. Doc comments described behaviour the code did not implement. | Rewritten as explicit delete-only; `followUser`/`likeLog` are idempotent upserts with `ignoreDuplicates`. |
| 4.2 | `getSuggestedUsers` computed `is_following` from **anyone's** follows | `select('following_id').in(…)` with no `.eq('follower_id', …)`. `follows` is world-readable, so if *anyone* followed a candidate, the button read "Following" for a stranger. | Added the missing `follower_id` filter. |
| 4.3 | Rating limiters bypassable via header spoofing | `rate-limit.ts` keyed on the **leftmost** `X-Forwarded-For`, which is client-supplied — proxies *append* to it. Rotating it gave a fresh bucket per request, defeating every limit including the one guarding the IGDB quota. | Prefers platform-overwritten headers (`x-vercel-forwarded-for`, `cf-connecting-ip`), else the **rightmost** `X-Forwarded-For` entry. |
| 4.4 | Rate limiter scanned 10,000 entries on every request once saturated | `if (store.size < MAX_KEYS && now - lastSweep < 60_000) return;` — once the store hit the cap the first clause was permanently false, so the early return never fired again. | Time check no longer short-circuited by the size check. |
| 4.5 | Watchlist created **public** | `is_public: true` on auto-create, while `createList` defaults to private. The first watch toggle silently published a list on the user's profile with no consent and no UI. | `is_public: false`. |
| 4.6 | Watchlist located by display name | The schema has a `kind` discriminator; nothing used it. A user who made a *custom* list called "Plan to Play" had it silently adopted as their watchlist, and every watchlist action then mutated the wrong list. | `002` adds `kind` with a partial unique index for one-watchlist-per-user; lookups filter on `kind`, with a data migration for existing rows. |
| 4.7 | Capability probe cached a **transient failure** permanently | Any error that wasn't "missing column" fell through to all-`false`, was cached with no TTL and no log. One 5xx disabled playtime, favourites and spoilers for the life of the instance, silently. | Failures are logged and **not** cached; TTL added; success and "column genuinely missing" are the only cached outcomes. |
| 4.8 | `maybeSingle()` wedged re-logging for duplicate rows | `maybeSingle()` *errors* on >1 match rather than returning null, and the error was discarded — so the unique-index repair path could never repair. | Replaced with ordered `limit(1)` array reads in `logs`, `follows`, `likes`. |
| 4.9 | Spoiler flag was written but never read | `has_spoilers` appeared in no `select()` anywhere, and `game/[id]` hard-coded `hasSpoilers={false}`. A review marked "contains spoilers" rendered in the open on the feed, on profiles, and inside a **publicly cacheable OG image**. | Column now selected on every public read path and `ReviewText` honours it. |
| 4.10 | Favourite heart never rendered | `profile/page.tsx` read `log.is_favorite` but omitted it from the `select()`. | Added to the query, with `is_favorite` / `playtime_hours` also added to the public profile query. |
| 4.11 | `rating` was nullable while every type assumed a number | A null rendered the literal text `null/10`. No write path could produce one, so the DB was aligned to the app. | `002` sets `not null`, default 0, and widens the check to `0..10` (0 = logged but unrated, which the UI already handled). |
| 4.12 | `get_user_stats` counted **logs** as "watchers" | `count(*)` meant one person with five logs for a game inflated the number fivefold. | `count(distinct user_id)`, plus a true `review_count` so the tile stopped being capped at 50 by the page's `limit`. |
| 4.13 | Top-rated leaderboard was trivially gameable | `p_min_logs = 1` meant a single 10/10 outranked a game with 5,000 ratings averaging 9.5, and the #1 badge was rendered. | Default and call site raised to 5; tiebreak on log volume. |
| 4.14 | Trending was computed from an unordered 500-row slice | No `order()`, grouped in JS — two identical requests in the same second could disagree. | `002` adds `get_trending_games` ranking in SQL; the old path remains as a fallback but now has a total sort order. |
| 4.15 | Public profile never invalidated after list edits | `updateList` can flip `is_public`, but only `/profile` was revalidated, so `/user/[name]` served stale data until ISR expired. | New `src/lib/revalidate.ts` helper; list and watchlist writes now use the same full-tree invalidation as logs/likes/follows. |
| 4.16 | Sitemap listed **PNG endpoints** | 500 `/api/og/log/<uuid>` image URLs and zero real pages; 500 log UUIDs enumerable by any scraper. | Emits deduplicated `/game/<id>`; both queries now destructure `error` so a permission failure is no longer indistinguishable from empty. |
| 4.17 | `user_metadata.username` strips uppercase | `regexp_replace(…, '[^a-z0-9_]', '', 'g')` ran **before** `lower()` with no `i` flag, so every capital was deleted not lowercased. `JohnSmith` → `ohnsmith`; `ALICE` → `lice`. | `lower()` first, then strip. Also fixed the username-collision path (`on conflict (id)` didn't cover a duplicate *username*, so a race aborted the entire signup) and added a backfill for pre-existing users who currently **cannot log anything** because their missing `profiles` row fails the FK. |
| 4.18 | `username` had no DB-level format constraint | `getProfileByUsername` lowercases then does an exact `.eq()`, so any row containing a capital was permanently unreachable and 404'd. | `check (username ~ '^[a-z0-9_]{3,20}$')`. |
| 4.19 | Unclamped `limit` on follower lists | `limit = 50` is a TypeScript default, not a runtime one; `getFollowers(id, 1e9)` sent that to PostgREST. Also no `order()`, so page order was arbitrary. | `clampLimit()` with `Number.isFinite` (because `Math.min(NaN, 100)` is `NaN`, and `.limit(NaN)` rejects the whole query) and a deterministic sort. |
| 4.20 | `reviews` tile showed 50 for a game with 400 | Counted from the page's already-limited log fetch while the other three tiles came from the RPC. | `review_count` added to `get_game_stats`. |
| 4.21 | Unbounded `/profile` query | No `.limit()`, then every row rendered server-side. A 3,000-log user got 3,000 cards. | `.limit(50)`. |

### Not fixed, and why

- **Feed keyset cursor** (`feed.ts`) — genuinely drops rows sharing a boundary
  `created_at`, because `created_at` is transaction-stable so batched inserts
  tie. The fix is a composite `(created_at, id)` cursor. It is correct today
  for single-row writes and the change touches the pagination contract on the
  app's main surface, so it is flagged rather than rushed.
- **`getGameLogs` cached on a key that omits the user** — not a live leak (React
  `cache()` scopes to one render pass, and one pass has one session), but the
  memo key is unsound and would become one the moment the call site changed.

---

## 5. Client-side bugs and accessibility

### 5.1 Hydration mismatch on every route

`LogGameModal` seeded its date field with `localDateString()`, which reads
`getFullYear/getMonth/getDate` — the **server's** timezone (UTC on Vercel).
Client Components are server-rendered, and this modal is mounted from the root
layout, so **every route in the app** shipped a `value`/`max` attribute that the
browser then disagreed with, for any user not on UTC. It also pre-filled the
wrong "date played" for up to ~14 hours a day.

Fixed by initialising to `''` and populating in an effect once mounted, in the
user's own timezone.

### 5.2 Two modals stacked on `/game/[id]`

The navbar mounts a `LogGameModal` at layout level; the page mounted a second.
Both read `?log=1`, so visiting `/game/123?log=1` opened **two Radix dialogs** —
two overlays, two competing focus traps, the second `aria-hidden`ing the first.
On `/` this was avoided by accident.

Fixed by extracting `LogGameButton` (a client component, because the hosting
page is an async Server Component and hooks cannot run there), giving
`LogGameModal` controlled `open`/`onOpenChange` and a `showTrigger` prop, and
adding a `presetGame` so "Log this game" skips the search step entirely.
`?log=1` is now also stripped from the URL after opening, so a refresh or Back
no longer re-opens it.

### 5.3 Debounced search could show results for the wrong query

`UserSearch` cancelled *pending timers* but not *in-flight requests*. Typing
`ali` then `alice` could land the `ali` response last and display the wrong
players for the current query. `LogGameModal` already had the correct
request-sequence guard; `UserSearch` and the new `ReviewSearch` now use the same
pattern. The guard is also bumped **before** the early return — previously,
selecting a game mid-request left `requestId` unchanged and let the stale
response repopulate the dropdown on top of the selection.

### 5.4 Command palette was mouse-only

`onKeyDown` read `results`, which only ever held user-search hits, while
`staticActions` rendered in a separate branch. With an empty query `results` is
`[]`, so `ArrowDown` computed `Math.min(1, -1) === -1` and `Enter` did nothing.
The palette's entire premise — jump somewhere without a mouse — was broken.

Fixed by building one flat `items` array that both rendering and keyboard
navigation derive from, so they cannot disagree. Static actions are now also
query-filtered, so typing `dis` surfaces "Discover games".

### 5.5 Tabbing through the log form silently set the rating to 10

Each of the 10 star buttons was focusable **and** wired to
`onFocus={() => onChange(n)}`. With the default rating of 8, tabbing through
the form fired `onChange(1)` … `onChange(10)`, overwriting the rating before
the user touched anything. A `radiogroup` requires a roving tabindex — exactly
one tab stop. Implemented; arrow-key handling is unchanged because events bubble
to the container.

### 5.6 Other fixes

- `markAllRead` swallowed its error and returned `void`, so the client
  unconditionally zeroed the badge even when the write failed. Now returns a
  boolean and the UI reconciles.
- `like` notifications dead-ended on `/discover` because the row stored no
  `game_id`. `002` adds the column; the bell now links to `/game/<id>`.
- `'comment'` was missing from the `UserNotification['type']` union despite
  always being in the DB enum, so comment notifications rendered a follow icon.
- Search results had no `aria-live`, so a screen-reader user got no signal that
  a search completed. Added, with a result count.
- `UserSearch` declared `role="combobox"` pointing at no listbox. Added
  `role="listbox"`/`option`, `aria-controls` and `aria-activedescendant`.
- Error toasts were `role="status" aria-live="polite"`, so failures were
  announced at success priority. Now `role="alert"`/assertive.
- **Footer and toasts were hidden behind the fixed mobile tab bar.** `main` had
  `pb-24` but the footer after it had only `py-8`, and toasts sat at `bottom-6`
  under a `z-50` bar. Both fixed, including the iOS safe-area inset.
- `StarInput` focus ring and `getSuggestedUsers` follow state fixed as above.

---

## 6. The redesign

### 6.1 The research changed the brief

The brief was "blend glassmorphism and neumorphism". Searching current
practitioner writing on both produced a consistent and uncomfortable finding:
**both styles fail in production for the same reason, and it is contrast, not
taste.**

> "Neumorphism = soft monochrome embossing with two shadows. Beautiful in
> dribbble shots, an accessibility trap in production… In 2026 neumorphism is
> effectively declining, surviving only as a texture inside larger systems."
> — Setproduct, *Liquid glass vs glassmorphism*

> "If you cannot guarantee the background behind a glass panel, you cannot
> guarantee its contrast. Reserve translucency for places where the backdrop is
> controlled, and give every glass surface a solid fallback. **This single rule
> kills most glassmorphism failures.**"
> — Setproduct

> "Neumorphism's only depth cue is a soft shadow pair. It has no luminance
> difference from its own background, so it does not survive a contrast audit
> and disappears in bright light." — Gapsy Studio, UXPin, Uinkits

This app has **animated colour orbs drifting behind every panel**, so the
backdrop is definitively *not* controlled. Building "glass everywhere" here
would have meant shipping an unreadable UI.

### 6.2 The resolution: strict division of labour

Rather than compromise on the aesthetic, the two styles were each given the
job they are actually good at:

| Style | Where | Guarantee |
|---|---|---|
| **Neumorphism** | interactive controls only — buttons, wells, toggles | never behind text; always paired with a hairline border so the edge survives on a display that cannot render the shadow |
| **Glass** | elevated content surfaces | blur is always over a **scrim** (72% opaque), never a bare translucent fill, so text contrast is dominated by the panel rather than by whatever orb is behind it |
| **Solid** | anything that must be readable regardless | used automatically under the media queries below |

Concretely:

- Added `--scrim` / `--scrim-strong` and made `glass` a blur *plus* a scrim.
  `glass-strong` (menus, dialogs) is near-opaque because it carries dense text.
- Added `surface-solid` for guaranteed-readable panels.
- Every neumorphic utility gained a border. This is the accessibility
  guarantee, and it is what forced-colors mode leaves behind — the comment in
  the CSS says so, so nobody deletes it as decoration.
- `glass-subtle` is documented as **decorative only, never behind text**.

### 6.3 The contrast ramp

The single largest source of sub-4.5:1 text was opacity modifiers. Measured
against the lightest surface a label can sit on (`--surface-3`):

| Token | OKLab L | Ratio | Was |
|---|---|---|---|
| `--ink` | 0.97 | **16.3 : 1** | — |
| `--ink-muted` | 0.885 | **11.9 : 1** | `text-muted-foreground` |
| `--ink-faint` | 0.66 | **5.6 : 1** | `text-muted-foreground/70` |

`text-muted-foreground/50` computed to **~3.5:1** and `/60` to **~4.2:1** — both
failures, and they appeared on reviews, timestamps, follower counts and list
descriptions. `--muted-foreground` was also brightened from `0.68` to `0.755` for
shadcn primitive compatibility.

All 14 low-opacity text usages across the app were migrated to the measured
ramp; the production CSS bundle was verified to contain **zero** remaining
`text-muted-foreground/NN` classes.

### 6.4 Accessibility modes

`prefers-reduced-transparency` was the documented mitigation for exactly this
design language, and it was absent. All four are now handled:

- **`prefers-reduced-motion`** — existed; extended to also stop the orbs, which
  are decoration and the most expensive thing on the page to composite.
- **`prefers-reduced-transparency`** — every translucent surface collapses to
  solid, orbs are removed, body gradients dropped. Nothing becomes unreadable.
- **`prefers-contrast: more`** — strengthens the text ramp and hairlines,
  removes blur.
- **`forced-colors: active`** — strips blur and soft shadows, converts surfaces
  to `Canvas` with `CanvasText` borders. This is precisely why the borders were
  added in §6.2.

The focus ring was also upgraded to a two-tone ring (brand outline plus a dark
offset shadow) so it stays visible on a light surface, a dark one, *and* a
brand-coloured button — a single-tone ring disappears on one of those.

---

## 7. Verification performed

Against a **production build**, with placeholder credentials so every Supabase
call fails (which also exercises the graceful-degradation paths):

```
public routes        /  200   /discover  200   /robots.txt  200   /sitemap.xml  200
nonexistent          /user/nobody  404   /game/999999  404
                     /list/<uuid>  404   /game/abc  404
unauthenticated      /profile -> 307 with cache-control: private, no-store
```

Server log confirmed the new RPC and its fallback fail **independently and are
logged distinctly**, while every page still renders:

```
[discover] get_top_rated_games error: TypeError: fetch failed
[discover] get_trending_games error: TypeError: fetch failed
[discover] getTrendingGames fallback error: TypeError: fetch failed
```

CSS bundle assertions (86,802 bytes, fetched from the running server):
`--ink`, `--ink-muted`, `--ink-faint`, `--scrim`, `surface-solid`,
`prefers-reduced-transparency`, `prefers-contrast`, `forced-colors`,
`prefers-reduced-motion` all present; **0** low-opacity text classes remaining.

`eslint` clean · `tsc --noEmit` clean · `next build` green.

The temporary `.env.local` used for this was deleted, so no fake credentials
remain in the tree or baked into the build output.

---

## 8. What you need to do

> Superseded in detail by **`RUN-THIS-FIRST.md`**, which carries the current
> runbook and a 10-step verification order. The short version: run
> `supabase/migrations/002_fixes_and_features.sql` in the Supabase SQL editor.
> It is self-sufficient and idempotent — you do not need to re-run `001`.
>
> **Re-running `001_init.sql` will not help.** It uses
> `create table if not exists`, which is a complete no-op on an existing table:
> it cannot add a column, a foreign key or a policy. That is why the drift on
> this project was invisible for so long, and why an earlier version of the
> README wrongly claimed it "upgrades an existing database in place". The README
> has been corrected.

`002` is additive and idempotent, and applies on top of any `001` database
without a reset. Two statements, in this order:

1. Supabase dashboard → **SQL Editor** → run **`supabase/migrations/001_init.sql`**
   (only if you have never run it).
2. Run **`supabase/migrations/002_fixes_and_features.sql`**.

Then set `.env.local`:
```
NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
```

**What to check first**, in this order, because it is the order of severity:

1. Sign up. The profile should be created with your username in **lowercase**
   (`Alice` → `alice`, previously `lice`).
2. Follow someone. **The count must change and stay changed** — unfollow now
   works, which it never did.
3. Like a log. Same check, plus a like notification should appear in the bell.
   This is the feature that had never once worked.
4. Signed out, open a public list. It should 200, not 404.
5. Edit your profile: change only the username, save, and confirm the display
   name and bio survived.
6. `/discover` — leaderboard, trending, and the new review search.
7. `/profile` — streaks, year in review, followers/following toggle.

If you have **existing** data, `002` backfills the `follows`/`log_likes` ids and
provisions `profiles` rows for any pre-existing auth users who currently cannot
log anything (their FK fails). Worth checking `supabase/migrations/002_fixes_and_features.sql`
§7 for what it touches.

---

## 9. New features

All four requested areas are implemented. Each depends on `002`.

### Comments — per-log threads
`comments` table with RLS, a `comment` notification type, and `game_id` /
`comment_id` on notifications so comment notifications can link somewhere real.
Threads are per-log, not per-game, so a popular game does not collapse into one
unreadable wall. `CommentThread` uses `useOptimistic`, so a rejected post drops
its pending row automatically instead of being left behind — the failure mode
the previous manual `setComments` approach had. The game page resolves all
threads in **one batched query** (`getCommentsForLogs`); per-log resolution
would have been up to 50 round trips per page view.

### Stats, streaks and year in review
`get_user_activity_stats` (one row, whole dashboard in a single round trip),
`get_user_log_history`, and `get_year_in_review`. `StatsPanel` shows current and
longest streak, playtime, favourites, and a most-played / top-rated breakdown
with proportional bars. Streaks count runs of consecutive active days ending
today **or yesterday**, so an unlogged morning does not read as a broken streak.

This replaces `getUserStats`, which fetched every rated log and averaged it in
JS — silently wrong past PostgREST's 1000-row cap, while its own comment claimed
the cost was constant. The panel renders nothing (rather than zeros) when the
functions are unavailable, because a grid of zeros reads as "this player has
done nothing" rather than "this feature isn't installed".

### Search, filters and discovery
`search_logs` replaced. The 001 version had **no caller**, no pagination (a hard
48-row cap with no way to reach row 49), ordered by `count(*)` with no tiebreak,
and built its tsvector inline for every row on every call with no index behind
it. `002` adds a stored generated `tsvector` with a GIN index, a real keyset
cursor, and a trigram index for tag matching. `ReviewSearch` on `/discover`
uses the same request-sequence guard as the other search widgets.

Also: `games_name_lower_idx` on `lower(name)` was **unusable** by the
leading-wildcard `ILIKE` the search actually issues, so every cache-hit search
was a sequential scan of the fastest-growing table in the database. Replaced
with a trigram GIN index.

### Friends activity and social graph
`FollowList` on both `/profile` and `/user/[username]`, loaded on demand rather
than eagerly (two extra queries on every navigation for a panel most visitors
never open is a poor trade). This is what makes the now-working follow toggle
legible, and it is the surface that gives follows a reason to exist.

---

## 10. Files changed

> This section covers Part 1. **Part 2 added the files marked ★ below** — see
> §12–21 for what each one is for.

**New — Part 1**
```
src/lib/images.ts                          allow-listed image hosts
src/lib/revalidate.ts                      shared cache invalidation
src/app/actions/stats.ts                   analytics + review search
src/app/actions/comments.ts                comment CRUD
src/components/CommentThread.tsx
src/components/LogGameButton.tsx
src/components/StatsPanel.tsx
src/components/FollowList.tsx
src/components/ReviewSearch.tsx
supabase/migrations/002_fixes_and_features.sql
SESSION_NOTES.md
```

**New — Part 2 (★)**
```
src/lib/count.ts                           row counting that survives a missing column
src/lib/notify.ts                          notifier, outside 'use server'
src/lib/schema-notice.ts                   one-per-process degraded-path logging
src/app/auth/callback/route.ts             PKCE exchange — was entirely missing
src/app/auth/error/page.tsx                friendly failed-callback page
```

**Rewritten**
```
src/app/globals.css          design system
src/app/sitemap.ts
src/proxy.ts   ★             header cloning + session refresh (see §13)
```

**Modified**
```
src/lib/validation.ts  types.ts  rate-limit.ts  capabilities.ts
src/lib/supabase.ts  ★      client typing, read-error handling
src/lib/limiter.ts  ★       identity-resolution failure no longer downgrades to IP
src/lib/images.ts  ★        host AND pathname
src/app/actions/{logs,likes,follows,notifications,watchlist,lists,discover,profiles}.ts
src/app/actions/feed.ts  ★  keyset cursor, projection ladder, error checks
src/app/actions/igdb.ts  ★   summary passthrough, auth + rate limit, dead code removed
src/app/actions/stats.ts  ★  cursor direction, off-by-one, NaN guards
src/app/page.tsx  ★         server-fetched first feed page
src/app/game/[id]/page.tsx   src/app/profile/page.tsx
src/app/user/[username]/page.tsx   src/app/discover/page.tsx
src/app/layout.tsx   next.config.ts (unchanged — see below)
src/components/{LogGameModal,EditProfileForm,UserSearch,CommandPalette,
                 ActivityFeed,StarRating,Toast,ui-primitives,
                 AuthButton,NotificationBell,FollowList,StatsPanel,
                 CommentThread,ReviewSearch}.tsx
README.md  ★  RUN-THIS-FIRST.md  ★
```

`next.config.ts` was **not** changed. The `images.remotePatterns` allow-list is
correct as-is; the bug was that data reached `next/image` without being checked
against it, and the fix belongs in the validation and render layers where both
new and existing rows are covered. Part 2's fix made the check match the
configured patterns exactly — hostname *and* pathname — rather than widening the
config.

---

## 11. Honest assessment

**High confidence.** The three dead features and the DoS were verified by hand
against both the schema and the call sites before anything was written; the
regression risk on those is low because the app-side changes are mostly
*defensive* (read as array, delete by composite key, clamp inputs) rather than
behavioural. The design work was verified in the shipped CSS bundle and against
a running server.

**Cannot be verified here.** Anything requiring a live database: whether `002`
applies cleanly to your specific project, whether RLS behaves as intended under
real Auth, and whether the new RPCs return what the UI expects. That is §8, and
it is a short list.

**Deliberately not done at the time.** A handful of lower-severity items (the
`error.tsx` "not found" heuristic, the dead `getSiteStats.totalPlaytime`,
unused shadcn primitives, `date-fns` as an unused dependency) were listed rather
than rushed. **The feed's composite keyset cursor from §4 has since been fixed** —
see §12.4. The rest remain, because they are pure cleanup that would obscure the
substantive diff.

**One structural risk worth naming.** This project has **no test framework**,
so none of the above is protected by regression tests. Several of the bugs here
were silent — wrong numbers, swallowed errors, features that appeared to work —
and a smoke test that asserts "follow count changes after toggling" and "like
notification appears" would have caught §1.1 and §1.2 the day they were
introduced. Given how much was found by reading rather than by running, adding
that is the highest-value next step, and it needs no database to be useful for
the rendering and a11y assertions.

**This risk is no longer hypothetical.** In Part 2 a fix written in Part 1 —
changing the follow and like toggles to delete by composite key so they would
work before the migration — *reintroduced the original bug*, because the "does
this row exist" read above it still selected `id`. It sat green through
`tsc`, `eslint` and `next build`, and was caught only by an audit pass. A single
regression test around the toggle would have caught it in seconds.

---

# Part 2 � the proxy bug, and forty more

## 12. What triggered this pass

The brief was: *"re-analyze this project and fix all the bugs and errors, fix
the sign in errors, database errors, I want it to be fully working with all the
functionality 100% working condition."*

The immediate symptom was a console error on the home page:

```
[feed] fetch failed: An unexpected response was received from the server.
    at ActivityFeed.useCallback[fetchPage] (src/components/ActivityFeed.tsx:95:17)
```

I spent a long time on that one message before finding the real cause, and the
detour is worth recording because it produced two genuine improvements anyway.

### 12.1 The detour: ruling out the data layer

I first assumed the feed query was failing. That was wrong twice over, and
checking rather than guessing is what caught both.

**Attempt 1 � a Node script against PostgREST.** I asked for specific columns
and got back a row shape containing `hours_played`, `started_at` and
`completed_at` � columns that exist nowhere in this project. `hours_played`
appeared only as a *JSON key* my own code reads, never as a column. A real
Supabase response could not look like that. **My test script was buggy**, and I
said so rather than building on the result.

**Attempt 2 � curl, raw bytes, no script.** This gave the authoritative answer:
the projection worked, the `games` embed worked, the database was fine.

**Attempt 3 � the query the action actually issues**, which embeds `profiles` as
well as `games`:

```
{"code":"PGRST200","details":"Searched for a foreign key relationship between
'game_logs' and 'profiles' ... but no matches were found."}
```

So there *was* a real bug � the missing `game_logs ? profiles` foreign key took
down the whole query, so every game page returned 200 with an empty "Community
logs" section. But it was not the reported error, and instrumenting `getFeedData`
confirmed it: the action body **never executed**. Not one log line, while the
client reported failure.

The two findings were separated and both acted on, but the reported error was
still unexplained. That took one more pass.

---

## 13. The root cause: one line in the proxy

### 13.1 What the code did

`src/proxy.ts` (renamed from `middleware.ts`, which had silently never executed
because Next 16 requires the file beside `app`) built its request headers like
this:

```ts
const headers = new Headers();                        // EMPTY
...
const response = NextResponse.next({ request: { headers } });
```

### 13.2 Why that deletes headers

Passing headers to `request.headers` is an **override, not a merge**. I verified
this in Next's own source rather than trusting a doc comment.
`node_modules/next/dist/docs/.../proxy.md` says to *clone* first:

```js
const requestHeaders = new Headers(request.headers)
requestHeaders.set('x-hello-from-proxy1', 'hello')
const response = NextResponse.next({ request: { headers: requestHeaders } })
```

and `node_modules/next/dist/server/lib/router-utils/resolve-routes.js` does the
destructive part:

```js
const overriddenHeaders = new Set();
let overrideHeaders = middlewareHeaders['x-middleware-override-headers'];
...
for (const key of Object.keys(req.headers)) {
  if (!overriddenHeaders.has(key)) { delete req.headers[key]; }
}
```

With an empty `Headers`, the override set is empty, so **every** request header
is deleted.

### 13.3 The blast radius

| Header deleted | Consequence |
|---|---|
| `cookie` | The server never saw a session. Sign-in appeared to do nothing: the navbar kept rendering "Sign in", `/profile` kept redirecting to `/`. |
| `next-action` | Server Actions were no longer recognised as Server Actions, so every `'use server'` call returned *"An unexpected response was received from the server"*. **This was the reported error.** |
| `content-type` | Same failure, in the body parser. |
| `x-forwarded-for` | `clientKey` fell through to its single `global` bucket, so every anonymous visitor shared one rate limit. |

One empty object, four unrelated-looking symptoms. This is why it survived the
earlier sessions: nothing in the symptoms pointed at the proxy.

### 13.4 Proof the fix works

The dev server log now prints, for every dispatched action:

```
POST / 200 in 1878ms (next.js: 13ms, proxy.ts: 15ms, application-code: 1848ms)
  +- � getFeedData("global", {"cursor":null,"limit":20}) in 1838ms src/app/actions/feed.ts
POST / 200 in 837ms
  +- � getLikesForLogs(["feacb31f-...",...]) in 822ms src/app/actions/likes.ts
```

Next only prints the `+- �` line when it recognises the POST as a Server Action.
**That line never appeared before the fix.** It is a direct, observable
confirmation that the header now survives.

### 13.5 Also fixed in the proxy

- **Session refresh.** A Server Component cannot set cookies, so `setAll` in
  `lib/supabase.ts` silently drops refreshed tokens. The proxy now creates a
  `createServerClient` and calls `getUser()`, which validates the JWT against
  Supabase rather than trusting the cookie, and triggers a refresh when the
  access token expires. Without this, sessions die at ~1 hour.
- **Request and response headers are separate objects.** They were the same
  object, which is the only reason the response headers appeared at all.
- **`/auth/*` and `/api/og/*` are skipped** for the refresh, so the OG routes
  stay statically renderable.

---

## 14. Sign-in was also missing its callback route

**`/auth/callback` did not exist at all.** Supabase's browser client uses PKCE,
so every confirmation and recovery link arrives as `/auth/callback?code=�` and
the code must be exchanged for a session by a server route. Anyone who had to
confirm their email address could not finish signing in.

Added `src/app/auth/callback/route.ts`:

- Handles `code` (PKCE) **and** `token_hash` (implicit / older links), because
  which one arrives depends on the project's Auth settings.
- Re-applies Supabase's own per-cookie attributes on the redirect.
  `NextResponse.redirect` *replaces* the response, so anything set on it during
  the exchange is lost � the session cookies have to be copied across manually or
  they never reach the browser.
- **Rejects off-site `?next=` values.** Without this the callback is an open
  redirect: a victim clicks a legitimate-looking Supabase link, signs in, and is
  handed to an attacker's page with a valid referrer. `//evil.com` and `/\evil.com`
  are both protocol-relative to a browser, so a naive "must start with /" check
  is insufficient.

Also in `AuthButton`:

- `emailRedirectTo` is now set on sign-up and password reset. Previously unset, so
  Supabase fell back to the GoTrue **Site URL** project setting � invisible from
  the code, and a confirmation link generated locally could point at localhost.
- `onAuthStateChange` ? `router.refresh()`. Without it the server-rendered tree
  never updated on sign-in; a hard `window.location.href` papered over it for
  password sign-in but not for the email-confirmation flow, where the session is
  established *after* the page has rendered.
- `signOut()` now reads `{ error }`. It resolves rather than throws on an API
  failure, so a failed sign-out used to show the success toast and navigate away.
- The Supabase client is created with `useMemo` instead of on every render, which
  was also evaluated during SSR.
- `src/app/auth/error/page.tsx` is a Server Component reading `searchParams`, not
  a Client Component filling in state via `useEffect`.

---

## 15. Counts that silently read zero

### 15.1 The root cause: `select('id', { count })` on tables with no `id`

`follows` is keyed `(follower_id, following_id)` and `log_likes` is keyed
`(user_id, log_id)`. **Neither has ever had an `id` column** � 002 adds one.

With `head: true` no rows come back, so the named column is only used to validate
the projection. Naming a missing column fails the *whole* request with `42703`,
and PostgREST reports it with an **empty error message**. The code destructured
`count` and never touched `error`, so `count ?? 0` turned a database error into
a confident `0`.

The symptom was a follower count of 0 and a like count of 0 on a database with
real rows, and a log line reading:

```
[follows] follower count error:
```

� nothing after the colon.

Added `src/lib/count.ts` with `exactCount`, which selects `'*'` (always valid),
logs the failure with a fallback for the empty-message case, and is used for the
join-table counts. The `'*'` argument is spelled out in the file's doc comment so
it does not get "tidied" back to a column name.

### 15.2 The same bug, three more times

The Part 1 fix for �1.1 � make the toggles delete by composite key so they work
before the migration � **reintroduced the original bug**. The "does this row
already exist?" read above the delete still used `select('id')`:

- It failed with `42703` and an empty message.
- The error went unchecked, so the result was `null`.
- The toggle therefore always took the INSERT branch.
- **Unfollow and un-like were impossible again** � the exact bug �1.1 was written
  to fix, live on a database that has not run the migration.

All three reads now use `select('*')` and check the error. This is the single
strongest argument in the project for the missing test framework (�11): this
regression passed `tsc`, `eslint` and `next build` and was caught only by an
audit pass.

### 15.3 Fourteen unchecked counts

The same pattern � `count ?? 0` with no error check � appeared across
`getFeedTotals`, `getSiteStats`, and eight separate aggregates in `getUserStats`.
The worst was `favoriteCount`, which filters on `is_favorite`, a column 002 adds:
on a pre-002 database that query fails and the user's Favourites tile reads 0
forever. "No favourites" and "broken query" were indistinguishable.

All of them now go through `exactCount`.

---

## 16. Security

### 16.1 `createNotification` was a public endpoint with a client-chosen recipient

Its doc comment claimed *"This is intentionally NOT a Server Action."* It was.
A `'use server'` module registers **every** `export async function` as an
invocable endpoint � there is no way to opt one out.

The only guard asserted the **actor** against the live session. The **recipient**
was entirely client-supplied, and RLS could not help: 002 defines the insert as
`with check (auth.uid() = actor_id and user_id <> actor_id)`, which a caller
satisfies by passing their own id as `actor_id`. So any authenticated user could
insert unlimited, un-rate-limited rows into anyone's bell with an
attacker-chosen `type`, `game_id` and `comment_id` � and because the bell renders
the actor's username and links to `/game/<game_id>`, the planted rows looked
entirely plausible.

Moved to `src/lib/notify.ts`, a module with no `'use server'`. All three callers
were already internal server actions, so this costs nothing. It also gained a
degraded insert for a pre-002 database.

The same constraint then bit me: I put a synchronous `announceDegraded` helper in
`actions/feed.ts` and got `Server Actions must be async functions`. It lives in
`src/lib/schema-notice.ts` instead.

### 16.2 `getSuggestedUsers` took the caller's identity as a parameter

`getSuggestedUsers(currentUserId)` is exported from a `'use server'` module, so
`currentUserId` was attacker-controlled. Passing another user's id returned, for
25 profiles, *their* follow state � a follow-graph oracle over arbitrary
accounts. The `following` feed view had already been fixed for exactly this and
documented why; this one was missed. It now resolves the viewer from the session
and takes no argument.

### 16.3 Two endpoints that spent IGDB quota and repointed cover art

- **`getGameDetails`** � no callers, no `requireUser()`, no `enforce(...)`, and
  every failure swallowed to `null` with no log. A public quota drain against the
  same client credentials `searchGames` rate-limits. Removed.
- **`ensureGameCached`** � no auth, no rate limit. `upsert_game` is
  `SECURITY DEFINER`, so any signed-in user could invoke it directly and repoint
  a canonical game's `cover_url`, bypassing the limiter. Now requires a session
  and is rate-limited; both callers already had one.
- **`export { getCapabilities }`** in `actions/lists.ts` � a dead re-export whose
  stated reason was wrong (it had nothing to do with privacy, and the watchlist
  imports it from `lib/capabilities`). Being `async` and exported from a
  `'use server'` module was enough to make it an endpoint that runs a database
  probe on demand. Removed.

### 16.4 The image allow-list was checking the wrong half of the pattern

`isAllowedImageUrl` checked **only the hostname**, while `next.config.ts`
configures `hostname` *and* `pathname`. So
`https://images.igdb.com/anything` passed the write-side check and the render-side
check, and was then handed to `next/image`, which throws because the configured
pattern is `/igdb/image/upload/**`.

That is the precise site-wide 500 the file exists to prevent, and the mitigation
was incomplete at both ends. It also now rejects non-standard ports and requires
the Supabase path to be `/storage/v1/object/public/�` � the REST and auth
endpoints share that host.

### 16.5 A failed read could become a write

`requireProfile` destructured `data` and ignored `error`, so a failed read fell
through to the self-heal `INSERT`, which collided with the very row it failed to
read (23505) and reported *"Could not load your profile. Please sign out and
back in"* � a write provoked by a read error, with instructions that would not
fix it. The read error is now distinguished from a genuinely missing row.

`getOrCreateWatchlist` had the same shape, plus a logged-then-ignored error that
fell through to an `INSERT` guaranteed to violate the uniqueness constraint,
producing *"Could not create your watchlist"* from a transient read blip.

`callerKey` swallowed **every** `requireUser` failure, not just "not signed in" �
including a misconfigured project and a network error. During an auth outage
every signed-in user was bucketed by IP, so one office throttled everyone and
`enforce` threw `RateLimitError` at users who had done nothing wrong.

---

## 17. Pagination that lost rows

### 17.1 The feed dropped every row tied with the page boundary

The feed orders by `created_at DESC, id DESC` but paged on `created_at` alone,
filtering `created_at < cursor`. A row sharing the boundary row's timestamp has
a different id, so it sorts strictly *after* the boundary row � yet its
`created_at` is not `< cursor`. It appeared on no page, and no page reported a
gap.

`game_logs.created_at` defaults to `now()`, which in Postgres is the
*transaction* timestamp, so every row written by one insert shares it. The
predicate is now the standard two-clause disjunction, and the cursor carries both
columns:

```
created_at < c  OR  (created_at = c AND id < i)
```

One subtlety worth recording: the timestamp is normalised with `toISOString()`
before it enters the cursor. PostgREST returns `2024-01-01T00:00:00+00:00`, and
a raw `+` in a query string decodes to a space � the comparison would have been
silently against the wrong instant. `.or()` is inserted verbatim, so values must
be free of characters needing escapes; `�Z` is.

### 17.2 `searchReviews` paged backwards

```sql
-- in 002, as originally written
order by a.match_count desc, a.game_id asc
where (a.match_count, a.game_id) < (p_after_rank, p_after_game)
```

The row comparison expands to `match_count < c OR (match_count = c AND game_id < d)`.
The first clause is right; **the tiebreaker is inverted.** With `game_id` ascending,
the rows that follow a boundary row have a *greater* game_id. So within every
group of equally-matching games the query walked backwards, re-serving rows the
previous page had returned and permanently skipping the rest of the group.

Fixed in the migration:

```sql
where p_after_rank is null
   or a.match_count < p_after_rank
   or (a.match_count = p_after_rank and a.game_id > p_after_game)
```

### 17.3 Pagination stopped dead at 48 results

`searchReviews` capped `take` at 48 and requested `p_limit: take + 1` = 49, but
the SQL clamps to `least(p_limit, 48)`. So at most 48 rows arrived, `hasMore`
was `48 > 48` = false, and `nextCursor` became `null` � the probe row could never
arrive at the cap. `take` is now 47.

### 17.4 Non-deterministic "trending"

Two places selected 500 matching rows with **no `order()`** and aggregated in
JavaScript. Postgres may return any 500 of the matching rows, so two identical
requests in the same second could disagree about the ranking. Both now order
explicitly.

The feed's trending path had a second problem: it fetched
`.in('game_id', ranked).limit(limit * 2)` and de-duplicated in JavaScript, which
is a guess � if the newest 40 rows belonged to four games, the other six ranked
games never appeared. It now issues one bounded `limit(1)` query per ranked game,
which cannot under-fill. `nextCursor: null` is correct there, not a stub:
trending is a ranked top-N set, not a paged stream.

---

## 18. Wrong answers, not just wrong code

### 18.1 The missing FK took down whole pages

A missing column or unresolvable embed fails the **entire** PostgREST request, not
just the field. `profiles ( username )` failing with PGRST200 meant every game
page returned 200 with an empty "Community logs" section, and the feed lost every
author. The only evidence was one server log line.

Both now try four projections in order and use the first the database accepts,
resolving usernames in a second query on the degraded path. The ladder is visible
in the log.

### 18.2 `normalize()` dropped the columns it had selected

`has_spoilers` and `is_favorite` were in the `SELECT` but not in the `FeedLog`
built from it � so spoiler reviews would have rendered in full *even after* the
migration fixed the column. The field being optional is why TypeScript never
objected.

### 18.3 `getGameStats` fallback averaged in the zeros

002 backfills null ratings to 0 and then sets `rating NOT NULL`, where 0 means
"logged but unrated". The fallback used `.not('rating', 'is', null)` � which, after
002, matches *every* row � and averaged all of them, while the RPC filters
`rating > 0`. The same game therefore showed two different averages depending on
whether the migration had been applied. Both paths now filter `rating > 0`.

`ratingCount: row.rating_count ?? logs.length` had a related bug: `rating_count` is
`(select count(*) �)`, never null, so the fallback arm was dead � but had it
fired it would have substituted a 50-capped page length into a "how many people
rated this" field.

`.limit(2000)` on the leaderboard fallback also exceeded PostgREST's default
`db-max-rows` of 1000, so the server silently truncated to 1000 and the averages
were an average of an arbitrary subset. That limitation is exactly why 002 ships
the RPC.

### 18.4 Unguarded `Number()` producing `NaN`

`Math.max(NaN, 1)` is `NaN` and `.limit(NaN)` makes PostgREST reject the whole
query. `feed.ts` was the one place missing the `Number.isFinite` guard its
siblings all had � and because the retry helper re-issues the query four times,
that produced four error lines and an empty feed. `Number(r.game_id)` in two
fallback aggregators turned a missing key into `NaN`, which then became a React
key and a `Record` key, colliding on the string `"NaN"`.

### 18.5 Like state failing to "0 likes, not liked by you"

The `get_log_likes` fallback never checked its errors, so a failure filled the
whole map with `{ count: 0, likedByMe: false }`. That is the worst possible wrong
answer: the UI shows an un-highlighted Like button on a post the user has already
liked, and clicking it then *un-likes* it. Same shape in `getGameLogs`, and in
the comment threads a failed author lookup attributed every comment to a user
called `"unknown"`.

### 18.6 `parseGamePayload` silently dropped `summary`

`Game.summary` is optional, so omitting it type-checked while costing every game
cached through `ensureGameCached` � a deep link to `/game/<id>`, or logging a game
by id � its description. The search path always sent a summary, so the same game
got one only if the user happened to find it via search first.

### 18.7 A username could be silently changed

`validateUsername` called `clean(value, usernameMax)`, and `clean` ends in
`.slice(0, max)`. Truncating *before* the length check made the upper bound
unreachable: a 25-character handle became 20 characters and passed, so the user
was given a different username than the one they typed, with no error. A username
is a permanent public identifier; an over-long one has to be a visible error.

---

## 19. Cleaning up the log

Chasing the real errors was made harder by the fallback ladder itself: three
`console.error` lines on **every home page render**, for failures that are the
*mechanism* rather than incidents. The real errors in that log were effectively
unfindable.

Degraded paths now announce once per process:

```
[schema] feed:global is using a fallback: pre-002 columns. Apply supabase/migrations/002_fixes_and_features.sql to remove this.
```

The condition is a property of the database, not the request, so repeating it
adds noise without information. Only a genuine failure � every projection
rejected � logs an error now.

---

## 20. Corrections to my own earlier claims

Recording these because they were stated with more confidence than they deserved.

- **"`[a-z0-9-_]` is a character-class range admitting punctuation."** Wrong. I
  wrote a test to check rather than assert it: JS treats it as `a-z`, `0-9`,
  literal `-` and literal `_`. `co-op` is accepted, and nothing extra slips in. No
  change was made.
- **"`parsed.summary` is undefined, so `upsert_game` is called with four arguments
  and fails with PGRST202."** Wrong for the call site � `?? null` means all five
  arguments *are* sent. The real defect was narrower and is �18.6.
- **"The feed error is caused by the streamed `<Suspense>` boundary."** Wrong. It
  was the proxy (�13). The Suspense boundary was genuinely inert, and removing
  it produced two real improvements that are worth keeping: the feed is now
  server-rendered, so the app's main content surface is no longer invisible to
  crawlers and no-JS visitors, and the mount-time action call is gone. But it was
  not the bug.

---

## 21. Verification

`eslint` clean � `tsc --noEmit` clean � `next build` green, 14 routes, proxy
registered, `/sitemap.xml` still static with 1h revalidation.

Against the live database:

```
/                    200   feed server-rendered, 7/7 real posts in the HTML
/discover            200   leaderboard renders all 7 real rated games
/game/115289         200   community logs populated
/user/drstone24      200   real profile, logs, follower counts
/sitemap.xml         200   static, 1h revalidate
/auth/callback       200
/auth/error          200
/profile             307   correct: redirects to / when signed out
/user/doesnotexist   404   correct status, not a soft 404
```

Server Actions dispatch (the `+- �` lines that could not appear before the proxy
fix) for both `getFeedData` and `getLikesForLogs`.

**Still not verified, and why:** anything requiring the migration to be applied �
notification inserts, public lists while signed out, the nine RPCs, the
`search_logs` cursor fix, `is_favorite` counts. These are RLS- and schema-
dependent and there is no DB password or access token available, so
`002_fixes_and_features.sql` has to be run in the Supabase SQL editor. See
`RUN-THIS-FIRST.md`.

**And one last time: there is still no test framework.** The most important fix in
this pass � a one-line change to the follow and like toggles that silently
undid Part 1's headline fix � passed every static check and every route test. A
smoke test asserting "follow count changes after toggling" would have caught it
immediately. That is the highest-value next step.
