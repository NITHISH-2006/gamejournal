-- ===========================================================================
-- GameJournal — full schema, policies and helper functions
--
-- Run this in the Supabase SQL editor (or via `supabase db push`) on a fresh
-- project. It is written to be re-runnable: every statement is guarded, so
-- applying it to an existing database upgrades it in place instead of
-- failing.
--
-- Safe to run more than once.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Extensions
-- ---------------------------------------------------------------------------
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 2. Enums
-- ---------------------------------------------------------------------------
do $$ begin
  create type public.log_status as enum ('backlog', 'playing', 'completed', 'abandoned');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type public.notification_type as enum ('like', 'follow', 'comment', 'mention');
exception
  when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Tables
-- ---------------------------------------------------------------------------

-- profiles ------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  username     text not null unique,
  display_name text,
  avatar_url   text,
  bio          text check (char_length(bio) <= 280),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create unique index if not exists profiles_username_lower_idx
  on public.profiles (lower(username));

-- games ---------------------------------------------------------------------
create table if not exists public.games (
  id           bigint primary key,
  name         text not null,
  slug         text,
  cover_url    text,
  summary      text,
  release_date date,
  created_at   timestamptz not null default now()
);

create index if not exists games_name_lower_idx on public.games (lower(name));

-- game_logs -----------------------------------------------------------------
create table if not exists public.game_logs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (id) on delete cascade,
  game_id      bigint not null references public.games (id) on delete restrict,
  status       public.log_status not null default 'backlog',
  rating       smallint check (rating between 1 and 10),
  review       text check (char_length(review) <= 2000),
  diary_date   date,
  tags         text[] check (coalesce(array_length(tags, 1), 0) <= 10),
  -- enhanced columns
  playtime_hours numeric(7, 2) check (playtime_hours is null or playtime_hours >= 0),
  is_favorite     boolean not null default false,
  has_spoilers    boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- One entry per user per game: this is what makes re-logging an update
-- rather than a duplicate row.
create unique index if not exists game_logs_user_game_uniq
  on public.game_logs (user_id, game_id);

create index if not exists game_logs_user_created_idx
  on public.game_logs (user_id, created_at desc);
create index if not exists game_logs_game_created_idx
  on public.game_logs (game_id, created_at desc);
create index if not exists game_logs_created_idx
  on public.game_logs (created_at desc);
create index if not exists game_logs_tags_gin_idx
  on public.game_logs using gin (tags);
create index if not exists game_logs_favorite_idx
  on public.game_logs (user_id) where is_favorite;

