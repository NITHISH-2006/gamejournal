# Run this to finish the setup

Everything in the app works **except** what the database schema blocks.
One SQL script fixes all of it.

---

## The bug that broke sign-in, Server Actions and rate limiting

**This was not a database problem and it is already fixed.** Documented first
because it explains symptoms that looked unrelated.

`src/proxy.ts` built its request headers like this:

```ts
const headers = new Headers();                       // EMPTY
NextResponse.next({ request: { headers } });
```

Passing headers to `request.headers` is an **override, not a merge**. Next
collects the keys you supply into `x-middleware-override-headers` and then, in
`server/lib/router-utils/resolve-routes.js`, deletes every request header that is
not in that list:

```js
for (const key of Object.keys(req.headers)) {
  if (!overriddenHeaders.has(key)) { delete req.headers[key]; }
}
```

So the proxy was silently deleting, on every matched request:

| Deleted | Effect |
|---|---|
| `cookie` | The server never saw a session. **Sign-in appeared to do nothing** — the navbar kept rendering "Sign in" and `/profile` kept redirecting to `/`. |
| `next-action` | Server Actions were no longer recognised as Server Actions, so every `'use server'` call returned *"An unexpected response was received from the server"*. |
| `content-type` | Same problem, for the body parser. |
| `x-forwarded-for` | The rate limiter fell through to its single `global` bucket, so every anonymous visitor shared one limit. |

The fix is to clone the incoming headers and *add* to them, and to keep request
headers and response headers in separate objects.

**How to confirm it is fixed** — the dev server log should contain lines like:

```
POST / 200 in 1878ms
  └─ ƒ getFeedData("global", {"cursor":null,"limit":20}) in 1615ms src/app/actions/feed.ts
```

Next only prints the `└─ ƒ` line when it recognises the POST as a Server
Action. Before the fix, that line never appeared. If you see it, the
`next-action` header is reaching the server.

The proxy now also refreshes the Supabase session, which it must do from
middleware: a Server Component cannot set cookies, so `setAll` in
`lib/supabase.ts` drops refreshed tokens. Without this, sessions die silently at
the ~1 hour access-token lifetime.

---

## Sign-in also needed a callback route

`/auth/callback` **did not exist**. Supabase's browser client uses PKCE, so every
email-confirmation and password-reset link arrives as
`/auth/callback?code=…` and the authorization code has to be exchanged for a
session by a server route. With no such route, anyone who had to confirm their
email address simply could not finish signing in.

`src/app/auth/callback/route.ts` now handles both `code` (PKCE) and
`token_hash` (implicit / older links), and rejects off-site `?next=` values —
without that check the callback is an open redirect, because a victim clicking a
legitimate Supabase link would be handed to an attacker's page with a valid
referrer.

`emailRedirectTo` is now set on sign-up and on password reset. Previously it was
unset, so Supabase fell back to the GoTrue **Site URL** project setting, which is
invisible from the code — a confirmation link generated while running locally
could point at localhost.

There is also `onAuthStateChange` → `router.refresh()` in `AuthButton`, so the
server-rendered tree actually updates when the session changes. Previously
signing in from the dialog updated nothing until a full page load, and the
email-confirmation flow — where the session is established *after* the page has
rendered — left the user on a signed-out page with no way forward.

---

## Why you still need to run the SQL

Your Supabase project (`gkxmpqzwdzxbuwkikftt`) was created from an **older
revision** of the schema. I verified this directly against the live database
with the anon key. The project is missing:

| Missing | Consequence right now |
|---|---|
| **All 9 database functions** | `get_game_stats`, `get_log_likes`, `get_top_rated_games`, `get_trending_games`, `get_user_activity_stats`, `get_user_log_history`, `get_year_in_review`, `search_logs` all return `PGRST202` |
| **Foreign key `game_logs.user_id → profiles.id`** | Every PostgREST embed of the log author fails, so every game page loses the author name |
| **`lists.updated_at`** | The sitemap query fails outright |
| **`lists.kind`, `game_logs.playtime_hours`, `is_favorite`, `has_spoilers`, `updated_at` columns** | Favourites, playtime and spoiler flags are invisible; the watchlist is located by a magic string |
| **`id` on `follows` and `log_likes`** | Surrogate keys for these join tables are absent (see the correction below) |
| **Notification RLS** | `with check (auth.uid() = user_id)` compares the caller to the *recipient*, so **100% of notification inserts are rejected**. The bell has never worked |
| **`anon` grant on `lists`** | Every public list 404s for signed-out visitors |

Re-running `001_init.sql` will **not** fix this. It uses
`create table if not exists`, which is a no-op on an existing table — it can
never add a column. That is exactly why the drift was invisible.

`002_fixes_and_features.sql` is different: every change is an explicit
`alter table … add column if not exists`, `add constraint`, or
`create or replace function`. **It is self-sufficient — you do not need to
re-run `001` first.**

### Correction to an earlier claim in this file

An earlier version of this document said unfollow and un-like were *impossible*
until the migration ran. That is no longer true, and it matters because the fix
that was supposed to solve it had quietly reintroduced the bug.

`toggleFollow` and `toggleLike` now delete by **composite key**
(`.eq('follower_id').eq('following_id')`) rather than by a surrogate `id`, so
they work on both sides of the migration. But the "does this row already exist?"
read above them used `select('id')` — and `follows` and `log_likes` have no `id`
column until 002 adds it. That read failed with `42703` and an **empty error
message**, the error went unchecked, the result was `null`, and the toggle always
took the INSERT branch. That is precisely the original bug, live again.

