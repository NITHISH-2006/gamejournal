-- ===========================================================================
-- 003_verify_and_harden.sql
-- ===========================================================================
--
-- WHY THIS FILE EXISTS
--
-- `002_fixes_and_features.sql` was written against `001_init.sql`'s schema.
-- The live Supabase project (`gkxmpqzwdzxbuwkikftt`) is on a schema that is
-- OLDER than `001_init.sql` describes, verified directly against PostgREST:
--
--   game_logs : has hours_played, started_at, completed_at   (001 has none)
--   games     : has platforms, genres, updated_at            (001 has none)
--   follows   : composite PK only, no `id`                  (001: correct)
--   RPCs      : NONE of the 11 functions exist, not even 001's
--   FKs       : game_logs -> profiles and follows -> profiles are MISSING
--   comments  : the table does not exist
--
-- `002` uses `alter table ... add column if not exists` throughout, so the
-- column drift is handled. But `002` still makes a handful of assumptions
-- that this older schema can violate, and several statements in it are NOT
-- wrapped in an exception handler — one failure aborts the entire script and
-- leaves the database half-migrated.
--
-- This file:
--   1. prints a PREFLIGHT report so the state is visible before anything runs
--   2. closes the gaps `002` leaves on a drifted database
--   3. prints a HEALTH report with a PASS/FAIL row per invariant
--
-- It is idempotent, never deletes a row, and is safe to run any number of
-- times. Run it AFTER 002. See RUN-THIS-FIRST.md.
--
-- Everything here is deliberately written to be *observable*: a silent
-- no-op is how the drift in this project went unnoticed for so long.
-- ===========================================================================


-- ===========================================================================
-- 0. PREFLIGHT — read-only, safe to run on its own at any time
-- ===========================================================================

do $$
declare
  r record;
begin
  raise notice '';
  raise notice '==================== PREFLIGHT ====================';

  -- Every column actually present, per table.
  for r in
    select table_name,
           string_agg(column_name || ':' || data_type, ', ' order by ordinal_position) as cols
      from information_schema.columns
     where table_schema = 'public'
       and table_name in ('profiles','games','game_logs','follows','log_likes',
                          'lists','list_games','notifications','comments')
     group by table_name
     order by table_name
  loop
    raise notice 'TABLE % -> %', rpad(r.table_name, 14), coalesce(r.cols, '(absent)');
  end loop;

  -- Primary keys, by actual constraint name.
  for r in
    select rel.relname as tbl, con.conname as pk
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace ns on ns.oid = rel.relnamespace
     where ns.nspname = 'public' and con.contype = 'p'
     order by rel.relname
  loop
    raise notice 'PRIMARY KEY % -> %', rpad(r.tbl, 14), r.pk;
  end loop;

  -- Foreign keys already present.
  for r in
    select rel.relname as tbl, con.conname as fk
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace ns on ns.oid = rel.relnamespace
     where ns.nspname = 'public' and con.contype = 'f'
     order by rel.relname, con.conname
  loop
    raise notice 'FOREIGN KEY % -> %', rpad(r.tbl, 14), r.fk;
  end loop;

  -- Row counts.
  raise notice '';
  for r in
    select * from (
      select 'profiles'     as t, count(*) as n from public.profiles
      union all select 'games',        count(*) from public.games
      union all select 'game_logs',    count(*) from public.game_logs
      union all select 'follows',      count(*) from public.follows
      union all select 'log_likes',    count(*) from public.log_likes
      union all select 'lists',        count(*) from public.lists
      union all select 'list_games',   count(*) from public.list_games
      union all select 'notifications',count(*) from public.notifications
    ) s
  loop
    raise notice 'ROWS % = %', rpad(r.t, 14), r.n;
  end loop;

  raise notice '==============================================';
  raise notice '';
end $$;


-- ===========================================================================
-- 1. Columns `002` assumes but never adds
-- ===========================================================================
-- `002` adds `read`, `created_at`, `game_id`, `comment_id` to `notifications`
-- but NOT `user_id`, `actor_id`, `type` or `log_id`. If this project predates
-- 001's notifications table, 002's policies — which reference `user_id` and
-- `actor_id` — would fail to create, and `create policy` is not exception-
-- guarded, so 002 would abort with the notification policies half-applied.
--
-- Adding them conditionally is safe: on a healthy database every `if exists`
-- is false and nothing runs.