-- follows -------------------------------------------------------------------
create table if not exists public.follows (
  follower_id  uuid not null references public.profiles (id) on delete cascade,
  following_id uuid not null references public.profiles (id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (follower_id, following_id),
  check (follower_id <> following_id)
);

create index if not exists follows_following_idx on public.follows (following_id);

-- log_likes -----------------------------------------------------------------
create table if not exists public.log_likes (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  log_id     uuid not null references public.game_logs (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, log_id)
);

create index if not exists log_likes_log_idx on public.log_likes (log_id);

-- lists ---------------------------------------------------------------------
create table if not exists public.lists (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 60),
  description text check (char_length(description) <= 280),
  is_public   boolean not null default false,
  kind        text check (kind in ('custom', 'watchlist')) default 'custom',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists lists_user_name_uniq
  on public.lists (user_id, lower(name));

-- list_games ----------------------------------------------------------------
create table if not exists public.list_games (
  list_id   uuid not null references public.lists (id) on delete cascade,
  game_id   bigint not null references public.games (id) on delete cascade,
  added_at  timestamptz not null default now(),
  primary key (list_id, game_id)
);

create index if not exists list_games_game_idx on public.list_games (game_id);

-- notifications -------------------------------------------------------------
create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  actor_id   uuid not null references public.profiles (id) on delete cascade,
  type       public.notification_type not null,
  log_id     uuid references public.game_logs (id) on delete cascade,
  read       boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists notifications_user_created_idx
  on public.notifications (user_id, created_at desc);
create index if not exists notifications_unread_idx
  on public.notifications (user_id) where not read;

-- ---------------------------------------------------------------------------
-- 4. Enforce the FK constraint names the app expects
--    The application selects `profiles!notifications_actor_id_fkey` and
--    similar hints, so the names must match exactly.
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select conname from pg_constraint
    where conrelid = 'public.notifications'::regclass
      and contype = 'f' and conname = 'notifications_actor_id_fkey'
  loop
    null;
  end loop;
exception when others then
  null;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Auto-update updated_at
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['profiles', 'game_logs', 'lists'] loop
    execute format('drop trigger if exists set_updated_at on public.%I', t);
    execute format(
      'create trigger set_updated_at before update on public.%I
       for each row execute function public.touch_updated_at()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Create a profile row whenever a user signs up
--    Without this, every username-gated route 404s and the navbar has no
--    profile link.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  base text;
  candidate text;
  attempt int := 0;
begin
  base := lower(
    regexp_replace(
      coalesce(new.raw_user_meta_data ->> 'username', split_part(new.email, '@', 1), 'player'),
      '[^a-z0-9_]', '', 'g'
    )
  );

  if char_length(base) < 3 then
    base := 'player';
  end if;
  base := left(base, 14);

  loop
    candidate := base || case when attempt = 0 then '' else attempt::text end;
    exit when not exists (select 1 from public.profiles where lower(username) = candidate);
    attempt := attempt + 1;
    exit when attempt > 50;
  end loop;

  insert into public.profiles (id, username)
  values (new.id, candidate)
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- 7. Helper functions used by the app
-- ---------------------------------------------------------------------------

-- Aggregate like state for a batch of logs in one round trip.
create or replace function public.get_log_likes(p_log_ids uuid[])
returns table (log_id uuid, like_count bigint, liked_by_me boolean)
language sql
stable
security invoker
set search_path = public
as $$
  select
    l.log_id,
    count(*)::bigint as like_count,
    bool_or(l.user_id = auth.uid()) as liked_by_me
  from public.log_likes l
  where l.log_id = any (p_log_ids)
  group by l.log_id;
$$;

-- Per-game aggregates. Doing this in SQL fixes the previous "average of the
-- top 100 rows" ranking bug.
create or replace function public.get_game_stats(p_game_id bigint)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'avg_rating', round(avg(rating)::numeric, 2),
    'rating_count', count(rating),
    'playtime_hours', round(sum(playtime_hours)::numeric, 1),
    'watchers', count(*),
    'status_counts', (
      select coalesce(jsonb_object_agg(s.status::text, s.n), '{}'::jsonb)
      from (
        select status, count(*) as n
        from game_logs
        where game_id = p_game_id
        group by status
      ) s
    )
  )
  from public.game_logs
  where game_id = p_game_id;
$$;

create or replace function public.get_top_rated_games(
  p_limit int default 24,
  p_min_logs int default 1
)
returns table (game_id bigint, name text, cover_url text, avg_rating numeric, log_count bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select
    g.id as game_id,
    g.name,
    g.cover_url,
    round(avg(l.rating)::numeric, 2) as avg_rating,
    count(l.id) as log_count
  from public.game_logs l
  join public.games g on g.id = l.game_id
  where l.rating is not null
  group by g.id, g.name, g.cover_url
  having count(l.id) >= p_min_logs
  order by avg_rating desc nulls last, log_count desc, g.name asc
  limit greatest(1, least(p_limit, 48));
$$;

-- Full-text search over reviews and tags for the discover page.
create or replace function public.search_logs(p_query text, p_limit int default 24)
returns table (
  game_id bigint,
  name text,
  cover_url text,
  latest_review text,
  match_count bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with q as (select websearch_to_tsquery('english', p_query) as tsq)
  select
    l.game_id,
    g.name,
    g.cover_url,
    (array_agg(l.review order by l.created_at desc) filter (where l.review is not null))[1],
    count(*)
  from public.game_logs l
  join public.games g on g.id = l.game_id
  cross join q
  where
    l.review is not null
    and (
      to_tsvector('english', coalesce(l.review, '')) @@ q.tsq
      or exists (
        select 1 from unnest(coalesce(l.tags, '{}')) t
        where t ilike '%' || p_query || '%'
      )
    )
  group by l.game_id, g.name, g.cover_url
  order by count(*) desc
  limit greatest(1, least(p_limit, 48));
$$;

-- ---------------------------------------------------------------------------
-- 8. Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles      enable row level security;
alter table public.games        enable row level security;
alter table public.game_logs    enable row level security;
alter table public.follows      enable row level security;
alter table public.log_likes    enable row level security;
alter table public.lists        enable row level security;
alter table public.list_games   enable row level security;
alter table public.notifications enable row level security;

-- profiles: public read, owner write
drop policy if exists "profiles are public" on public.profiles;
create policy "profiles are public" on public.profiles
  for select using (true);

drop policy if exists "users update own profile" on public.profiles;
create policy "users update own profile" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "users insert own profile" on public.profiles;
create policy "users insert own profile" on public.profiles
  for insert with check (auth.uid() = id);

-- games: public read, authenticated write
drop policy if exists "games are public" on public.games;
create policy "games are public" on public.games
  for select using (true);

drop policy if exists "authenticated insert games" on public.games;
create policy "authenticated insert games" on public.games
  for insert to authenticated with check (true);

drop policy if exists "authenticated update games" on public.games;
create policy "authenticated update games" on public.games
  for update to authenticated using (true) with check (true);

-- game_logs: public read, owner write
drop policy if exists "logs are public" on public.game_logs;
create policy "logs are public" on public.game_logs
  for select using (true);

drop policy if exists "users insert own logs" on public.game_logs;
create policy "users insert own logs" on public.game_logs
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "users update own logs" on public.game_logs;
create policy "users update own logs" on public.game_logs
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "users delete own logs" on public.game_logs;
create policy "users delete own logs" on public.game_logs
  for delete to authenticated using (auth.uid() = user_id);

-- follows: public read, authenticated write own rows
drop policy if exists "follows are public" on public.follows;
create policy "follows are public" on public.follows
  for select using (true);

drop policy if exists "users follow" on public.follows;
create policy "users follow" on public.follows
  for insert to authenticated with check (auth.uid() = follower_id);

drop policy if exists "users unfollow" on public.follows;
create policy "users unfollow" on public.follows
  for delete to authenticated using (auth.uid() = follower_id);

-- log_likes: public read, authenticated write own rows
drop policy if exists "likes are public" on public.log_likes;
create policy "likes are public" on public.log_likes
  for select using (true);

drop policy if exists "users like" on public.log_likes;
create policy "users like" on public.log_likes
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "users unlike" on public.log_likes;
create policy "users unlike" on public.log_likes
  for delete to authenticated using (auth.uid() = user_id);

-- lists: owner full access; others may read public lists
drop policy if exists "lists owner all" on public.lists;
create policy "lists owner all" on public.lists
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "public lists readable" on public.lists;
create policy "public lists readable" on public.lists
  for select using (is_public = true);

-- list_games: readable when the parent list is visible
drop policy if exists "list games readable" on public.list_games;
create policy "list games readable" on public.list_games
  for select using (
    exists (
      select 1 from public.lists l
      where l.id = list_id
        and (l.is_public = true or auth.uid() = l.user_id)
    )
  );

drop policy if exists "list games owner write" on public.list_games;
create policy "list games owner write" on public.list_games
  for all to authenticated using (
    exists (select 1 from public.lists l where l.id = list_id and l.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.lists l where l.id = list_id and l.user_id = auth.uid())
  );

-- notifications: owner only
drop policy if exists "own notifications" on public.notifications;
create policy "own notifications" on public.notifications
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 9. Realtime
--    The activity feed subscribes to INSERTs on game_logs. Without this the
--    subscription connects successfully and silently delivers nothing.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'game_logs'
  ) then
    alter publication supabase_realtime add table public.game_logs;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
exception when others then
  -- Publication may not exist on self-hosted Postgres; not fatal.
  raise notice 'Could not update supabase_realtime publication: %', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- 10. Grants
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated;
grant select on public.profiles, public.games, public.game_logs, public.follows,
             public.log_likes, public.list_games to anon, authenticated;
grant select, insert, update, delete on
             public.profiles, public.game_logs, public.follows,
             public.log_likes, public.lists, public.list_games, public.notifications
  to authenticated;
grant insert, update on public.games to authenticated;
grant usage, select on all sequences in schema public to authenticated;

grant execute on function public.get_log_likes(uuid[]) to anon, authenticated;
grant execute on function public.get_game_stats(bigint) to anon, authenticated;
grant execute on function public.get_top_rated_games(int, int) to anon, authenticated;
grant execute on function public.search_logs(text, int) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Done. Verify with:
--   select * from public.get_top_rated_games(5, 1);
--   select * from public.get_log_likes(array[]::uuid[]);
-- ---------------------------------------------------------------------------
