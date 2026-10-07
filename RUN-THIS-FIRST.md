# Run this first

Everything in the app works except what the database schema blocks.
**Two SQL scripts fix all of it**, in order.

```
supabase/migrations/002_fixes_and_features.sql   ← run this first
supabase/migrations/003_verify_and_harden.sql    ← then this
supabase/migrations/004_social_and_sessions.sql  ← then this
```

---

## Before anything else: rotate your IGDB secret

A `IGDB_CLIENT_SECRET` was committed to this repository before `.env.local` was
gitignored, and the history has since been rewritten to purge it. **Any
previously-issued secret must be treated as compromised.**

1. Go to <https://twitch.tv/developers/console/apps>
2. Regenerate the client secret for your app
3. Put the new value in `.env.local`

Until you do, treat game search as exposed. A CI job now fails if a credential
appears in the tree or in history, so this cannot silently recur.

---

## Why the SQL is still needed

The live Supabase project (`gkxmpqzwdzxbuwkikftt`) is on a schema that is **older
than `001_init.sql` describes**. This was verified directly against PostgREST with
the anon key, not inferred:

| Missing | Consequence before the migrations |
|---|---|
| **All 11 database functions** | `get_game_stats`, `get_log_likes`, `get_top_rated_games`, `get_trending_games`, `get_user_activity_stats`, `get_user_log_history`, `get_year_in_review`, `get_suggested_users`, `upsert_game`, `search_logs`, `redact_spoilers` all returned `PGRST202` |
| **FK `game_logs.user_id → profiles.id`** | Every embed of the log author failed, so every game page lost its author name and the feed lost every poster |
| **FKs on `follows`** | Follower and following lists could not resolve their profiles |
| **FKs on `log_likes`** | Like counts could not resolve |
| **`lists.updated_at`** | The sitemap query failed outright |
| **`lists.kind`, `game_logs.playtime_hours`, `is_favorite`, `has_spoilers`, `updated_at`** | Favourites, playtime and spoiler flags invisible; the watchlist was located by a magic string |
| **`id` on `follows` and `log_likes`** | No surrogate keys for the join tables |
| **Notification RLS** | `with check (auth.uid() = user_id)` compared the caller to the *recipient*, so **100% of notification inserts were rejected**. The bell had never worked |
| **`anon` grant on `lists`** | Every public list 404'd for signed-out visitors |
| **`comments` table** | No comment threads |
| **`reports`, `play_sessions` tables** | No moderation, no session history |

### Re-running `001_init.sql` will not fix any of this

It uses `create table if not exists`, which is a complete no-op on an existing
table — it can never add a column, a foreign key or a policy. That is exactly why
the drift was invisible for so long.

`002` and `003` are different: every change is an explicit
`alter table … add column if not exists`, `add constraint`, `create or replace
function` or `do $$ … $$` block. **They are self-sufficient** — you do not need to
re-run `001` first, and they apply on top of any database without a reset.

---

## The step

**Supabase dashboard → your project → SQL Editor → New query.**

Run them one at a time, in this order. Paste the whole file and press **Run**.
Each takes a second or two. All three are idempotent, so re-running is harmless.

```
002_fixes_and_features.sql    →  schema, functions, RLS, grants
003_verify_and_harden.sql     →  the gaps 002 leaves on an older database
004_social_and_sessions.sql   →  reports, play sessions, backlog order, heatmap
```

### `003` prints a health report

This is the part worth reading. `003` ends by producing a **PASS/FAIL grid** in
the SQL editor result pane, covering:

- every function and whether it exists
- every column the application reads on a normal page render
- every foreign key the UI depends on for an embed
- data invariants: username format, no orphan logs, every auth user has a profile
  row, the signup trigger exists

If any row says `FAIL`, that is the thing to fix next. It also prints a
`PREFLIGHT` block of `NOTICE` lines at the start showing the real column list,
primary keys, foreign keys and row counts, so nothing has to be guessed.

### If the editor complains about multiple statements

Supabase's SQL editor handles multi-statement scripts natively. If your client
does not, run the files section by section in the order they appear.

---

## Set your environment

```bash
cp .env.example .env.local
```

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>

# Optional but strongly recommended — without these, game search falls back to
# whatever is already cached in the `games` table.
IGDB_CLIENT_ID=<from twitch.tv/developers>
IGDB_CLIENT_SECRET=<regenerated, see the top of this file>

NEXT_PUBLIC_SITE_URL=https://gamejournal.vercel.app
```

The build does **not** need these — `lib/env.ts` fails lazily rather than at
import, so `next build` succeeds and only the code paths that actually need
Supabase fail at request time.

---

## Then verify, in this order

Ordered by severity: each step proves something that previously could not work at
all.

**1. Hard-reload (Ctrl+Shift+R).** Otherwise you are testing a stale bundle.
`NEXT_PUBLIC_*` values and Server Action IDs are baked in at build time.

**2. Sign up with a fresh account.** The username should be lowercase.
Previously `Alice` was stored as `lice`, because the signup trigger stripped
capitals instead of lowercasing them. Also try a 25-character username: it must
now be **rejected**, not silently truncated to 20.

**3. Follow someone, then unfollow them.** The follower count must go up, then
back down.

**4. Like a log, then unlike it.** The heart must fill, the count change, then
both revert.

**5. Check the server log for `└─ ƒ` lines** after clicking Follow or Like:

```
POST / 200 in 1878ms
  └─ ƒ getFeedData("global", {"cursor":null,"limit":20}) in 1615ms
```

Next only prints this when it recognises the POST as a Server Action. If you see
it, the request headers are reaching the server.

**6. Check the notification bell.** Follow or like *someone else's* content from
a second account. This requires the migrations.

**7. Open a public list while signed out.** Previously a 404.

**8. Open a game page — `/game/115289`.** "Community logs" lists real logs with
usernames. Before the migrations, usernames were resolved by a second query
because the embed needed a foreign key that did not exist; afterwards the embed
is used and the extra query disappears.

**9. `/profile`.** Streaks, the activity heatmap, the year-in-review panel and the
followers/following toggle all populate. **Library import** appears here — try it
with a CSV or a Backlog `.xml` export, and check the dry-run preview before
committing.

**10. `/discover`.** Leaderboard, trending, review search, and the new filterable
browser.

---

## Reading the server log

Degraded schema paths announce themselves **once per process** rather than on
every request:

```
[schema] feed:global is using a fallback: 002+ columns, no author embed
              (missing game_logs -> profiles FK). Apply migration 003 to remove this.
```

Before this change the fallback ladder logged three `console.error` lines on
every home page render. Those failures are the *mechanism*, not incidents, and the
volume is exactly why the real errors in this log had become impossible to find.

So: one `[schema]` line means the app is working and the database is behind.
`[count]`, `[feed]`, `[discover]`, `[comments]`, `[sessions]` or `[import]` lines
are real and worth looking at.

---

## Two things that will look like bugs and are not

**"An unexpected response was received from the server" after editing a file.**
Hard-reload. Server Action IDs change when the module graph changes, and a stale
bundle POSTs an ID the server no longer has.

**Empty stats panels.** Some panels deliberately render **nothing** rather than
zeros when their database function is unavailable, because a grid of zeros reads
as "this player has done nothing" rather than "this feature is not installed".
The server log says which.

---

## Verifying without a database

```bash
npm run verify     # lint + typecheck + test + build
```

The test suite includes a cross-check between the SQL migrations and
`src/lib/database.types.ts`. If you add a Postgres function to a migration
without declaring it in the types, that test fails — because the mismatch
produces a call that TypeScript accepts and PostgREST rejects at runtime.