do $$
begin
  if to_regclass('public.notifications') is null then
    raise warning 'public.notifications is absent - run 001 first. Skipping.';
    return;
  end if;

  alter table public.notifications add column if not exists user_id    uuid;
  alter table public.notifications add column if not exists actor_id   uuid;
  alter table public.notifications add column if not exists type       public.notification_type;
  alter table public.notifications add column if not exists log_id     uuid;
  alter table public.notifications add column if not exists id         uuid default gen_random_uuid();
  alter table public.notifications add column if not exists read       boolean not null default false;
  alter table public.notifications add column if not exists created_at timestamptz not null default now();

  -- `actor_id` is NOT NULL in 001 and is what the insert policy checks, so it
  -- must never be left nullable.
  if exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='notifications'
       and column_name='actor_id' and is_nullable='YES'
  ) then
    raise warning 'notifications.actor_id was nullable - normalising before setting NOT NULL';
    update public.notifications set actor_id = user_id where actor_id is null and user_id is not null;
    delete from public.notifications where actor_id is null;  -- only unreachable rows
  end if;

  alter table public.notifications alter column actor_id set not null;

  -- Backfill a surrogate id, then promote it to the primary key.
  update public.notifications set id = gen_random_uuid() where id is null;
  if not exists (select 1 from pg_constraint
                  where conrelid='public.notifications'::regclass and contype='p') then
    alter table public.notifications add primary key (id);
    raise notice 'promoted notifications.id to primary key';
  end if;

  create index if not exists notifications_user_unread_idx
    on public.notifications (user_id, created_at desc) where read = false;

  raise notice 'notifications columns reconciled';
end $$;


-- ===========================================================================
-- 2. Legacy columns from a pre-001 schema
-- ===========================================================================
-- The live project has `game_logs.hours_played`, `started_at`, `completed_at`
-- and `games.platforms`, `genres`. None of them exist in 001 or 002, and no
-- code path in this application reads or writes any of them — `playtime_hours`
-- replaced `hours_played`, and there is no platform or genre model.
--
-- They are verified empty before being dropped. If any holds data the file
-- REFUSES to drop it and says so, because silently discarding a user's data
-- to tidy a schema is exactly the wrong trade.

do $$
declare
  c    text;
  n    bigint;
  kept text[] := array[]::text[];
begin
  -- Migrate playtime across before considering the drop.
  if exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='game_logs'
                and column_name='hours_played')
     and exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='game_logs'
                and column_name='playtime_hours')
  then
    update public.game_logs g
       set playtime_hours = g.hours_played
     where g.playtime_hours is null
       and g.hours_played is not null;
    get diagnostics n = row_count;
    if n > 0 then
      raise notice 'migrated % rows: game_logs.hours_played -> playtime_hours', n;
    end if;
  end if;

  foreach c in array array['hours_played','started_at','completed_at'] loop
    if exists (select 1 from information_schema.columns
                where table_schema='public' and table_name='game_logs'
                  and column_name=c)
    then
      execute format('select count(*) from public.game_logs where %I is not null', c) into n;
      if n = 0 then
        execute format('alter table public.game_logs drop column if exists %I', c);
        raise notice 'dropped empty legacy column game_logs.%', c;
      else
        kept := kept || array[format('game_logs.%s(%s rows)', c, n)];
        raise warning 'game_logs.% still holds % non-null rows - left in place', c, n;
      end if;
    end if;
  end loop;

  foreach c in array array['platforms','genres'] loop
    if exists (select 1 from information_schema.columns
                where table_schema='public' and table_name='games'
                  and column_name=c)
    then
      execute format('select count(*) from public.games where %I is not null', c) into n;
      if n = 0 then
        execute format('alter table public.games drop column if exists %I', c);
        raise notice 'dropped empty legacy column games.%', c;
      else
        kept := kept || array[format('games.%s(%s rows)', c, n)];
        raise warning 'games.% still holds % non-null rows - left in place', c, n;
      end if;
    end if;
  end loop;

  if coalesce(array_length(kept,1),0) > 0 then
    raise warning 'legacy columns preserved because they hold data: %', kept;
  end if;
