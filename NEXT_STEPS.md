# Next Steps — Getting GameJournal Running

This document tells you exactly what to run, in order, after the force-push.

---

## 0. Prerequisites

- **Node** ≥ 20 (CI uses 22)
- **npm** (bundled)
- **Supabase project** with SQL Editor access
- **Twitch developer account** (for IGDB credentials)

---

## 1. Clone the Updated Repository

```bash
git clone https://github.com/NITHISH-2006/gamejournal.git
cd gamejournal
```

The history was rewritten to purge a committed secret, so this is a fresh clone.

---

## 2. Install Dependencies

```bash
npm ci
```

---

## 3. Create `.env.local`

Copy the example and fill in **real values**:

```bash
cp .env.example .env.local
```

Required variables:

| Variable | Where to get it |
|----------|-----------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase Dashboard → Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Same page (Publishable key) |
| `IGDB_CLIENT_ID` | Twitch Developer Console → Your App → Client ID |
| `IGDB_CLIENT_SECRET` | Twitch Developer Console → Your App → **New Secret** (see step 4) |
| `NEXT_PUBLIC_SITE_URL` | Your production URL, e.g. `https://gamejournal.vercel.app` |

**Do not commit this file** — it's in `.gitignore`.

---

## 4. Rotate the IGDB Secret (Required)

The previous `IGDB_CLIENT_SECRET` was committed to git history and purged locally, but **it is still valid at Twitch**. You must generate a new one:

1. Go to <https://dev.twitch.tv/console/apps>
2. Select your GameJournal app
3. Click **New Secret** under "Client Secret"
4. Copy the new secret into `.env.local` as `IGDB_CLIENT_SECRET`

The old secret will stop working immediately.

---

## 5. Apply Database Migrations

**Order matters** — run each file in the Supabase SQL Editor (Dashboard → SQL Editor → New Query), waiting for each to succeed before the next.

```text
supabase/migrations/001_initial_schema.sql
supabase/migrations/002_reports_and_moderation.sql
supabase/migrations/003_play_sessions.sql
supabase/migrations/004_enhanced_features.sql
supabase/migrations/005_correct_the_feature_layer.sql
```

### Verify with the health check (after 005):

```sql
SELECT * FROM public.health_check();
```

Expected output (all `true`):

| check                    | ok   |
|--------------------------|------|
| function sync_log_playtime    | true |
| function browse_games         | true |
| function browse_games_count   | true |
| function get_popular_tags     | true |
| function get_user_activity_heatmap | true |
| function report_target_exists | true |

If any row shows `false`, that migration failed or wasn't applied — re-run it.

---

## 6. Run the Full Verification Suite

```bash
npm run verify
```

This runs, in order:

1. `npm run lint` — ESLint
2. `npm run type-check` — `tsc --noEmit`
3. `npm run check:encoding` — mojibake gate
4. `npm run test` — Vitest (86 tests)
5. `npm run build` — Next.js production build (14 routes)

**All must pass.** If any step fails, fix it before deploying.

---

## 7. Start the Dev Server

```bash
npm run dev
```

- Opens <http://localhost:3000>
- Should show the home page (200 OK)
- Hot reload works on file changes

### Quick smoke test in the browser:

1. **Sign up / Sign in** — magic link or OAuth
2. **/discover** — filters, sorting, paging work
3. **/game/:id** — OG card loads, session toggle (if you own the log)
4. **/profile** — your library, import button
5. **Import** — upload a CSV/title list, preview, commit
6. **Follow / Like / Comment** — realtime updates

---

## 8. Deploy to Vercel

```bash
vercel --prod
```

Or push to `main` — Vercel is connected to GitHub and will auto-deploy.

### Vercel Environment Variables

Add the same five variables from `.env.local` in **Vercel Dashboard → Settings → Environment Variables** for Production (and Preview if you want).

---

## 9. Post-Deploy Verification

After the Vercel build succeeds:

1. Visit your production URL
2. Run through the same smoke test (step 7)
3. Check Vercel Functions logs for any errors
4. Verify `sitemap.xml` and `robots.txt` are served correctly

---

## Troubleshooting Quick Reference

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| `npm run verify` fails at `check:encoding` | Editor saved a file as cp1252 | `npm run fix:encoding` |
| `npm run build` fails with "Missing required env" | `.env.local` not populated | Fill all 5 variables |
| Sign-in redirects to production on localhost | `NEXT_PUBLIC_SITE_URL` set to prod | `resolveRequestOrigin` handles this; ensure you're on `http://localhost:3000` |
| Import preview works but commit says "preview expired" | Old code cached | You're on the new stateless version — must use latest `main` |
| Browse shows "0 games" or errors | Migration 005 not applied | Run all 5 migrations in order |
| OG images don't load / show placeholder | `cover_url` not in allow-list | `safeCoverUrl` rejects unknown hosts; add host to `src/lib/images.ts` if needed |
| Rate limit hit immediately | `enforce` keys | Check `src/lib/limiter.ts` — defaults are generous |

---

## File Locations for Future Changes

| Area | Key Files |
|------|-----------|
| Browse / Discover | `src/app/actions/browse.ts`, `src/components/GameBrowser.tsx` |
| Import | `src/app/actions/import.ts`, `src/lib/import-parse.ts`, `src/components/LibraryImport.tsx` |
| Play Sessions | `src/app/actions/sessions.ts`, `src/components/SessionLog.tsx`, `src/components/CollapsibleSessions.tsx` |
| Auth / Callback | `src/app/auth/callback/route.ts`, `src/lib/env.ts` |
| Proxy / CSP | `src/proxy.ts` |
| Reports | `src/app/actions/reports.ts` |
| OG Cards | `src/app/api/og/game/[id]/route.tsx`, `src/app/api/og/log/[id]/route.tsx` |
| Encoding Guard | `scripts/fix-mojibake.mjs`, `scripts/check-encoding.mjs` |
| Migrations | `supabase/migrations/*.sql` |

---

## Rollback Plan

If production deploy breaks:

```bash
# Revert to last known-good commit (pre-second-pass)
git revert 03d1fd6..01f4eec
git push origin main
```

Or on Vercel: **Deployments → three dots on previous good build → Promote to Production**.

---

## Support

- **Migration issues:** Check Supabase SQL Editor error output
- **IGDB 401/403:** Secret not rotated or wrong Client ID
- **Build failures:** Run `npm run verify` locally first — CI runs the same commands
- **Encoding regressions:** `npm run fix:encoding` then commit

---

**You are now ready.** Run steps 1–7 in order. The app will work.