# GameJournal 🎮

**A social platform for video game tracking, reviews, and discovery.**

[Live site](https://gamejournal.vercel.app/) · Built with Next.js 16, React 19, Supabase and Tailwind CSS 4

---

## The Vision

GameJournal is a Letterboxd-style gaming journal. Log what you play, rate it out of
ten, write a review, and see what your friends picked up this week. It is built to be
used daily, not just demoed: every action is validated server-side, rate limited,
and the UI degrades gracefully when the database is slow or a feature is
unavailable.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16.2.6 (App Router, Turbopack, React 19.2) |
| Styling | Tailwind CSS 4 with OKLCH tokens, `backdrop-filter` glass, custom neumorphic utilities |
| Backend | Supabase — PostgreSQL, Auth, Realtime, Row Level Security |
| Data fetching | Server Actions with React `cache()` request deduplication |
| Game metadata | IGDB (Twitch) API, proxied server-side and cached in Postgres |
| UI primitives | shadcn/ui on Radix, Lucide icons |
| Social previews | `next/og` dynamic OG images on the Edge runtime |
| Deployment | Vercel |

---

## Quick Start

```bash
git clone https://github.com/NITHISH-2006/gamejournal.git
cd gamejournal
npm install
cp .env.example .env.local   # then fill in the values
```

### 1. Environment

```bash
# .env.local
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
IGDB_CLIENT_ID=your-igdb-client-id      # optional
IGDB_CLIENT_SECRET=your-igdb-client-secret  # optional
NEXT_PUBLIC_SITE_URL=https://your-domain.com
```

Both Supabase variables are required — the app fails fast with a clear message if
they are missing, rather than erroring deep inside the SDK. The check runs when a
client is created, not at import time, so `next build` still succeeds without them.
The IGDB pair is optional: without it, game search falls back to the local `games`
cache and the UI explains that search is unavailable.

### 2. Database

> **Read this before assuming a migration will upgrade an existing database.**
> An earlier version of this README claimed `001_init.sql` was idempotent and
> "also upgrades an existing database in place". **That is false, and acting on it
> is what caused most of the problems documented in `AUDIT_REDESIGN_REPORT.md`.**
>
> `001_init.sql` creates every table with `create table if not exists`. On a table
> that already exists that statement is a **complete no-op** — it cannot add a
> column, cannot add a foreign key, cannot change a policy. So re-running it
> against an existing database reports success and changes nothing, and the
> resulting drift is completely invisible. A project created from an earlier
> revision of `001` is missing columns, foreign keys, functions and RLS policies
> that the current `001` text appears to promise.

For a **fresh** database, run both, in order:

```
supabase/migrations/001_init.sql             # schema, RLS, base functions
supabase/migrations/002_fixes_and_features.sql  # columns, FKs, 9 RPCs, policies, triggers
```

For an **existing** database, run **`002_fixes_and_features.sql` on its own.**

`002` is self-sufficient and does not need `001` re-run. Every change in it is an
explicit `alter table … add column if not exists`, a guarded `add constraint`, or a
`create or replace function`, so it is genuinely idempotent and safe to re-run.
It adds:

- **Columns** — `game_logs.playtime_hours`, `is_favorite`, `has_spoilers`,
  `updated_at`; `lists.kind`, `updated_at`; `notifications.game_id`;
  `comments` table; surrogate `id` on `follows` and `log_likes` (backfilled)
- **Foreign keys** — including `game_logs.user_id → profiles.id`, without which
  PostgREST cannot embed a log's author and every game page loses its
  "Community logs" section
- **All 9 RPCs** — `get_game_stats`, `get_log_likes`, `get_top_rated_games`,
  `get_trending_games`, `get_user_activity_stats`, `get_user_log_history`,
  `get_year_in_review`, `search_logs`, `upsert_game`
- **RLS corrections** — most importantly the notification insert policy, which
  compared the caller to the *recipient* and therefore rejected 100% of inserts
- **Grants** — `select` on `lists` for `anon`, so public lists stop 404ing for
  signed-out visitors; and `revoke insert/update/delete on games`, routing writes
  through a `SECURITY DEFINER` `upsert_game`
- **The `handle_new_user` signup trigger**, which lowercases usernames correctly
  (the earlier version *stripped* capitals, so `Alice` became `lice`)

`supabase/seed.sql` optionally inserts a few games for local development.

> **The app works on both sides of the migration.** Every query that touches a
> 002-only column or RPC tries progressively simpler projections and uses the
> first one the database accepts, so the feed, game pages, notifications and
> leaderboards all render before `002` is applied. The one feature with no
> fallback is **notification inserts**, because the RLS rejection is server-side
> and cannot be worked around from the client. See `RUN-THIS-FIRST.md`.

### 2a. Supabase Auth configuration

Two project settings in the Supabase dashboard affect sign-in and are not visible
from the code:

- **Site URL** — used as the fallback redirect target when `emailRedirectTo` is
  not supplied. The app now always supplies it, pointing at
  `<origin>/auth/callback`, but the setting should still match your deployment.
- **Redirect URLs** — add both `http://localhost:3000/auth/callback` and your
  production `/auth/callback`, or confirmation links will be rejected.

Confirmation and recovery links arrive as `/auth/callback?code=…` (PKCE) and are
exchanged for a session by `src/app/auth/callback/route.ts`. That route is
required — without it nobody who has to confirm their email address can finish
signing in.

### 3. Run

```bash
npm run dev     # http://localhost:3000
npm run build   # production build
npm start       # serve the build
npm run lint    # eslint
```

---

## Features

### Logging
- IGDB-backed search with debouncing, keyboard navigation and race-safe responses
- Status: Playing, Completed, Backlog, Abandoned
- 10-point star rating, optional review, tags, diary date
- Playtime hours, favourites, spoiler flags (migration-gated)
- **One entry per game** — re-logging updates in place instead of duplicating

### Comments
- Per-log threads, nested replies
- Optimistic insert via `useOptimistic`, so a comment appears immediately and
  reconciles rather than flickering
- Batched author resolution — one query for all authors across all visible logs
  instead of one per log
- Edit and delete your own; replies quote the parent

### Stats
- Activity streaks (current and longest)
- Year in review: games completed, hours played, top genres, average rating
- Per-status breakdown and a log-history sparkline on the profile
- Backed by `get_user_activity_stats` / `get_year_in_review`, with working
  JavaScript equivalents so the panel renders before the migration

### Social
- Activity feed with **Global**, **Following** and **Trending** views
- Cursor pagination with "Load more" — server-rendered first page, so the feed is
  in the initial HTML rather than fetched after hydration
- Supabase Realtime: new posts appear without a refresh
- Follow/unfollow with live follower counts, plus a followers/following list
- Notifications for likes, follows and comments, with a Realtime subscription
- Player search, suggested accounts, and a ⌘K command palette

### Discovery
- Top-rated leaderboard using IMDb-style confidence shrinkage, so one 10/10 rating
  cannot top a well-reviewed game
- Trending games for the last 7 days
- **Full-text review search** across every public review, with keyset pagination
- Player search with bios

### Library
- Public profiles with cover wall, stats, public lists and recent logs
- Custom lists with public/private visibility, rename and delete
- Auto-managed "Plan to Play" watchlist
- Edit and delete any of your own logs

### Reliability
- Every write action validates input server-side
- Rate limiting on all mutations and on the outbound IGDB calls
- Authoritative toggle actions return final state, so the UI cannot drift
- `error.tsx`, `not-found.tsx`, a loading state on `/discover`, and error
  boundaries around each independently-fetching island
- Security headers, a production Content-Security-Policy, and Supabase session
  refresh in `src/proxy.ts`
- Graceful degradation: missing RPCs, missing columns, missing foreign keys and
  missing IGDB credentials all fall back instead of throwing — see §5 of the
  design notes below for how that is structured

> **No test framework.** The route-status and header checks in this repo were run
> with `curl` against a running server. That is not a substitute for regression
> tests, and it has already cost time: a fix that undid an earlier fix passed
> `tsc`, `eslint`, `next build` and every route check. See the closing note in
> `AUDIT_REDESIGN_REPORT.md`.

---

## Design System

The UI blends **glassmorphism** and **neumorphism** over a dark, animated gradient
field:

- `globals.css` defines the token layer, the surface ladder, and the shadow recipe
  (light source top-left) shared by every component.
- **Glass** (`glass`, `glass-strong`, `glass-subtle`) — translucent, blurred,
  layered, with a 1px inner highlight for depth.
- **Neumorphism** (`neu-raised`, `neu-inset`, `neu-button`) — soft extrusions that
  read as carved from the surface. Buttons physically press inward on `:active`.
- **Ambient** — three slow-drifting colour orbs plus an SVG grain layer that stops
  the large gradients from banding.
- `prefers-reduced-motion` is honoured globally.

Utility classes live in `src/app/globals.css`; the reusable pieces are in
`src/components/ui-primitives.tsx`, `StarRating.tsx`, `Skeleton.tsx` and
`EmptyState.tsx`.

---

## Project Structure

```
src/
├── app/
│   ├── page.tsx                  # Feed + hero (first page fetched on the server)
│   ├── layout.tsx                # Fonts, metadata, ambient background
│   ├── globals.css               # Design system
│   ├── error.tsx  not-found.tsx  # Route-level boundaries
│   ├── auth/
│   │   ├── callback/route.ts     # PKCE exchange — REQUIRED for email sign-in
│   │   └── error/page.tsx        # Friendly failed-callback destination
│   ├── discover/                 # Leaderboards + player search + review search
│   ├── game/[id]/                # Game detail, community logs
│   ├── user/[username]/          # Public profile
│   ├── list/[id]/                # List detail
│   ├── profile/                  # Own library
│   ├── sitemap.ts  robots.ts
│   ├── actions/                  # Server Actions (one module per domain)
│   └── api/og/{game,log}/[id]/   # Dynamic OG cards
├── components/
│   ├── ui/                       # shadcn primitives, restyled
│   ├── ui-primitives.tsx         # GameCover, ProfileAvatar, StatusPill, StatTile
│   ├── Navbar  MobileNav  CommandPalette  Ambient
│   ├── ActivityFeed  LogGameModal  LogActions  LogGameButton
│   ├── AuthButton  NotificationBell  FollowButton  LikeButton  FollowList
│   ├── CommentThread  StatsPanel  ReviewSearch  SuggestedUsers
│   └── …
└── lib/
    ├── supabase.ts               # Server/browser/public clients, self-healing profile
    ├── env.ts                    # Lazy config; NEXT_PUBLIC_* must stay literal
    ├── validation.ts             # Input validation + limits
    ├── images.ts                 # Image URL allow-list (host AND pathname)
    ├── count.ts                  # Row counting that survives a missing column
    ├── notify.ts                 # Fire-and-forget notifier (no 'use server')
    ├── schema-notice.ts          # One-per-process logging for degraded paths
    ├── rate-limit.ts  limiter.ts
    ├── capabilities.ts           # Optional-column detection
    ├── revalidate.ts             # Shared cache invalidation
    ├── date.ts                   # Timezone-stable formatting
    └── types.ts
src/proxy.ts                      # Security headers, cache policy, session refresh
supabase/
├── migrations/001_init.sql       # Base schema, RLS, base functions
├── migrations/002_fixes_and_features.sql  # Self-sufficient upgrade — run this
└── seed.sql
```

---

## Notable Engineering Decisions

### Constraints worth knowing before you edit

**`'use server'` registers every export as a public endpoint.** There is no way
to opt a single export out, and every one must be `async`. This is why
`createNotification` lives in `src/lib/notify.ts` and `announceDegraded` in
`src/lib/schema-notice.ts` — both are plain internal helpers that would otherwise
have become callable endpoints. A notification action whose recipient is a
parameter is a spam primitive; RLS cannot save you, because the insert policy
keys on the *actor*, which the caller controls.

**Request headers passed to `NextResponse.next()` are an override, not a
merge.** Next collects the keys you supply and then deletes every request header
*not* in that list. Cloning first is mandatory:

```ts
const headers = new Headers(request.headers);  // clone
headers.set('x-something', 'value');
NextResponse.next({ request: { headers } });
```

Passing an empty `Headers()` deletes `cookie`, `next-action`, `content-type` and
`x-forwarded-for` on every request — which silently breaks sign-in, every Server
Action, and per-IP rate limiting. This happened here; see
`AUDIT_REDESIGN_REPORT.md` §13.

**`head: true` counts still validate the projection.** `select('id', { count,
head: true })` fails with `42703` if that column does not exist, and PostgREST
reports it with an *empty* message. `follows` and `log_likes` are keyed on
composite primary keys and have no `id`. Always use `exactCount` from
`src/lib/count.ts`, which selects `'*'`.

**A missing column or an unresolvable embed fails the whole PostgREST request,
not just that field.** That is why the feed and game pages try a *sequence* of
projections and use the first one the database accepts, rather than one query
with a try/catch. The ladder is in `src/app/actions/feed.ts`
(`runLogQuery`) and `src/app/actions/discover.ts` (`getGameLogs`).

**Degraded paths log once per process, not once per request.** The fallback
mechanism used to emit three `console.error` lines on every home page render,
which is exactly why the real errors in the log had become impossible to find.
Those failures are the mechanism, not incidents. A genuine failure — every
projection rejected — does log an error. See `src/lib/schema-notice.ts`.

### Correctness decisions

**Aggregates live in SQL.** The original Discover page selected the 100
highest-rated rows and averaged them in JavaScript, which structurally excluded
any game ranked below 100. Ranking now runs through `get_top_rated_games()`.

**The leaderboard uses confidence shrinkage, not a minimum-log floor.** An
IMDb-style `score = (avg*n + 4.0*3) / (n+3)` was chosen because a hard `minLogs`
floor solved gaming on a large site but emptied the board entirely on a small
one — with 8 logs in the whole database, nothing can reach a floor of 5, so the
primary discovery surface rendered permanently empty.

**Feed identity comes from the session.** The original `getFeedData` trusted a
client-supplied `currentUserId`, so a forged value returned another user's
following feed. `getSuggestedUsers` had the same shape and was a follow-graph
oracle over arbitrary accounts. Both now resolve the caller from the session.

**The feed's first page is fetched on the server.** It used to start empty and
call a Server Action from a `useEffect`, which made the app's main content surface
100% client-rendered: crawlers, no-JS visitors and the initial HTML all saw an
empty skeleton. `src/app/page.tsx` now fetches it and hands it to
`<ActivityFeed initialLogs … />`. Actions are still used for tab switches and
pagination, which are genuine user interactions.

**Follow and like toggles delete by composite key.** `.eq('follower_id').eq
('following_id')` rather than a surrogate `id`, so they work whether or not
`002`'s backfill has been applied. The matching existence check uses
`select('*')` — naming `id` there silently reintroduced the exact bug this
avoids, and passed every static check.

**Toggles are single actions returning authoritative state.** Separate
`like`/`unlike` actions could desynchronise the button from the database;
`toggleLike` and `toggleFollow` return final state and the UI reverts on failure.
`followUser`/`unfollowUser` and `likeLog`/`unlikeLog` exist for callers that want
idempotent behaviour, and are delete-only or insert-only respectively.

**Client search is debounced and race-guarded.** The original fired a Server
Action on every keystroke, draining the IGDB quota and producing out-of-order
results.

**Dates are formatted in UTC.** Server Components render in the server's timezone,
so `date-fns` formatting produced hydration mismatches and off-by-one-day labels.
`src/lib/date.ts` formats on a pinned UTC calendar.

**The Supabase browser client is memoised — and its type is inferred, not
annotated.** It was constructed on every render of every component that needed
it. Annotating the cache as `ReturnType<typeof createBrowserClient>` collapses
the generic: `createBrowserClient` is generic, so `ReturnType<...>` resolves its
generics to their constraints, `SupabaseClient` collapses, and
`auth.onAuthStateChange` takes an untyped callback. The same class of error had
already been fixed for `createPublicClient` by factoring the construction into a
named factory and memoising on that.

**Image URLs are allow-listed on host *and* pathname.** `next.config.ts`
configures `remotePatterns` with both, and a host-only check lets
`https://images.igdb.com/anything` through to `next/image`, which throws at
render time — a permanent 500 for every page showing that game. Enforced on both
the write side (`safeCoverUrl`) and the render side (`GameCover`), because the
render side is the only one that covers rows already in the database.

**`proxy.ts` lives in `src/`, not the repo root.** Next.js resolves the proxy
convention relative to the `app` directory, so with `src/app` the file must be
`src/proxy.ts`. A root-level `proxy.ts` builds without complaint and simply never
runs — the only headers that appeared on responses came from the two in
`next.config.ts`, so the CSP, HSTS, `Referrer-Policy` and the
`Cache-Control: private, no-store` rule on `/game`, `/user`, `/list` and
`/profile` were all silently dead. Next.js 16 deprecated `middleware` in favour of
`proxy`; `npx @next/codemod@canary middleware-to-proxy .` performs the rename, but
move the result into `src/` afterwards.

**`loading.tsx` is deliberately absent from the dynamic routes.** A
`loading.tsx` (or any `Suspense` boundary above a `notFound()` call) makes the
shell stream immediately, which commits the response to HTTP 200 before the page
component can call `notFound()`. `/game/[id]`, `/user/[username]` and
`/list/[id]` would then serve their not-found body with a 200 status — a soft 404
that search engines index as real content. Measured, then reverted. Correct
status codes are worth more here than a skeleton, so only `/discover`, which can
never 404, has one.

**Env validation is lazy, not at module scope.** `src/lib/env.ts` throws only
when Supabase credentials are actually used (`getSupabaseConfig()`), not when the
module is imported. Throwing on import meant `next build` could not collect page
data for routes that never touch the database, so a build without a populated
`.env.local` failed outright. `sitemap.xml` additionally returns just its static
routes when no credentials are configured.

**`NEXT_PUBLIC_*` must be read as literal `process.env.NEXT_PUBLIC_FOO`.** Next
inlines these by literal substitution and can only do so when the expression is
statically analysable. A helper taking `process.env[name]` compiles fine, works
on the server, and never reaches the browser — the worst failure mode, since
every route returns 200 and the app only explodes on hydration with an error
pointing at a file that plainly does have the variable. **Clear `.next` and
hard-reload after any `.env.local` change.**

**Session refresh happens in the proxy, not in a Server Component.** A Server
Component cannot set cookies, so `setAll` in `lib/supabase.ts` silently drops
refreshed tokens. `src/proxy.ts` creates a `createServerClient` and calls
`getUser()`, which validates the JWT against Supabase rather than trusting the
cookie and triggers a refresh when the access token expires. Without it,
sessions die at the ~1 hour access-token lifetime.

**Keyset cursors must carry every column in the `ORDER BY`.** The feed ordered by
`(created_at DESC, id DESC)` but paged on `created_at` alone, so any row sharing
the boundary row's timestamp was sorted strictly after it yet failed
`created_at < cursor` — and appeared on no page, with no gap reported.
`created_at` defaults to `now()`, which in Postgres is the *transaction*
timestamp, so ties are routine. Timestamps are normalised with `toISOString()`
before entering a cursor because PostgREST returns `+00:00` and a raw `+` in a
query string decodes to a space.

---

## License

MIT · Built by Nithish C.