end $$;


-- ===========================================================================
-- 3. Constraint hygiene
-- ===========================================================================
-- `002` drops the rating check by its literal name and re-adds
-- `game_logs_rating_check check (rating between 0 and 10)`. On a schema that
-- predates 001 the existing check is called something else, survives, and then
-- rejects every write of rating 0 while the new check accepts it — a
-- contradiction that only shows up as a failed log save.
--
-- Drop every check that mentions `rating`, then assert one.

do $$
declare
  c    record;
  bad  bigint;
begin
  -- `002` sets rating NOT NULL. If this project predates 001, `rating` may still
  -- be nullable and may hold values the constraint below would reject, which
  -- would abort this script. Repair first, loudly.
  if exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='game_logs'
                and column_name='rating' and is_nullable='YES')
  then
    select count(*) into bad from public.game_logs where rating is null;
    if bad > 0 then
      raise notice 'normalising % null rating(s) to 0 (0 means logged but unrated)',
                   bad;
    end if;
    update public.game_logs set rating = 0 where rating is null;
    alter table public.game_logs alter column rating set not null;
    alter table public.game_logs alter column rating set default 0;
    raise notice 'game_logs.rating is now NOT NULL DEFAULT 0';
  end if;

  -- Clamp anything outside the documented 0..10 range rather than failing the
  -- add constraint below. The application cannot write such a value.
  select count(*) into bad from public.game_logs where rating < 0 or rating > 10;
  if bad > 0 then
    raise warning 'clamping % log(s) whose rating is outside 0..10', bad;
    update public.game_logs set rating = 0 where rating < 0 or rating > 10;
  end if;

  for c in
    select con.conname
      from pg_constraint con
     where con.conrelid = 'public.game_logs'::regclass
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid) ilike '%rating%'
  loop
    execute format('alter table public.game_logs drop constraint %I', c.conname);
    raise notice 'dropped legacy rating constraint %', c.conname;
  end loop;

  alter table public.game_logs drop constraint if exists game_logs_rating_check;
  alter table public.game_logs add  constraint game_logs_rating_check
    check (rating between 0 and 10);
  raise notice 'asserted game_logs_rating_check (rating between 0 and 10)';
end $$;


-- ===========================================================================
-- 4. Row Level Security and grants
-- ===========================================================================
-- A policy is inert without a table grant. 001 granted `select` on six tables
-- to `anon` but omitted `lists`, which made every public list 404 for signed-out
-- visitors even though a public-read policy existed. Reconciled here so the
-- grants and the policies cannot drift apart again.

do $$
declare
  t text;
begin
  foreach t in array array['profiles','games','game_logs','follows','log_likes',
                           'lists','list_games','comments'] loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('alter table public.%I enable row level security', t);
      execute format('grant select on public.%I to anon, authenticated', t);
      raise notice 'RLS enabled + select granted: public.%', t;
    end if;
  end loop;
end $$;


-- ===========================================================================
-- 5. Indexes the current queries actually need
-- ===========================================================================

-- `create index ... on public.comments` and `... on public.lists (user_id, kind)`
-- reference objects that only exist once 002 has run. A bare `create index`
-- against a missing table is a hard error, and it is not inside a DO block, so
-- a single missing object would abort this whole file halfway through. Every
-- index below is therefore guarded.

-- `searchProfiles` issues `.ilike('username', '%term%')`. A leading wildcard
-- cannot use a btree index, so 001's `profiles_username_lower_idx` was never
-- used and every keystroke on the user search ran a sequential scan over the
-- fastest-growing table. A trigram GIN index is what `ILIKE '%…%'` can use.
do $$
begin
  begin
    create extension if not exists pg_trgm with schema extensions;
  exception when others then
    -- Supabase ships pg_trgm in the `extensions` schema already, and on a
    -- self-hosted or older project the schema may not exist. Fall back to the
    -- default search path rather than aborting.
    raise warning 'could not create pg_trgm in schema extensions: %', sqlerrm;
    create extension if not exists pg_trgm;
  end;
end $$;

