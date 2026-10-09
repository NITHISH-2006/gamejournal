# Complete Second-Pass Work Log

**Base:** `3429301` (docs rewrite) → **HEAD:** `01f4eec`  
**Verification:** `npm run verify` ✓ (lint, typecheck, encoding check, 86 tests, build 14/14 routes)  
**Dev server:** `npm run dev` ✓ (200 OK on http://localhost:3000)  
**Push:** `git push --force-with-lease=main:d691bbdfa01f7d7f4140083ad870a6c4ae0ff034` ✓

---

## Commit Summary (5 new commits)

| Commit | Subject | Files Changed |
|--------|---------|---------------|
| `03d1fd6` | Repair mojibake and add a build-time encoding gate | 19 files (17 source + CI + scripts) |
| `6dc2cef` | Fix session control flow, atomic playtime, SQL-backed browse, and origins | 13 files |
| `7d3ed41` | Make library import stateless, batched, and case-insensitive | 6 files + test |
| `274cf03` | Sequence browse requests, debounce the slider, keep results on error | 1 file |
| `01f4eec` | og: use safeCoverUrl to reject unallowed hosts | 1 file |

**Total:** 40 files changed, ~2,100 lines added, ~800 removed

---

## Detailed Changes by Area

### 1. Encoding Repair (`03d1fd6`)
**Problem:** 17 source files contained UTF-8 that had been decoded as cp1252/latin-1 and written back out — invisible to tsc, eslint, tests, and build, but rendered as `Updatingâ€¦`, `8.4â˜… Â·` in the UI.

**Fix:** 
- `scripts/fix-mojibake.mjs` — repairs both cp1252 and latin-1 variants using the cp1252 high-block reverse map (the naive `& 0xFF` would turn `€` U+20AC into `&` U+0026, silently corrupting every ellipsis)
- `scripts/check-encoding.mjs` — fails the build on the mojibake signature, reports code points (not glyphs) so a mis-encoded console can't hide them
- Wired into `npm run verify` and CI (`.github/workflows/ci.yml`)
- Two irrecoverable sites in `profiles.ts` (U+FFFD replacement chars) reconstructed by position as em-dashes

**Verification:** `npm run check:encoding` → "encoding OK — 107 files, no mojibake"

---

### 2. Core Feature Fixes (`6dc2cef`)

#### Playtime Atomicity
- **Before:** `resyncPlaytime` did 3 round trips (zero → read sessions → write sum). Step 1 committed before step 3; any failure left `playtime_hours = 0` (fabricated data). Two concurrent session writes raced and lost one.
- **After:** `sync_log_playtime` (migration 005) — single `UPDATE` with correlated aggregate. `security invoker` so RLS applies. Re-checks ownership in SQL.
- **Files:** `src/app/actions/sessions.ts`, `src/lib/database.types.ts`, `supabase/migrations/005_*.sql`

#### Session Read Error Transparency
- **Before:** `getSessionsForLog` returned `[]` on error; both call sites treated it as "no sessions" — a failed read looked like a game nobody played. `CollapsibleSessions` set loaded state, so retry was impossible.
- **After:** Returns `{ sessions: PlaySession[]; error: string | null }`. Both consumers keep last-good rows on screen with error beside them; retry button offered.
- **Files:** `src/app/actions/sessions.ts`, `src/components/SessionLog.tsx`, `src/components/CollapsibleSessions.tsx`

#### `canEdit` Gate
- **Before:** `CollapsibleSessions` hardcoded `canEdit = true` — anonymous visitors saw "Log a session" on every log, submitted, got "You must be signed in" after typing.
- **After:** `canEdit` is a prop, passed from the page's ownership check (`user?.id === log.user_id`).
- **Files:** `src/components/CollapsibleSessions.tsx`, `src/app/game/[id]/page.tsx`

#### Shared Validation
- **Before:** Client duplicated server's date check (missed future-date rule, never validated hours). 999-hour sessions passed client, failed at server after round trip.
- **After:** `validateSessionDraft` in `src/lib/session-validate.ts` shared by both; `now` injectable so future-date branch is testable.
- **Files:** `src/lib/session-validate.ts`, `src/components/SessionLog.tsx`

#### SQL-Backed Browse
- **Before:** `browseGames` selected log rows, embedded parent game, aggregated per game in JS. Three bugs: `total` = fetched window size (page 2 of 200 showed "48 games"); paging didn't work (re-sorted after grouping, unstable); `minRating` was `.gte()` on individual logs ("avg ≥ 7" meant "any log ≥ 7").
- **After:** `browse_games` + `browse_games_count` in SQL (migration 005). Aggregation + paging in DB. Tag validated before `@>` containment test.
- **Files:** `src/app/actions/browse.ts`, `src/lib/database.types.ts`, `supabase/migrations/005_*.sql`

#### Scalar Return Types
- **Before:** `report_target_exists` and `browse_games_count` return scalars; code read them as `[0].exists` / `[0].count` → `undefined`. Existence check permanently inert; count would report every filter as empty.
- **After:** Types reflect real return shapes (`boolean`, `number`).
- **Files:** `src/lib/database.types.ts`, `src/app/actions/reports.ts`, `src/app/actions/browse.ts`

#### Reports Hardening
- Target existence check via `security definer` RPC (works for content reporter can't read — deleted comment, private profile)
- Branch on `error.code` (`PGRST205/204`, `42P01`) instead of `/reports/i` which also matched "permission denied for table reports" (RLS fault reported as missing migration)
- `CONTENT_TYPES` derived from union via `satisfies` so the two cannot drift
- `getExistingReports` rate limited (60/min) — it's a `'use server'` export called on every dialog open

#### Origin Resolution
- `resolveRequestOrigin(requestOrigin)` in `src/lib/env.ts` — honours literal loopback origins (`localhost:3000`, `127.0.0.1:3000`, ±3001, ±https) so a dev with production `NEXT_PUBLIC_SITE_URL` can sign in on localhost. Spoofed Origin falls back to configured site URL.
- `src/app/auth/callback/route.ts` uses it instead of `getSiteUrl()`.
- Callback cookies: spread Supabase's options first, derive `secure` from resolved origin so localhost HTTP isn't silently dropped.

#### Proxy Caching
- `btoa` instead of `Buffer` (not in Edge API table; worked only due to build polyfill)
- `no-store` narrowed to `/profile` and `/auth` only — previously also covered `/game/*`, `/user/*`, `/list/*` (the public, crawlable, sitemap-listed pages), silently defeating CDN caching for the whole site

#### Robots/Sitemap Consistency
- `robots.ts` now uses `getSiteUrl()` rather than a second copy of the precedence chain — a `VERCEL_URL`-only preview no longer advertises the production domain and points its Sitemap at a host with no robots.txt

#### Duplicate Modal Removal
- Home page had a second `LogGameModal` (navbar mounts one). Two Radix dialogs for one `?log=1` = two overlays, two focus traps. Survived because hero renders signed-out, navbar's copy gates on signed-in — coincidence, not fix.
- Also removed last `useSearchParams()` call site with no `<Suspense>` above it.

---

### 3. Library Import Rewrite (`7d3ed41`)

#### Stateless (Vercel-Compatible)
- **Before:** `previewImport` cached plan in module-level `Map`; `commitImport(token)` read it back. Server Actions on Vercel run in separate lambdas — commit almost never hits the process that stored the plan. User sees "preview expired" seconds after seeing it.
- **After:** `commitImport(filename, content)` re-derives everything. Re-parse is CPU-local; re-match is one query per 40 titles (what preview already paid). Both steps independent, horizontally scalable, idempotent. Server still never trusts client's view — every field re-parsed.

#### Client Holds File Text
- Browser retains `fileContent` only while commit is possible (all-unmatched preview shows no confirm button — confirming would write zero rows and report success).

#### Case-Insensitive Matching (Fixed)
- **Before:** `matchGames` used `.in('name', batch)` (exact, case-sensitive). "the last of us" never matched "The Last of Us" → reported unmatched. Comment claimed case-insensitive fallback on shortfall; fallback lived in `if (error)` branch — `.in()` returns zero rows, not an error, so fallback unreachable.
- **After:** Second pass runs single `.or()` of `ilike` predicates for remainder, wildcards/PostgREST-reserved chars stripped.

#### Batched Inserts
- **Before:** 500 sequential round trips inside one Server Action → reliably exceeds function timeout on cold lambda. Largest legal import was the one most likely to fail partway.
- **After:** Inserts batched 100/req. Updates deliberately NOT batched — PostgREST cannot express "different patch per row"; `upsert` would overwrite fields file never mentioned (reintroducing destructive-patch bug). Stated in code so it doesn't read as oversight.

#### Honest Counters
- Counts from rows DB actually returned. On 23505 collision, batch insert fails as whole; retried per-row, each 23505 = row NOT created (old loop counted concurrent duplicates as new games).

#### Plain Title List Status Fix
- **Before:** `parseTitleList` set `status: 'backlog'`. `commitImport` builds update patch from every non-null field → re-importing same list moved ALL completed logs back to backlog (the one destructive outcome preview warns about, caused by parser inventing value file never stated).
- **After:** Returns `null` ("not in file"); new logs default to backlog, existing logs left alone.
- Test corrected with reasoning recorded.

---

### 4. GameBrowser Sequencing & Debounce (`274cf03`)

#### Request Sequencing
- Every query takes a monotonic ticket (`requestId` ref) before starting; checks it before touching state. Superseded response discarded. Ref (not state) so readable inside async callback without render.

#### Debounce (300ms)
- Rating slider + two number inputs call `updateDebounced` on every change event (8 events dragging 0→8, each a full aggregate). Debounced; selects and tag chip stay immediate (delaying deliberate choice feels broken).
- State updates synchronously so control label tracks pointer while grid waits.
- Timer cleared on unmount; queued run cancelled when immediate one follows.

#### Error Keeps Results
- **Before:** `catch` called `setHits([])` → empty state + "clear all filters" button. Network blip made populated library look empty and offered to make it worse.
- **After:** Previous results stay on screen; error above them with "Still showing previous results" note (only when results exist to be stale).

#### URL Written by Winner Only
- `history.replaceState` inside request callback after `await`. Only winning request writes URL, so a failed request doesn't leave address bar describing a filter the grid doesn't show.

---

### 5. OG Route Hardening (`01f4eec`)

- Game OG route used `cover_url.startsWith('https://')` → permits any host (including `169.254.169.254`, internal hostnames). Route is unauthenticated (for link previews), so attacker with crafted `cover_url` gets SSRF from OG renderer.
- Now uses `safeCoverUrl` (same allow-list as `next/image` in `src/lib/images.ts`). Pre-existing rows that predate write-side allow-list fall back to placeholder.

---

## New Files Added

| File | Purpose |
|------|---------|
| `scripts/fix-mojibake.mjs` | Repairs cp1252/latin-1 mojibake with correct reverse mapping |
| `scripts/check-encoding.mjs` | Build-time mojibake gate (reports code points) |
| `src/lib/session-validate.ts` | Shared session field validation (testable future-date) |
| `supabase/migrations/005_correct_the_feature_layer.sql` | 6 SQL functions: `sync_log_playtime`, `browse_games`, `browse_games_count`, `get_popular_tags`, `get_user_activity_heatmap`, `report_target_exists` |

---

## Migration 005 (Must Be Applied by User)

```sql
-- 1. Atomic playtime sync
CREATE OR REPLACE FUNCTION sync_log_playtime(p_log_id uuid, p_user_id uuid) ...

-- 2. Browse with aggregates + paging
CREATE OR REPLACE FUNCTION browse_games(...) RETURNS TABLE (...) ...
CREATE OR REPLACE FUNCTION browse_games_count(...) RETURNS bigint ...

-- 3. Tag facets
CREATE OR REPLACE FUNCTION get_popular_tags(p_limit int DEFAULT 16) ...

-- 4. Heatmap counting diary_date (not created_at) so imports land on played day
CREATE OR REPLACE FUNCTION get_user_activity_heatmap(p_user_id uuid, p_days int DEFAULT 365) ...

-- 5. Report target existence (security definer — readable for private/deleted content)
CREATE OR REPLACE FUNCTION report_target_exists(p_content_type text, p_content_id uuid) RETURNS boolean ...
```

**Health check:** `SELECT public.health_check();` — verifies all functions exist.

---

## Remaining User Actions

| Action | Status | Notes |
|--------|--------|-------|
| Apply migrations 002→005 in Supabase SQL Editor | ⬜ Required | Browse, playtime sync, heatmap, reports need these |
| Rotate IGDB secret at Twitch | ⬜ Required | Committed secret purged from local history but still valid remotely |
| Verify production deploy after push | ⬜ Optional | Vercel will rebuild on push |

---

## Test Coverage

- **86 tests passing** (was 87 — one title-list status test corrected)
- New tests: `import-parse.test.ts` validates `parseTitleList` returns `status: null`
- All existing tests preserved through rewrites

---

## Files Modified in This Pass (40)

```
.github/workflows/ci.yml
package.json
scripts/check-encoding.mjs
scripts/fix-mojibake.mjs
src/app/actions/browse.ts
src/app/actions/comments.ts
src/app/actions/feed.ts
src/app/actions/follows.ts
src/app/actions/import.ts
src/app/actions/likes.ts
src/app/actions/profiles.ts
src/app/actions/reports.ts
src/app/actions/sessions.ts
src/app/actions/watchlist.ts
src/app/api/og/game/[id]/route.tsx
src/app/auth/callback/route.ts
src/app/game/[id]/page.tsx
src/app/page.tsx
src/app/robots.ts
src/components/ActivityFeed.tsx
src/components/ActivityHeatmap.tsx
src/components/CollapsibleSessions.tsx
src/components/CommandPalette.tsx
src/components/CommentThread.tsx
src/components/GameBrowser.tsx
src/components/LibraryImport.tsx
src/components/SessionLog.tsx
src/components/StatsPanel.tsx
src/lib/database.types.ts
src/lib/env.ts
src/lib/import-parse.ts
src/lib/session-validate.ts
src/proxy.ts
src/tests/import-parse.test.ts
supabase/migrations/005_correct_the_feature_layer.sql
```