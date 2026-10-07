# GameJournal 🎮

> **Letterboxd for video games.** Log what you play, rate it, review it, and see
> what everyone else is playing.

[![CI](https://github.com/NITHISH-2006/gamejournal/actions/workflows/ci.yml/badge.svg)](https://github.com/NITHISH-2006/gamejournal/actions)
[![Live](https://img.shields.io/badge/live-gamejournal.vercel.app-violet)](https://gamejournal.vercel.app)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## ⚠️ Read [`RUN-THIS-FIRST.md`](./RUN-THIS-FIRST.md) before anything else

Two things will not work until you do:

1. **Rotate your IGDB client secret.** It was committed to this repository before
   `.env.local` was gitignored. The history has been rewritten, but any secret
   that was ever pushed must be treated as compromised.
2. **Run three SQL migrations** in the Supabase SQL editor. The live database is
   missing every RPC function, several foreign keys, and three tables, so
   notifications, follower lists, stats and search cannot work without them.

---

## ✨ Features

| Area | Feature | Status |
|---|---|---|
| **Auth** | Email + password | ✅ |
| | Google and Discord OAuth | ✅ |
| | Password reset *and* choosing a new password | ✅ |
| | PKCE callback, hardened against open redirects | ✅ |
| **Logging** | Status, 10-point rating, review, diary date, tags, playtime | ✅ |
| | **Play sessions** — one row per sitting, with platform and note | ✅ |
| | **Rating 0 = "logged but not rated"** | ✅ |
| | Backlog with explicit queue order | ✅ |
| | **CSV / Backlog XML / plain-list import** with a dry-run preview | ✅ |
| **Social** | Global / Following / Trending feed | ✅ |
| | Realtime feed updates | ✅ |
| | Likes with optimistic UI | ✅ |
| | Follow graph, follower and following lists | ✅ |
| | Comment threads per log | ✅ |
| | Notification bell (likes, follows, comments) | ✅ |
| | **Content reporting** with a moderation queue | ✅ |
| **Discovery** | Full-text review search with keyset pagination | ✅ |
| | **Filterable browse** — status, rating, tag, year, log count, 4 sorts | ✅ |
| | Leaderboard, trending, suggested players | ✅ |
| **Your data** | Profile with stats, streaks and **year in review** | ✅ |
| | **Contribution-style activity heatmap** | ✅ |
| | Custom lists and a watchlist | ✅ |
| **Platform** | Next.js 16, React 19, Tailwind v4 | ✅ |
| | Supabase (Postgres + Auth + RLS) | ✅ |
| | IGDB catalogue search | ✅ |
| | OpenGraph cards per game and per log | ✅ |
| | Sitemap, robots.txt, PWA manifest | ✅ |
| | Nonce-based CSP, HSTS, strict cache policy | ✅ |
| | **86 unit tests**, GitHub Actions CI | ✅ |

---

## 🏗️ Architecture

```
Browser
  │
  ├── Next.js App Router (src/app)
  │     ├── Server Components   — default; read data directly
  │     ├── 'use server'        — src/app/actions/*  (one file = one domain)
  │     └── 'use client'        — only what genuinely needs state or effects
  │
  ├── src/proxy.ts              — security headers, CSP, session refresh
  │                               (NOT middleware.ts: Next 16 resolves this
  │                                convention beside app/, and a root-level
  │                                middleware.ts is silently never executed)
  │
  └── Supabase (Postgres + Auth + Storage)

src/lib/     — env, typed clients, validation, rate limiting, revalidation
src/components/ — UI; ui-primitives.tsx holds the shared design-system pieces
supabase/migrations/ — 001 base, 002 fixes, 003 hardening, 004 social/sessions
src/tests/   — Vitest; no network, no database required
```

### Three Supabase clients, deliberately separate

| Factory | Cookie scope | Used by |
|---|---|---|
| `createClient()` | bound to the request | Server Components and Actions |
| `createBrowserSupabaseClient()` | browser | Client Components (memoised) |
| `createPublicClient()` | **none** | sitemap, OG images, public stats |

`createPublicClient` exists because `cookies()` from `next/headers` opts a route
out of static generation. The sitemap lost its hourly revalidation for exactly
that reason until a session-less client was introduced.

All three are typed with `src/lib/database.types.ts`. See below for why that
matters more than it looks.

---

## 🔐 Security notes

**Typed Supabase clients.** Every client is constructed with a generated
`Database` type. Without it, the client resolves to `SupabaseClient<any, …>`, so
every `.select()` result is `any` and **a projection naming a column that does not
exist type-checks perfectly**.

That is not hypothetical. `follows` and `log_likes` were addressed by an `id`
column they did not have; the read error was discarded, the toggle always took
the insert branch, and **unfollow and un-like were impossible while every
follower count on every profile rendered as 0**. It passed `tsc`, `eslint`,
`next build` and every route check. It was then reintroduced by the fix meant to
prevent it. Two audit passes were needed to catch it.

`src/tests/counts-and-projections.test.ts` now asserts structurally that no code
selects a bare `id` from those tables, and that every count goes through
`exactCount` — which selects `'*'` and logs failures instead of coercing them to a
confident `0`.

**CSP.** A per-request nonce with `strict-dynamic`, so `'unsafe-inline'` is gone
from `script-src`. `https://*.supabase.co` is deliberately *not* in `script-src`:
it is never needed (the client is bundled from `'self'`), and a project's public
Storage bucket is served from that same host, so anyone able to upload there could
host JavaScript this policy would execute with the app's origin.

**The proxy clones request headers.** Passing headers to `request.headers` is an
**override, not a merge**: Next deletes every header not in the supplied set. An
empty `Headers` therefore deleted `cookie`, `next-action`, `content-type` and
`x-forwarded-for` on every request — breaking sign-in, every Server Action, and
per-IP rate limiting, with no error pointing at the proxy.

**Rate limiting.** Every write is limited, and the expensive reads are too.
Per-user buckets for signed-in callers, per-IP for anonymous ones, keyed on the
*rightmost* `X-Forwarded-For` — proxies append to that header, so the leftmost
entry is client-controlled and rotating it defeated every limit in the app.

---

## 🗄️ Database

Four migrations, all idempotent:

| File | Adds |
|---|---|
| `001_init.sql` | Base schema, policies, RPCs |
| `002_fixes_and_features.sql` | Notification RLS, surrogate keys on the join tables, `anon` grants, missing FKs, the full-text search RPC, stats functions |
| `003_verify_and_harden.sql` | A **PREFLIGHT report** and a **PASS/FAIL health grid**, the gaps 002 leaves on a database older than 001, `get_suggested_users`, trigram and pagination indexes |
| `004_social_and_sessions.sql` | `reports`, `play_sessions`, `backlog_position`, the activity heatmap |

Regenerate the types after applying them:

```bash
npx supabase gen types typescript --project-id <ref> > src/lib/database.types.ts
```

---

## 🧪 Development

```bash
npm install
cp .env.example .env.local     # fill in Supabase; IGDB optional
npm run dev
```

| Script | Does |
|---|---|
| `npm run dev` | Dev server |
| `npm run build` | Production build |
| `npm run lint` | ESLint |
| `npm run type-check` | `tsc --noEmit` |
| `npm run test` | Vitest |
| `npm run test:coverage` | Vitest with V8 coverage |
| **`npm run verify`** | **lint + typecheck + test + build** — what CI runs |

### Tests need no database and no network

`src/tests/setup.ts` stubs `process.env`, `next/cache` and `next/headers`, so a
test can assert real behaviour without a Supabase project. The suite is aimed at
the failure modes that actually bit this project — silent wrong answers rather
than crashes:

- **counts and projections** — the unfollow bug's root cause, asserted structurally
- **migrations ↔ types** — catches a function that exists in SQL but not in the
  types, which produces a call TypeScript accepts and PostgREST rejects
- **rate limit** — rightmost-IP extraction, and that a saturated store stays fast
- **validation** — rating 0, over-long usernames rejected rather than truncated,
  LIKE-metacharacter escaping
- **import parsing** — quoted CSV fields, XML entities, three rating conventions,
  and dates (this caught a live bug where `toISOString()` shifted every imported
  date back a day outside UTC)

---

## 🎨 Design notes

The visual language is glassmorphism and neumorphism, split by what each is
actually good at, because a practitioner survey found both fail in production for
the same reason: **contrast, not taste**.

| Style | Where | Guarantee |
|---|---|---|
| Neumorphism | interactive controls only | always paired with a hairline border, so the edge survives a display that cannot render the shadow |
| Glass | elevated content surfaces | blur always over a 72%-opaque scrim, never a bare translucent fill |
| Solid | anything that must stay readable | applied automatically under `forced-colors` |

All four accessibility media queries are handled: `prefers-reduced-motion`,
`prefers-reduced-transparency`, `prefers-contrast: more`, and `forced-colors`.

Text uses a measured contrast ramp — `--ink` 16.3:1, `--ink-muted` 11.9:1,
`--ink-faint` 5.6:1 — because opacity modifiers on text were the single largest
source of sub-4.5:1 copy in the previous version.

---

## 📄 Further reading

| Document | What it records |
|---|---|
| [`RUN-THIS-FIRST.md`](./RUN-THIS-FIRST.md) | The migration runbook and a 10-step verification order |
| [`AUDIT_REDESIGN_REPORT.md`](./AUDIT_REDESIGN_REPORT.md) | The full audit: every bug, its cause, and why it was invisible |
| [`SESSION_NOTES.md`](./SESSION_NOTES.md) | The proxy header bug, and why a fix can hide a second bug in the same file |

---

## 📝 License

MIT — see [LICENSE](./LICENSE).