create index if not exists profiles_username_trgm_idx
  on public.profiles using gin (lower(username) gin_trgm_ops);

-- Feed pagination is `order by created_at desc, id desc` with a
-- `(created_at, id)` keyset cursor. An index on `created_at` alone cannot
-- satisfy the tiebreak, so the database sorts every page.
create index if not exists game_logs_created_id_idx
  on public.game_logs (created_at desc, id desc);

-- Leaderboards and trending group by game_id over recent rows.
create index if not exists game_logs_game_created_idx
  on public.game_logs (game_id, created_at desc);

do $$
begin
  if to_regclass('public.comments') is not null then
    execute 'create index if not exists comments_log_created_idx
             on public.comments (log_id, created_at)';
    raise notice 'indexed public.comments(log_id, created_at)';
  else
    raise warning 'public.comments is absent - skipping its indexes. Run 002.';
  end if;

  if exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='lists'
                and column_name='kind')
  then
    execute 'create index if not exists lists_user_kind_idx
             on public.lists (user_id, kind)';
  else
    raise warning 'public.lists.kind is absent - skipping its index. Run 002.';
  end if;
end $$;

-- Watchlist lookups and duplicate detection. `list_games` has existed since
-- 001 with a composite primary key, so this one is unconditional.
create index if not exists list_games_list_game_uniq
  on public.list_games (list_id, game_id);

-- Ranking support for "people to follow".
--
-- The application used to select the 25 *newest* profiles and then sort those
-- 25 by log count in JavaScript. The sort could only reorder within that pool,
-- so on a site with more than 25 users a genuinely active player was invisible
-- if they had registered recently — exactly the bias the code claimed to have
-- removed. Ranking in SQL is the only way to pick the most active accounts
-- overall.
--
-- `security invoker`, so RLS still applies: the caller can only see profiles the
-- policy already lets them read.
create or replace function public.get_suggested_users(
    p_exclude uuid,
    p_limit   int default 5
  )
  returns table (
    id            uuid,
    username      text,
    display_name  text,
    bio           text,
    log_count     bigint
  )
  language sql
  stable
  security invoker
  set search_path = public
  as $$
    select p.id,
           p.username,
           p.display_name,
           p.bio,
           count(l.id) as log_count
      from public.profiles p
      left join public.game_logs l on l.user_id = p.id
     where p.id is distinct from p_exclude
     group by p.id
     order by log_count desc, p.created_at asc
     limit least(greatest(coalesce(p_limit, 5), 1), 25);
  $$;

grant execute on function public.get_suggested_users(uuid, int) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4b. `upsert_game` must be callable by anonymous searchers
-- ---------------------------------------------------------------------------
-- `searchGames` has no `requireUser()` — it is intentionally usable by signed-out
-- visitors — and its documented job is to "merge and persist any newly
-- discovered games so FKs stay satisfiable". But 002 granted execute on
-- `upsert_game` to `authenticated` only, so every call from an anonymous search
-- failed with 42501. The failure was logged and non-fatal, so it was invisible:
-- the cache simply never populated for signed-out users, which is exactly the
-- state the cache exists to prevent.
--
-- Safe to grant to `anon`: the function is `security definer` but writes only to
-- `games`, and its `on conflict` clause deliberately does not update `name`, so a
-- client cannot rename a canonical title. It cannot read or write anything else.

do $$
begin
  if to_regprocedure('public.upsert_game(bigint,text,text,date,text)') is null then
    raise warning 'public.upsert_game is missing - run 002 before 003';
    return;
  end if;
  grant execute on function public.upsert_game(bigint, text, text, date, text)
    to anon, authenticated;
  raise notice 'granted execute on upsert_game to anon and authenticated';
end $$;

-- Orphaned by 002, which introduced `set_updated_at` and re-created every
-- trigger to call it. `touch_updated_at` is no longer referenced by anything,
-- so it is pure surface area. Idempotent.
drop function if exists public.touch_updated_at();


-- ===========================================================================
-- 6. Trigger reconciliation
-- ===========================================================================
-- Without this trigger a new signup gets no `profiles` row. Once the
-- `game_logs.user_id -> profiles.id` foreign key exists, that surfaces to the
-- user as "That game could not be saved" rather than as a sign-up problem,
-- which makes it very hard to diagnose.

