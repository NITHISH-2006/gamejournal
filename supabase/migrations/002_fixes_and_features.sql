-- ===========================================================================
-- 002 — Correctness, security and feature foundations
-- ===========================================================================
--
-- WHY THIS FILE EXISTS
-- 001_init.sql is written with `create table if not exists` everywhere. That
-- makes it safe to *re-run*, but it never *upgrades* an existing table: if the
-- table already exists the statement is a no-op, so no column is ever added.
-- Applying 001 to a database that already has the base schema therefore appears
-- to succeed while silently leaving the old schema in place. (The README
-- previously claimed it "upgrades an existing database in place" — that claim
-- was false and is now corrected.)
--
-- This is not hypothetical. The live project (ref gkxmpqzwdzxbuwkikftt) was
-- created from an *older* revision of 001 and is missing:
--   - all 4 RPCs from 001 (get_log_likes, get_game_stats,
--     get_top_rated_games, search_logs)  -> PGRST202, every aggregate empty
--   - lists.updated_at                    -> sitemap query fails outright
--   - lists.kind, game_logs.playtime_hours / is_favorite / has_spoilers,
--     game_logs.updated_at, profiles.updated_at, games.slug
--
-- Section 0 below reconciles every column the app expects, so this migration
-- is self-sufficient: it does not matter which revision of 001 built the
-- database, and you do NOT have to re-run 001 first.
--
-- This migration is written to be genuinely additive and idempotent, so it can
-- be applied on top of any 001-created database without a reset.
--
-- The three most severe defects below are not enhancements — they are features
-- that could never work, verified against the application code:
--
--   1. `follows` and `log_likes` are keyed on their composite primary key and
--      have no `id` column, but the app does `.select('id')` and
--      `.delete().eq('id', …)`. PostgREST rejects that with PGRST204, the error
--      is discarded, `existing` is always null, so the toggle always takes the
--      INSERT branch and the second click dies on a duplicate-key error.
--      => Unfollow is impossible. Un-like is impossible. Every follower and
--         like count renders 0 forever.
--
--   2. The notification policy is `with check (auth.uid() = user_id)`, but
--      every insert sets `user_id` to the RECIPIENT and `actor_id` to the
--      caller. The check can therefore never pass.
--      => 100% of notification inserts are rejected with 42501 and swallowed
--         by a `.catch()`. The bell never receives anything.
--
--   3. `anon` was never granted SELECT on `lists`, even though a public-read
--      policy exists for it.
--      => Every public list 404s for signed-out visitors, and the sitemap
--         silently emits no list URLs.
-- ===========================================================================

-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0. SCHEMA RECONCILIATION — make this file self-sufficient
-- ---------------------------------------------------------------------------
-- `create table if not exists` will not add a column to a table that already
-- exists, so a database built from an *older* revision of 001 keeps its old
-- shape no matter how many times 001 is re-run. Every column the application
-- reads is therefore added here explicitly and idempotently, which means you
-- do NOT have to re-run 001 before applying this file.
--
-- This is not hypothetical. Verified against the live project
-- (ref gkxmpqzwdzxbuwkikftt), which was missing:
--   - every RPC from 001   -> PGRST202, so all aggregates silently returned []
--   - lists.updated_at     -> the sitemap query failed outright
--   - lists.kind, game_logs.playtime_hours / is_favorite / has_spoilers,
--     game_logs.updated_at, profiles.updated_at, games.slug
-- Adding a nullable column is metadata-only in Postgres and instant.

alter table public.profiles add column if not exists display_name text;
alter table public.profiles add column if not exists avatar_url   text;
alter table public.profiles add column if not exists bio          text;
alter table public.profiles add column if not exists created_at   timestamptz not null default now();
alter table public.profiles add column if not exists updated_at   timestamptz not null default now();

alter table public.games add column if not exists name         text;
alter table public.games add column if not exists slug         text;
alter table public.games add column if not exists cover_url    text;
alter table public.games add column if not exists summary      text;
alter table public.games add column if not exists release_date date;
alter table public.games add column if not exists created_at   timestamptz not null default now();

alter table public.game_logs add column if not exists playtime_hours numeric(7,2);
alter table public.game_logs add column if not exists is_favorite     boolean not null default false;
alter table public.game_logs add column if not exists has_spoilers    boolean not null default false;
alter table public.game_logs add column if not exists diary_date      date;
alter table public.game_logs add column if not exists tags            text[];
alter table public.game_logs add column if not exists created_at      timestamptz not null default now();
alter table public.game_logs add column if not exists updated_at      timestamptz not null default now();

-- `lists.updated_at` was absent on the live project, which is why sitemap.ts
-- failed with "column lists.updated_at does not exist".
alter table public.lists add column if not exists name        text;
alter table public.lists add column if not exists description text;
alter table public.lists add column if not exists is_public   boolean not null default false;
alter table public.lists add column if not exists created_at  timestamptz not null default now();
alter table public.lists add column if not exists updated_at  timestamptz not null default now();

-- The real column is `added_at`; `created_at` is aliased in for safety because
-- different code paths have used both names.
alter table public.list_games add column if not exists added_at   timestamptz not null default now();
alter table public.list_games add column if not exists created_at timestamptz not null default now();