Both reads now use `select('*')` and check the error. `select('*')` cannot fail
for a missing column, and it is also what `src/lib/count.ts` relies on — see
below.

---

## The step

**Supabase dashboard → your project → SQL Editor → New query → paste the whole
file → Run.**

The file is already on disk at:

```
supabase/migrations/002_fixes_and_features.sql
```

Open it, select all, copy, paste into the SQL editor, and press **Run**. It is
about 1,000 lines and runs in a second or two. It is idempotent, so if you
accidentally run it twice nothing breaks.

I have already confirmed there are **zero orphaned rows** in every table, so
the foreign keys will be added without discarding any data. It does not drop or
delete a single row.

### If the editor complains about running multiple statements

Run it in the order the sections appear, or paste the whole thing at once —
Supabase's SQL editor handles multi-statement scripts natively.

### If you want to see what it did

Each `create or replace function` and each foreign key emits a `NOTICE` or
`WARNING` line. A `WARNING ... SKIPPED FK` would mean an FK could not be added
because of orphan rows — paste that message to me and I will handle it
separately. On the current data that should not happen.

---

## Then verify, in this order

Ordered by severity — each step proves something that previously could not work
at all.

**1. Hard-reload the browser (Ctrl+Shift+R).** If you do not, you are testing a
stale bundle. `NEXT_PUBLIC_*` values and Server Action IDs are baked in at build
time, and the errors you see will be from the previous build.

**2. Sign up with a fresh account.** Username should be lowercase. Previously
`Alice` was silently stored as `lice`, because the signup trigger stripped
capitals instead of lowercasing them. Also try a 25-character username: it must
now be *rejected* with "Username must be 3 to 20 characters", not silently
truncated to 20.

**3. Follow another player, then unfollow them.** The follower count must go up,
then back down. This works today without the migration.

**4. Like someone's log, then unlike it.** The heart must fill, the count must
change, then both revert. Also works today.

**5. Check the server log for `└─ ƒ` lines** after clicking Follow or Like. If a
Server Action is dispatched you will see the function name and its timing. This
is how you confirm the proxy fix in step 3 and 4 rather than trusting the UI.

**6. Check the notification bell.** Follow or like someone *else's* content from
a second account. This has never worked before, and it needs the migration — the
RLS policy rejects 100% of inserts until then. The action swallows the failure by
design, so a missing notification before the migration is expected, not a new
bug.

**7. Open a public list while signed out.** Previously a 404. Needs the
migration.

**8. Open a game page — `http://localhost:3000/game/115289`.** The "Community
logs" section lists the real logs. Usernames are currently resolved by a second
query because the `profiles` embed needs a foreign key that does not exist yet;
after the migration the embed is used and the extra query disappears.

**9. `/profile` — your own dashboard.** Streaks, year in review, and the
followers/following toggle populate. Favourites stays at 0 until the migration
adds `is_favorite`.

**10. `/discover` — leaderboard, trending and review search.** The leaderboard
works today via a JavaScript fallback. Trending is legitimately empty because no
logs have been created in the last 7 days — that is correct, not a bug.

---

## Reading the server log

Degraded schema paths now announce themselves **once per process** rather than on
every request:

```
[schema] feed:global is using a fallback: pre-002 columns. Apply supabase/migrations/002_fixes_and_features.sql to remove this.
```

Before this change the fallback ladder logged three `console.error` lines on
every home page render. Those failures are the *mechanism*, not incidents, and
the volume is exactly why the real errors in this log had become impossible to
find. Only a genuine failure — every projection rejected — logs an error now.

So: if you see one `[schema]` line, the app is working and the database is
behind. If you see `[count]`, `[feed]`, `[discover]` or `[comments]` lines, those
are real and worth looking at.

---

## What is already working right now

Verified against your live database:

```
/                    200   feed server-rendered, 7 real posts in the HTML
/discover            200   leaderboard renders all 7 real rated games
/game/115289         200   real game data, community logs populated
/user/drstone24      200   real profile, logs, follower counts
/sitemap.xml         200   11 URLs (7 games + 2 lists + 2 static), static, 1h revalidate
/robots.txt          200
/auth/callback       200   PKCE exchange point
/auth/error          200   friendly failure page
/profile             307   correct: redirects to / when signed out
/user/doesnotexist   404   correct status, not a soft 404
```

Your real data is intact and being served: 5 players, 127 games, 8 logs,
4 follows, 2 lists.

`next build` passes: 14 routes, TypeScript clean, ESLint clean.

---

## Two things that will look like bugs and are not

**"An unexpected response was received from the server" after editing a file.**
Hard-reload. Server Action IDs change when the module graph changes, and a stale
bundle POSTs an ID the server no longer has. This was originally masked by the
proxy bug, which made it look permanent.

**"Cannot overwrite variable HOME because it is read-only."** That is a
PowerShell restriction, not an app error — `$HOME` is reserved. I hit it while
writing a verification script.

**If you ever see `Missing required environment variable:
NEXT_PUBLIC_SUPABASE_URL` in the browser only, while the server returns 200** —
that was a bug I introduced when refactoring the env reader, and it is fixed.
Next.js inlines `NEXT_PUBLIC_*` by literal substitution and can only do that when
the expression is statically analysable; I had written `process.env[name]` inside
a helper, which the compiler cannot see through. `src/lib/env.ts` now reads them
statically, with a comment explaining why they must not be "tidied" back. Clear
`.next` and hard-reload after any `.env.local` change.