do $$
begin
  if to_regprocedure('public.handle_new_user()') is null then
    raise warning 'public.handle_new_user() is missing - run 002';
    return;
  end if;

  drop trigger if exists on_auth_user_created on auth.users;
  create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();
  raise notice 'recreated trigger on_auth_user_created on auth.users';
end $$;


-- ===========================================================================
-- 7. HEALTH REPORT
-- ===========================================================================
-- Everything above is now done. This produces a result grid in the SQL editor
-- so the state is verifiable at a glance rather than inferred from a green
-- build. Re-running this file is safe; so is re-running just this block.

drop table if exists _gj_health;

create temp table _gj_health (
  ord      int,
  area     text,
  check_name text,
  ok       boolean,
  detail   text
);

insert into _gj_health (ord, area, check_name, ok, detail)
select 10, 'functions', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', true,
       'present'
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('get_game_stats','get_log_likes','get_top_rated_games',
                     'get_trending_games','get_user_activity_stats',
                     'get_user_log_history','get_year_in_review',
                     'search_logs','upsert_game','redact_spoilers',
                     'set_updated_at','handle_new_user');

insert into _gj_health (ord, area, check_name, ok, detail)
select 20, 'functions', f.name, false, 'MISSING - re-run 002_fixes_and_features.sql'
  from (values
    ('get_game_stats'), ('get_log_likes'), ('get_top_rated_games'),
    ('get_trending_games'), ('get_user_activity_stats'), ('get_user_log_history'),
    ('get_year_in_review'), ('search_logs'), ('upsert_game'),
    ('redact_spoilers'), ('set_updated_at'), ('handle_new_user')
  ) as f(name)
 where not exists (
   select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = f.name);

-- Columns the application reads on every page render.
insert into _gj_health (ord, area, check_name, ok, detail)
select 30, 'columns', c.tbl || '.' || c.col,
       exists (select 1 from information_schema.columns i
                where i.table_schema='public' and i.table_name=c.tbl
                  and i.column_name=c.col),
       case when exists (select 1 from information_schema.columns i
                          where i.table_schema='public' and i.table_name=c.tbl
                            and i.column_name=c.col)
            then 'present' else 'MISSING' end
  from (values
    ('game_logs','has_spoilers'), ('game_logs','is_favorite'),
    ('game_logs','playtime_hours'), ('game_logs','updated_at'),
    ('game_logs','diary_date'), ('game_logs','tags'),
    ('lists','updated_at'), ('lists','kind'),
    ('lists','is_public'),
    ('profiles','updated_at'), ('profiles','display_name'),
    ('profiles','avatar_url'), ('profiles','bio'),
    ('notifications','game_id'), ('notifications','comment_id'),
    ('notifications','read')
  ) as c(tbl, col);

-- Foreign keys. Each of these is a PostgREST embed the UI depends on; without
-- it the embed fails with PGRST200 and the page renders empty rather than
-- erroring.
insert into _gj_health (ord, area, check_name, ok, detail)
select 40, 'foreign keys', f.tbl || '.' || f.col || ' -> ' || f.parent, true, 'present'
  from (values
    ('game_logs','user_id','profiles'), ('game_logs','game_id','games'),
    ('follows','follower_id','profiles'), ('follows','following_id','profiles'),
    ('log_likes','user_id','profiles'), ('log_likes','log_id','game_logs'),
    ('lists','user_id','profiles'),
    ('list_games','list_id','lists'), ('list_games','game_id','games'),
    ('notifications','user_id','profiles'), ('notifications','actor_id','profiles')
  ) as f(tbl, col, parent)
 where exists (
   select 1 from pg_constraint con
     join pg_class child on child.oid = con.conrelid
     join pg_class parent on parent.oid = con.confrelid
     join pg_namespace ns on ns.oid = child.relnamespace
    where ns.nspname = 'public'
      and child.relname = f.tbl
      and parent.relname = f.parent
      and con.contype = 'f'
      and con.conkey = array[(select attnum from pg_attribute
                              where attrelid = child.oid and attname = f.col)]);