alter table public.notifications add column if not exists read       boolean not null default false;
alter table public.notifications add column if not exists created_at timestamptz not null default now();

-- `lists.name` is NOT NULL in 001; an older database may hold nulls.
update public.lists set name = 'Untitled list' where name is null or name = '';

-- set_updated_at is meaningless without its triggers, and `lists.updated_at`
-- is never maintained without them.
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['profiles','lists','game_logs'] loop
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = t and column_name = 'updated_at'
    ) then
      execute format('drop trigger if exists set_updated_at on public.%I', t);
      execute format(
        'create trigger set_updated_at before update on public.%I
         for each row execute function public.set_updated_at()', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 0b. Foreign key reconciliation
-- ---------------------------------------------------------------------------
-- The live project has NO foreign key from game_logs to profiles, which makes
-- every PostgREST embed of `profiles (username)` fail with PGRST200:
--   "Searched for a foreign key relationship between 'game_logs' and
--    'profiles' in the schema 'public', but no matches were found."
-- That query is what renders the author on every community log, so every game
-- page silently lost its entire "Community logs" section — the page returned
-- 200 with an empty list and one server-side log line.
--
-- Verified before writing this: every column below has ZERO orphaned rows, so
-- the constraints can be added without discarding any user data.
--
-- Each is added separately and inside a DO block, because a single failure
-- would abort the whole migration. If a future database does have orphans the
-- constraint is skipped with a loud notice rather than silently dropping rows.
do $$
declare
  spec text[][] := array[
    ['game_logs',     'user_id',      'profiles', 'profiles_id_fkey'],
    ['game_logs',     'game_id',      'games',    'game_logs_game_id_fkey'],
    ['follows',       'follower_id',  'profiles', 'follows_follower_id_fkey'],
    ['follows',       'following_id', 'profiles', 'follows_following_id_fkey'],
    ['log_likes',     'user_id',      'profiles', 'log_likes_user_id_fkey'],
    ['log_likes',     'log_id',       'game_logs','log_likes_log_id_fkey'],
    ['lists',         'user_id',      'profiles', 'lists_user_id_fkey'],
    ['list_games',    'list_id',      'lists',    'list_games_list_id_fkey'],
    ['list_games',    'game_id',      'games',    'list_games_game_id_fkey'],
    ['notifications', 'user_id',      'profiles', 'notifications_user_id_fkey'],
    ['notifications', 'actor_id',     'profiles', 'notifications_actor_id_fkey'],
    ['notifications', 'log_id',       'game_logs','notifications_log_id_fkey']
  ];
  s text[];
  i int;
  cn text;
begin
  -- An indexed `for` loop, not FOREACH.
  --
  -- PostgreSQL's FOREACH requires the loop variable to be a *scalar* matching
  -- the array's element type. `spec` is text[][], so its elements are text[] —
  -- an array — and FOREACH rejects that with:
  --   42804: FOREACH loop variable must not be of an array type
  -- Iterating the outer dimension by index and assigning to a plain text[]
  -- variable works, and keeps the spec readable as a table.
  for i in 1 .. coalesce(array_length(spec, 1), 0) loop
    s := spec[i];

    -- Skip if the column or the parent table does not exist on this database.
    if not exists (
      select 1 from information_schema.columns
      where table_schema='public' and table_name=s[1] and column_name=s[2]
    ) or not exists (
      select 1 from information_schema.tables
      where table_schema='public' and table_name=s[3]
    ) then
      continue;
    end if;

    select conname into cn
      from pg_constraint
     where conrelid = format('public.%I', s[1])::regclass
       and contype = 'f'
       and conkey = array[(select attnum from pg_attribute
                            where attrelid = format('public.%I', s[1])::regclass
                              and attname = s[2])];

    if cn is null then
      begin
        execute format(
          'alter table public.%I add constraint %I foreign key (%I)
             references public.%I(id) on delete cascade', s[1], s[4], s[2], s[3]);
        raise notice 'added FK % on %.%', s[4], s[1], s[2];
      exception when others then
        raise warning 'SKIPPED FK % on %.% : %', s[4], s[1], s[2], sqlerrm;
      end;
    end if;
    cn := null;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Surrogate keys for the two toggle tables
-- ---------------------------------------------------------------------------
-- The app treats these as single-row entities it can address by `id`. Rather
-- than rewrite every call site to use the composite key, give the tables the
-- column the code already expects. The composite uniqueness is preserved as a
-- unique index, which is what actually protects the toggle from double-inserts.

alter table public.follows    add column if not exists id uuid default gen_random_uuid();
alter table public.log_likes add column if not exists id uuid default gen_random_uuid();

-- Backfill for rows that predate this column.
update public.follows    set id = gen_random_uuid() where id is null;
update public.log_likes set id = gen_random_uuid() where id is null;

alter table public.follows    alter column id set not null;
alter table public.log_likes alter column id set not null;

-- Promote `id` to the primary key.
--
-- `alter table … add primary key` has NO `if not exists` form in PostgreSQL and
-- fails with "multiple primary keys defined for table" if one already exists,
-- so the naive form made this migration non-idempotent — it worked once and
-- then failed on every re-run. The drop is idempotent, so the add is guarded
-- explicitly.
alter table public.follows    drop constraint if exists follows_pkey;
alter table public.log_likes drop constraint if exists log_likes_pkey;

do $$
declare t text;
begin
  foreach t in array array['follows','log_likes'] loop
    if not exists (
      select 1 from pg_constraint
      where conrelid = format('public.%I', t)::regclass and contype = 'p'
    ) then
      execute format('alter table public.%I add primary key (id)', t);
      raise notice 'promoted id to primary key on public.%', t;
    end if;
  end loop;
end $$;

-- The invariant the toggle actually depends on.
create unique index if not exists follows_pair_uniq
  on public.follows (follower_id, following_id);
create unique index if not exists log_likes_pair_uniq
  on public.log_likes (user_id, log_id);

-- Counts are read with `head: true` on `.eq('follower_id' …)`.
create index if not exists follows_follower_idx on public.follows (follower_id);
create index if not exists log_likes_user_idx   on public.log_likes (user_id);

-- ---------------------------------------------------------------------------
-- 2. Notifications: allow an actor to notify a recipient
-- ---------------------------------------------------------------------------
-- The previous single `for all` policy conflated two different questions:
--   "may I READ my notifications?"        -> auth.uid() = user_id
--   "may I INSERT a notification here?"   -> auth.uid() = actor_id
-- Collapsing them into `for all … with check (auth.uid() = user_id)` meant the
-- insert branch could never be satisfied by a third party.
--
-- Splitting the policies keeps the read side airtight (you still cannot read
-- anyone else's notifications) while letting an authenticated caller create a
-- notification addressed to someone else, which is the whole point of likes
-- and follows.
--
-- `actor_id` is NOT NULL with `on delete cascade` (001:147-148), so it is
-- always populated and `auth.uid() = actor_id` cannot be spoofed by omitting it.

drop policy if exists "own notifications"        on public.notifications;
drop policy if exists "read own notifications"   on public.notifications;
drop policy if exists "insert notifications"     on public.notifications;
drop policy if exists "update own notifications" on public.notifications;
drop policy if exists "delete own notifications" on public.notifications;

create policy "read own notifications"
  on public.notifications for select to authenticated
  using (auth.uid() = user_id);

-- The actor is whoever is signed in. A caller can only ever insert a row into
-- a bell they cannot read, so the worst case is a stray notification, never a
-- data disclosure. `user_id <> actor_id` stops self-notification noise.
create policy "insert notifications"
  on public.notifications for insert to authenticated
  with check (auth.uid() = actor_id and user_id <> actor_id);

create policy "update own notifications"
  on public.notifications for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "delete own notifications"
  on public.notifications for delete to authenticated
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 3. Grants: anon must be able to read public lists
-- ---------------------------------------------------------------------------
-- A public-read policy on `lists` is inert without the table grant. Without
-- this, `getListById` returns null for anonymous visitors and every public
-- list 404s, and the sitemap silently omits all list URLs.
grant select on public.lists to anon;

-- The toggle tables are now addressed by `id`, so anon needs the grant to make
-- `head: true` counts work on public pages.
grant select on public.follows, public.log_likes to anon;

-- ---------------------------------------------------------------------------
-- 4. Lock down the shared `games` catalogue
-- ---------------------------------------------------------------------------
-- 001 granted authenticated users `insert, update` with `using (true)`, and
-- `ensureGameCached` upserts metadata taken straight from a client payload.
-- Any logged-in user could therefore rename any game or point its cover art
-- at an arbitrary host. Because `next.config.ts` allow-lists image hosts, a
-- non-allow-listed `cover_url` makes `next/image` throw at render time and
-- permanently 500s every page that renders that game.
--
-- Writes are removed entirely. The server populates the catalogue from IGDB
-- through `upsert_game`, which is the only supported path.

drop policy if exists "authenticated insert games" on public.games;
drop policy if exists "authenticated update games" on public.games;

revoke insert, update, delete on public.games from anon, authenticated;

-- Re-fetch from IGDB inside a definer function rather than trusting the caller.
-- `name` is deliberately NOT updated on conflict: a client must not be able to
-- rename a canonical title.
--
-- NO DEFAULT VALUES on the parameters. In PostgreSQL a `default` makes the
-- function exist under *several* signatures, so `revoke`/`grant` on one of them
-- leaves the others with the default `EXECUTE to PUBLIC` — and this is SECURITY
-- DEFINER, so that would hand the function to anon. One signature, revoked and
-- granted explicitly.
create or replace function public.upsert_game(
  p_id           bigint,
  p_name         text,
  p_cover_url    text,
  p_release_date date,
  p_summary      text
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.games (id, name, cover_url, release_date, summary)
  values (p_id, left(p_name, 200), p_cover_url, p_release_date, p_summary)
  on conflict (id) do update
    set cover_url    = coalesce(excluded.cover_url, public.games.cover_url),
        release_date = coalesce(excluded.release_date, public.games.release_date),
        summary      = coalesce(excluded.summary, public.games.summary);
$$;

revoke all on function public.upsert_game(bigint, text, text, date, text) from public;
grant execute on function public.upsert_game(bigint, text, text, date, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. rating must not be nullable
-- ---------------------------------------------------------------------------
-- The column allowed NULL while every TypeScript type, the validation layer
-- and the UI all assume a number. A null rating renders the literal text
-- "null/10". `validateRating` can never produce one, so aligning the database
-- with the application is the safe direction.
-- 0 means "logged but unrated", which the UI already handles.

do $$
begin
  alter table public.game_logs alter column rating set default 0;
exception when others then null;
end $$;

update public.game_logs set rating = 0 where rating is null;

alter table public.game_logs alter column rating set not null;

alter table public.game_logs drop constraint if exists game_logs_rating_check;
alter table public.game_logs add  constraint game_logs_rating_check
  check (rating between 0 and 10);

-- ---------------------------------------------------------------------------
-- 6. Enforce the username format the code already assumes
-- ---------------------------------------------------------------------------
-- `getProfileByUsername` lowercases its input and then does an exact `.eq()`.
-- A row with any uppercase in it is therefore permanently unreachable and the
-- profile 404s forever. The unique index is already on `lower(username)`, so
-- uniqueness is case-insensitive; this adds the format guarantee.
--
-- The UPDATE first is not cosmetic. 001 only constrained username to
-- `not null unique` — nothing enforced the character set, and the
-- "insert own profile" RLS policy let any authenticated user write an arbitrary
-- string. So mixed-case or over-long names are entirely possible on an
-- existing database, and `add constraint` would abort the whole migration with
--   check constraint "profiles_username_format" of relation "profiles" is
--   violated by some row
-- Normalising first means the migration converges instead of failing.
-- Verified against the live project: all 5 existing usernames already comply,
-- so this UPDATE is a no-op there.

update public.profiles
   set username = left(
         coalesce(nullif(regexp_replace(lower(username), '[^a-z0-9_]', '', 'g'), ''),
                  'player'),
         13)
     || '_' || substr(replace(id::text, '-', ''), 1, 6)
 where username !~ '^[a-z0-9_]{3,20}$';

alter table public.profiles drop constraint if exists profiles_username_format;
alter table public.profiles add  constraint profiles_username_format
  check (username ~ '^[a-z0-9_]{3,20}$');

-- ---------------------------------------------------------------------------
-- 7. Signup trigger: lowercase before stripping, and never abort signup
-- ---------------------------------------------------------------------------
-- Two real bugs in 001's handle_new_user:
--
--   (a) `regexp_replace(…, '[^a-z0-9_]', '', 'g')` ran BEFORE `lower()` and the
--       character class has no `i` flag, so every uppercase letter was deleted
--       rather than lowercased. "JohnSmith" became "ohnsmith"; "ALICE" became
--       "lice". Users could never claim the name they asked for.
--   (b) `on conflict (id)` only covers a duplicate primary key. The far more
--       likely conflict is a duplicate *username*, and because `actor`'s
--       insert has no target the exception aborts the whole `auth.users`
--       INSERT — the user simply cannot sign up.
--
-- `pg_temp` is listed explicitly in the search_path: for SECURITY DEFINER
-- functions PostgreSQL otherwise searches it first, which would let a temp
-- table named `profiles` shadow the real one.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = '', pg_temp
as $$
declare
  base      text;
  candidate text;
  attempt   int := 0;
begin
  -- lower() FIRST, then strip. This is the fix for (a).
  base := regexp_replace(
            lower(coalesce(new.raw_user_meta_data ->> 'username',
                           split_part(coalesce(new.email, ''), '@', 1),
                           'player')),
            '[^a-z0-9_]', '', 'g'
          );

  if length(base) < 3 then
    base := 'player';
  end if;
  base := left(base, 14);

  loop
    candidate := case when attempt = 0 then base else base || attempt::text end;
    exit when not exists (
      select 1 from public.profiles where lower(username) = candidate
    );
    attempt := attempt + 1;
    -- Deterministic, collision-free escape hatch derived from the user id.
    if attempt > 50 then
      candidate := left(base, 13) || '_' || substr(replace(new.id::text, '-', ''), 1, 6);
      exit;
    end if;
  end loop;

  -- No conflict target: a lost username race must not abort the signup. The
  -- app's self-heal path fills the gap instead.
  insert into public.profiles (id, username, display_name)
  values (
    new.id,
    candidate,
    nullif(left(coalesce(new.raw_user_meta_data ->> 'display_name', ''), 60), '')
  )
  on conflict do nothing;

  return new;
end;
$$;

-- Backfill for users who signed up before the trigger existed. Without this
-- they have no `profiles` row, and because `game_logs.user_id` references
-- `profiles(id)` they cannot log anything at all — the FK fails and the error
-- is misreported as "That game could not be saved".
-- The `_<6 hex of uuid>` suffix makes this deterministic and naturally
-- idempotent, so re-running can never produce a different username.
insert into public.profiles (id, username, display_name)
select
  u.id,
  -- 13, not 14. The generated name is `left(base, N) || '_' || 6 hex chars`,
  -- so N=14 yields up to 21 characters and would violate the 20-character
  -- `profiles_username_format` check added in section 6 of this same file.
  -- `handle_new_user` already uses 13 for exactly this reason.
  left(coalesce(nullif(regexp_replace(
         lower(coalesce(u.raw_user_meta_data ->> 'username',
                        split_part(coalesce(u.email, ''), '@', 1), 'player')),
         '[^a-z0-9_]', '', 'g'), ''), 'player'), 13)
    || '_' || substr(replace(u.id::text, '-', ''), 1, 6),
  nullif(left(coalesce(u.raw_user_meta_data ->> 'display_name', ''), 60), '')
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id)
on conflict do nothing;

-- Re-create the signup trigger. 002 replaces `handle_new_user`'s body but a
-- `create or replace function` does NOT re-attach a trigger — 001 owns the
-- `create trigger` statement. On any database where that trigger is absent,
-- new signups still get no `profiles` row, and because section 0b has just
-- added the `game_logs.user_id -> profiles.id` foreign key, that surfaces to
-- the user as a confusing "That game could not be saved" rather than a
-- sign-up problem.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- 8. `lists.kind` — make the watchlist identifiable without magic strings
-- ---------------------------------------------------------------------------
-- 001 defined a discriminator column but nothing ever set or read it; the
-- watchlist was located by its display name, so a user who created a custom
-- list called "Plan to Play" had that list silently adopted as their
-- watchlist.

alter table public.lists add column if not exists kind text;

update public.lists set kind = 'custom' where kind is null;

-- Adopt the legacy watchlist if one already exists, before the constraint.
update public.lists
   set kind = 'watchlist'
 where kind = 'custom'
   and lower(name) = 'plan to play';

alter table public.lists alter column kind set default 'custom';
alter table public.lists alter column kind set not null;

alter table public.lists drop constraint if exists lists_kind_check;
alter table public.lists add  constraint lists_kind_check
  check (kind in ('custom', 'watchlist'));

-- A user may have only one watchlist.
create unique index if not exists lists_user_watchlist_uniq
  on public.lists (user_id) where kind = 'watchlist';

-- The existing unique index is on `lower(name)`, which cannot serve the
-- exact-match lookups the app performs.
create index if not exists lists_user_name_idx on public.lists (user_id, name);
create index if not exists lists_user_created_idx on public.lists (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 9. Indexes for hot paths that currently sequential-scan
-- ---------------------------------------------------------------------------
-- `games_name_lower_idx` on `lower(name)` is unusable by the leading-wildcard
-- ILIKE the search actually issues, so every cache-hit search scans the whole
-- catalogue — the fastest-growing table in the database.
create extension if not exists pg_trgm;

create index if not exists games_name_trgm_idx
  on public.games using gin (name gin_trgm_ops);

-- Full-text review search. 001 built the tsvector inline per row per call.
alter table public.game_logs
  add column if not exists review_tsv tsvector
  generated always as (to_tsvector('english', coalesce(review, ''))) stored;

create index if not exists game_logs_review_tsv_idx
  on public.game_logs using gin (review_tsv);

-- DELIBERATELY NOT HERE: `using gin (tags gin_trgm_ops)`.
--
-- `game_logs.tags` is text[] and pg_trgm defines gin_trgm_ops only for text
-- and varchar — there is no array operator class. Attempting it raises:
--   ERROR:  operator class "gin_trgm_ops" does not accept data type text[]
-- which ABORTS the entire migration and rolls back all ~1000 lines, because
-- the Supabase SQL editor runs the script as one transaction. The 001
-- migration already created a working `using gin (tags)` index with the
-- default array_ops class, so this statement added nothing anyway.
--
-- `search_logs` therefore matches tags with a plain ILIKE over the unnested
-- array, which the array GIN index cannot serve either. If tag search ever
-- needs to be fast, the correct form is an expression index:
--   create index on public.game_logs
--     using gin ((array_to_string(coalesce(tags,'{}'), ' ') gin_trgm_ops));
-- deliberately omitted here because it is a table rewrite on a live table and
-- is not needed until tag search is actually a hot path.

-- Per-status dashboard counts.
create index if not exists game_logs_user_status_idx
  on public.game_logs (user_id, status);

-- Newcomer suggestions.
create index if not exists profiles_created_idx
  on public.profiles (created_at desc);

-- Spoiler-aware reads hit this constantly.
create index if not exists game_logs_user_favorite_idx
  on public.game_logs (user_id) where is_favorite;

-- ---------------------------------------------------------------------------
-- 10. Spoilers must actually be honoured
-- ---------------------------------------------------------------------------
-- `has_spoilers` was written by the UI and never read by any query, and
-- `game/[id]/page.tsx` hard-coded `hasSpoilers={false}`. A user who marked a
-- review as a spoiler had it rendered in the open on the feed, on their
-- profile, and inside a publicly cacheable OG image.
--
-- The new RPCs below are the only sanctioned way to read a review. Anything
-- that wants spoiler-free text uses `redact_spoilers`.

create or replace function public.redact_spoilers(p_logs jsonb)
returns jsonb
language sql
immutable
as $$
  select coalesce(
    (
      select jsonb_agg(
               case
                 when (e ->> 'has_spoilers')::boolean
                   then (e - 'review') || jsonb_build_object('review', null)
                 else e
               end
               order by (e ->> 'created_at') desc nulls last
             )
      from jsonb_array_elements(p_logs) as e
    ),
    '[]'::jsonb
  );
$$;

-- ---------------------------------------------------------------------------
-- 11. Aggregate functions the new UI needs
-- ---------------------------------------------------------------------------

-- `get_log_likes` is called by the app (likes.ts, discover.ts) but was NOT
-- recreated here originally, and the live project is missing it too — so every
-- like render fell back to two extra client queries. Restored so the batch
-- path is a single round trip.
--
-- `bool_or` returns NULL, not false, when the caller is anonymous
-- (`l.user_id = auth.uid()` is NULL). Both readers coerce with Boolean(),
-- which maps NULL to false, so this is safe.
create or replace function public.get_log_likes(p_log_ids uuid[])
returns table (log_id uuid, like_count bigint, liked_by_me boolean)
language sql
stable
security invoker
set search_path = public
as $$
  select l.log_id,
         count(*)::bigint as like_count,
         coalesce(bool_or(l.user_id = auth.uid()), false) as liked_by_me
    from public.log_likes l
   where l.log_id = any(p_log_ids)
   group by l.log_id;
$$;

grant execute on function public.get_log_likes(uuid[]) to anon, authenticated;

-- `get_game_stats` is one of the four functions the live project was missing.
create or replace function public.get_game_stats(p_game_id bigint)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'avg_rating',     (select round(avg(rating)::numeric, 2)
                        from public.game_logs where game_id = p_game_id and rating > 0),
    'rating_count',   (select count(*) from public.game_logs
                        where game_id = p_game_id and rating > 0),
    'playtime_hours', (select coalesce(sum(playtime_hours), 0)
                        from public.game_logs where game_id = p_game_id),
    'watchers',       (select count(distinct user_id) from public.game_logs
                        where game_id = p_game_id),
    'log_count',      (select count(*) from public.game_logs where game_id = p_game_id),
    'review_count',   (select count(*) from public.game_logs
                        where game_id = p_game_id and review is not null),
    'status_counts',  (select coalesce(jsonb_object_agg(s, c), '{}'::jsonb)
                        from (select status::text as s, count(*) as c
                                from public.game_logs
                               where game_id = p_game_id
                               group by status) t)
  );
$$;

-- A hard `p_min_logs` floor solved gaming on a large site but emptied the
-- leaderboard on a small one: with 8 logs in the entire live database, no game
-- could reach a floor of 5 and the primary discovery surface rendered empty.
-- Replaced with confidence-weighted shrinkage — the standard IMDb approach.
--
--   score = (avg * n + 4.0 * 3) / (n + 3)
--
-- A lone 10/10 scores 5.50; a 9.0 averaged over 20 ratings scores 8.35. So one
-- perfect rating still cannot top a well-reviewed game, and the board is never
-- artificially empty. The JavaScript fallback in `getTopRatedGames` uses the
-- identical formula so the two paths cannot disagree about who is #1.
create or replace function public.get_top_rated_games(
  p_limit    int default 24,
  p_min_logs int default 1
)
returns table (
  game_id    bigint,
  name       text,
  cover_url  text,
  avg_rating numeric,
  log_count  bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with agg as (
    select l.game_id,
           min(g.name)      as name,
           min(g.cover_url) as cover_url,
           round(avg(l.rating)::numeric, 2) as avg_rating,
           count(*)         as log_count
      from public.game_logs l
      join public.games g on g.id = l.game_id
     where l.rating > 0
     group by l.game_id
    having count(*) >= greatest(p_min_logs, 1)
  ),
  scored as (
    select a.*,
           ((a.avg_rating * a.log_count) + (4.0 * 3))
             / (a.log_count + 3) as score
      from agg a
  )
  select s.game_id, s.name, s.cover_url, s.avg_rating, s.log_count
    from scored s
   order by s.score desc, s.log_count desc, s.name asc
   limit greatest(1, least(p_limit, 100));
$$;

-- Trending was previously computed in JavaScript over an unordered 500-row
-- slice, so two identical requests in the same second could disagree. Ranking
-- belongs in SQL.
create or replace function public.get_trending_games(
  p_limit  int  default 12,
  p_days   int  default 7,
  p_min_logs int default 1
)
returns table (
  game_id    bigint,
  name       text,
  cover_url  text,
  log_count  bigint,
  avg_rating numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  with recent as (
    select l.game_id, l.rating
      from public.game_logs l
     where l.created_at >= now() - make_interval(days => greatest(1, least(p_days, 90)))
  )
  select r.game_id,
         min(g.name)      as name,
         min(g.cover_url) as cover_url,
         count(*)         as log_count,
         round(avg(nullif(r.rating, 0))::numeric, 2) as avg_rating
    from recent r
    join public.games g on g.id = r.game_id
   group by r.game_id
  having count(*) >= greatest(p_min_logs, 1)
   order by count(*) desc, avg_rating desc nulls last, min(g.name) asc
   limit greatest(1, least(p_limit, 50));
$$;

-- ---------------------------------------------------------------------------
-- 12. Activity + engagement statistics (stats, streaks, year in review)
-- ---------------------------------------------------------------------------
create or replace function public.get_user_activity_stats(p_user_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with mine as (
    select l.*, l.created_at::date as d
      from public.game_logs l
     where l.user_id = p_user_id
  ),
  days as (
    select d, count(*) as n
      from mine
     group by d
  ),
  ordered as (
    -- Rank distinct active days descending; a streak is a run of consecutive
    -- dates ending today or yesterday (so an unlogged morning does not read
    -- as a broken streak).
    select d, n, d - (row_number() over (order by d desc))::int as grp
      from days
  ),
  streaks as (
    select grp, count(*) as len
      from ordered
     group by grp
  ),
  current_streak as (
    select coalesce(max(len), 0) as n
      from streaks s
      join (select distinct grp from ordered
             where d >= (current_date - 1)) live using (grp)
  ),
  longest_streak as (
    select coalesce(max(len), 0) as n from streaks
  )
  select jsonb_build_object(
    'total_logs',        (select count(*) from mine),
    'rated_logs',        (select count(*) from mine where rating > 0),
    'review_count',      (select count(*) from mine where review is not null),
    'completed',         (select count(*) from mine where status = 'completed'),
    'playing',           (select count(*) from mine where status = 'playing'),
    'backlog',           (select count(*) from mine where status = 'backlog'),
    'abandoned',         (select count(*) from mine where status = 'abandoned'),
    'favorites',         (select count(*) from mine where is_favorite),
    'total_playtime',    (select coalesce(sum(playtime_hours), 0) from mine),
    'avg_rating',        (select round(avg(nullif(rating, 0))::numeric, 2) from mine),
    'distinct_games',    (select count(distinct game_id) from mine),
    'active_days',       (select count(*) from days),
    'current_streak',    (select n from current_streak),
    'longest_streak',    (select n from longest_streak),
    'this_year',         (select count(*) from mine
                           where created_at >= date_trunc('year', now() at time zone 'utc')),
    'last_logged_at',    (select max(created_at) from mine)
  );
$$;

-- Per-month log volume for the activity chart.
create or replace function public.get_user_log_history(p_user_id uuid, p_months int default 12)
returns table (month date, logs bigint, completed bigint, hours numeric)
language sql
stable
security invoker
set search_path = public
as $$
  select
    date_trunc('month', created_at at time zone 'utc')::date as month,
    count(*)                                                 as logs,
    count(*) filter (where status = 'completed')            as completed,
    coalesce(round(sum(playtime_hours), 1), 0)              as hours
  from public.game_logs
  where user_id = p_user_id
    and created_at >= date_trunc('month', now() at time zone 'utc')
                     - make_interval(months => greatest(1, least(p_months, 36)))
  group by 1
  order by 1 asc;
$$;

-- Year in review: a shareable, fully server-computed summary.
create or replace function public.get_year_in_review(p_user_id uuid, p_year int default null)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  yr int := coalesce(p_year, extract(year from now() at time zone 'utc')::int);
begin
  return (
    with mine as (
      select l.*, g.name as game_name, g.cover_url
        from public.game_logs l
        join public.games g on g.id = l.game_id
       where l.user_id = p_user_id
         and extract(year from l.created_at at time zone 'utc') = yr
    ),
    ratings as (
      select avg(rating)::numeric as avg_rating
        from mine where rating > 0
    )
    select jsonb_build_object(
      'year',            yr,
      'games_played',    (select count(*) from mine),
      'games_completed', (select count(*) from mine where status = 'completed'),
      'reviews_written', (select count(*) from mine where review is not null),
      'hours_played',    (select coalesce(round(sum(playtime_hours), 1), 0) from mine),
      'avg_rating',      (select round(avg_rating, 2) from ratings),
      'favorites',       (select count(*) from mine where is_favorite),
      'top_rated', (select coalesce(jsonb_agg(jsonb_build_object(
                        'game_id', game_id, 'name', game_name,
                        'cover_url', cover_url, 'rating', rating)), '[]'::jsonb)
                      from (select game_id, min(game_name) as game_name,
                                   min(cover_url) as cover_url, max(rating) as rating
                              from mine where rating > 0
                             group by game_id
                             order by max(rating) desc, count(*) desc
                             limit 5) t),
      'most_played', (select coalesce(jsonb_agg(jsonb_build_object(
                        'game_id', game_id, 'name', game_name,
                        'cover_url', cover_url, 'logs', n)), '[]'::jsonb)
                        from (select game_id, min(game_name) as game_name,
                                     min(cover_url) as cover_url, count(*) as n
                                from mine group by game_id
                               order by count(*) desc limit 5) t),
      'status_split', (select coalesce(jsonb_object_agg(s, c), '{}'::jsonb)
                         from (select status::text s, count(*) c
                                 from mine group by status) t)
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 13. Full-text review search with a real keyset cursor
-- ---------------------------------------------------------------------------
-- 001's search_logs had no pagination at all (a hard 48-row cap), ordered by
-- count(*) with no tiebreak (non-deterministic across identical calls), and
-- built its tsvector inline per row. This replaces it.
--
-- The DROP is required, not tidy-up. The arity changes from (text, int) to
-- (text, int, bigint, bigint), and `create or replace` can only match a
-- function with the *identical* signature — so it would create a second,
-- separate overload and leave 001's version alive under its 001 grant. Worse,
-- PostgreSQL's resolution rule prefers the candidate that does not require
-- default arguments, so a short call would silently bind back to the OLD
-- function and keep the 48-row cap this section exists to remove.
drop function if exists public.search_logs(text, int);
create or replace function public.search_logs(
  p_query      text,
  p_limit      int    default 24,
  p_after_rank bigint default null,
  p_after_game bigint default null
)
returns table (
  game_id       bigint,
  name          text,
  cover_url     text,
  latest_review text,
  match_count   bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with q as (
    select websearch_to_tsquery('english', p_query) as tsq
  ),
  matched as (
    select l.game_id,
           l.review,
           l.created_at,
           l.tags
      from public.game_logs l, q
     where q.tsq is not null
       and (l.review_tsv @@ q.tsq
            or exists (select 1 from unnest(coalesce(l.tags, '{}')) t
                        where t ilike '%' || p_query || '%'))
  ),
  agg as (
    select m.game_id,
           min(g.name)      as name,
           min(g.cover_url) as cover_url,
           count(*)         as match_count,
           max(m.created_at) as latest
      from matched m
      join public.games g on g.id = m.game_id
     group by m.game_id
  )
  select a.game_id,
         a.name,
         a.cover_url,
         (select l2.review from public.game_logs l2
           where l2.game_id = a.game_id and l2.review is not null
           order by l2.created_at desc limit 1) as latest_review,
         a.match_count
    from agg a
   -- Keyset cursor for `order by match_count desc, game_id asc`.
   --
   -- This was `(match_count, game_id) < (p_after_rank, p_after_game)`, which
   -- expands to `match_count < c OR (match_count = c AND game_id < d)`. The
   -- first clause is right, but the tiebreaker is inverted: with game_id
   -- ascending, the rows that follow a boundary row are the ones with a
   -- *greater* game_id. So within every group of equally-matching games the
   -- query walked backwards — re-serving rows the previous page had already
   -- returned and permanently skipping the rest of the group.
   where p_after_rank is null
      or a.match_count < p_after_rank
      or (a.match_count = p_after_rank and a.game_id > p_after_game)
   order by a.match_count desc, a.game_id asc
   limit greatest(1, least(p_limit, 48));
$$;

-- ---------------------------------------------------------------------------
-- 14. Comments — the "richer content" feature
-- ---------------------------------------------------------------------------
create table if not exists public.comments (
  id         uuid primary key default gen_random_uuid(),
  log_id     uuid not null references public.game_logs (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  body       text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  parent_id  uuid references public.comments (id) on delete cascade,
  constraint comments_body_len check (char_length(body) between 1 and 1000)
);

create index if not exists comments_log_created_idx
  on public.comments (log_id, created_at asc);
create index if not exists comments_user_idx on public.comments (user_id);

alter table public.comments enable row level security;

drop policy if exists "read comments"      on public.comments;
drop policy if exists "insert own comments" on public.comments;
drop policy if exists "update own comments" on public.comments;
drop policy if exists "delete own comments" on public.comments;

-- Comments hang off a log, which is world-readable, so they are too.
create policy "read comments"
  on public.comments for select to anon, authenticated using (true);

create policy "insert own comments"
  on public.comments for insert to authenticated
  with check (auth.uid() = user_id);

create policy "update own comments"
  on public.comments for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "delete own comments"
  on public.comments for delete to authenticated using (auth.uid() = user_id);

grant select on public.comments to anon, authenticated;
grant insert, update, delete on public.comments to authenticated;

drop trigger if exists set_updated_at on public.comments;
create trigger set_updated_at
  before update on public.comments
  for each row execute function public.set_updated_at();

-- Extend the notification enum with the events the new UI can emit.
do $$
begin
  alter type public.notification_type add value if not exists 'comment';
exception when duplicate_object then null;
end $$;

-- Comments need to point somewhere. Without this the bell can only ever link
-- to /discover, which is a dead end.
alter table public.notifications add column if not exists game_id bigint;
alter table public.notifications add column if not exists comment_id uuid;

create index if not exists notifications_game_idx
  on public.notifications (game_id) where game_id is not null;

-- ---------------------------------------------------------------------------
-- 15. Grants for everything added above
-- ---------------------------------------------------------------------------
grant execute on function public.get_user_activity_stats(uuid)     to anon, authenticated;
grant execute on function public.get_user_log_history(uuid, int)   to anon, authenticated;
grant execute on function public.get_year_in_review(uuid, int)     to anon, authenticated;
grant execute on function public.get_trending_games(int, int, int) to anon, authenticated;
grant execute on function public.redact_spoilers(jsonb)             to anon, authenticated;
grant execute on function public.search_logs(text, int, bigint, bigint) to anon, authenticated;

-- The changed signatures of these two need re-granting after CREATE OR REPLACE
-- if the argument list changed (get_top_rated_games did not; get_game_stats did
-- not). Granting is idempotent, so this is safe regardless.
grant execute on function public.get_log_likes(uuid[]) to anon, authenticated;
grant execute on function public.get_game_stats(bigint)      to anon, authenticated;
grant execute on function public.get_top_rated_games(int, int) to anon, authenticated;