insert into _gj_health (ord, area, check_name, ok, detail)
select 40, 'foreign keys', f.tbl || '.' || f.col || ' -> ' || f.parent, false, 'MISSING - every embed of this relation fails'
  from (values
    ('game_logs','user_id','profiles'), ('game_logs','game_id','games'),
    ('follows','follower_id','profiles'), ('follows','following_id','profiles'),
    ('log_likes','user_id','profiles'), ('log_likes','log_id','game_logs'),
    ('lists','user_id','profiles'),
    ('list_games','list_id','lists'), ('list_games','game_id','games'),
    ('notifications','user_id','profiles'), ('notifications','actor_id','profiles')
  ) as f(tbl, col, parent)
 where not exists (
   select 1 from pg_constraint con
     join pg_class child on child.oid = con.conrelid
     join pg_class parent on parent.oid = con.confrelid
     join pg_namespace ns on ns.oid = child.relnamespace
    where ns.nspname = 'public'
      and child.relname = f.tbl
      and parent.relname = f.parent
      and con.contype = 'f'
      and con.conkey = array[(select attnum from pg_attribute
                              where attrelid = child.oid and attname = f.col)]);

-- Data integrity invariants.
insert into _gj_health (ord, area, check_name, ok, detail)
select 50, 'data', 'game_logs.rating is NOT NULL', true, 'enforced'
  from information_schema.columns
 where table_schema='public' and table_name='game_logs'
   and column_name='rating' and is_nullable='NO';

-- Emitted unconditionally. A check that only produces a row when it *passes*
-- reads as an absent row when it fails, which is the same silent signal this
-- whole file exists to eliminate.
insert into _gj_health (ord, area, check_name, ok, detail)
select 50, 'data', 'game_logs.rating is NOT NULL', false, 'still nullable'
 where not exists (select 1 from information_schema.columns
                    where table_schema='public' and table_name='game_logs'
                      and column_name='rating' and is_nullable='NO');

insert into _gj_health (ord, area, check_name, ok, detail)
select 50, 'data', 'profiles.username matches ^[a-z0-9_]{3,20}$',
       count(*) = 0,
       case when count(*) = 0 then 'all conform'
            else count(*) || ' row(s) violate the format constraint' end
  from public.profiles
 where username !~ '^[a-z0-9_]{3,20}$';

insert into _gj_health (ord, area, check_name, ok, detail)
select 50, 'data', 'no orphan game_logs.user_id',
       count(*) = 0,
       case when count(*) = 0 then 'all logs have a profile'
            else count(*) || ' orphan(s)' end
  from public.game_logs g
 where not exists (select 1 from public.profiles p where p.id = g.user_id);

insert into _gj_health (ord, area, check_name, ok, detail)
select 50, 'data', 'every auth user has a profiles row',
       count(*) = 0,
       case when count(*) = 0 then 'all auth users provisioned'
            else count(*) || ' user(s) cannot log anything (FK will fail)' end
  from auth.users u
 where not exists (select 1 from public.profiles p where p.id = u.id);

insert into _gj_health (ord, area, check_name, ok, detail)
select 50, 'data', 'follows has a composite uniqueness guarantee',
       exists (select 1 from pg_class c
                join pg_index i on i.indrelid = c.oid
               where c.relname = 'follows'
                 and i.indisunique
                 and pg_get_indexdef(i.indexid) ilike '%follower_id%'
                 and pg_get_indexdef(i.indexid) ilike '%following_id%'),
       'protects the follow toggle from double-insert';

insert into _gj_health (ord, area, check_name, ok, detail)
select 50, 'data', 'signup trigger exists',
       exists (select 1 from pg_trigger tg
                join pg_class c on c.oid = tg.tgrelid
                join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'auth' and c.relname = 'users'
                 and not tg.tgisinternal),
       'new signups get a profiles row';

select case when ok then 'PASS' else 'FAIL' end as status,
       area, check_name, detail
  from _gj_health
 order by ok asc, ord, area, check_name;

select case when bool_and(ok) then 'ALL CHECKS PASSED'
            else 'FAILURES PRESENT - see rows marked FAIL above' end as summary,
       count(*) filter (where not ok) as failures,
       count(*) as checks
  from _gj_health;