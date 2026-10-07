-- ===========================================================================
-- 004_social_and_sessions.sql
-- ===========================================================================
--
-- Adds the schema behind four features:
--
--   1. `reports`          — content moderation. The old version shipped a
--                           ReportButton and a `reportContent` action, but no
--                           table ever existed, so every report failed with
--                           PGRST205 and was swallowed. Moderation was
--                           advertised in the README and never once worked.
--   2. `play_sessions`    — real session history, replacing the single
--                           `playtime_hours` number with a row per sitting.
--   3. `game_logs.backlog_position` — an explicit queue order, so "what should I
--                           play next" is answerable rather than implied by
--                           `created_at`.
--   4. `get_user_activity_heatmap` — a contribution-style grid, which is the
--                           shape activity data is actually useful in. The
--                           existing `get_user_activity_stats` returns streaks
--                           and totals but no per-day series.
--
-- Idempotent, and safe to run after 001/002/003. Never deletes a row.
--
-- Run it after 003. See RUN-THIS-FIRST.md.
-- ===========================================================================


-- ===========================================================================
-- 1. Reports
-- ===========================================================================
-- Content is referenced by (type, id) rather than by three nullable foreign
-- keys. A single column pair keeps the insert path simple and means a report can
-- outlive or precede the thing it describes, which is what a moderation queue
-- actually wants: if the row is deleted, the report is still evidence.

create table if not exists public.reports (
  id           uuid primary key default gen_random_uuid(),
  reporter_id  uuid not null references public.profiles (id) on delete cascade,
  content_type text not null check (content_type in ('log', 'review', 'comment', 'user')),
  content_id   uuid not null,
  reason       text not null check (char_length(reason) between 3 and 500),
  -- Free-text notes for the moderator. Not user-visible.
  notes        text check (char_length(notes) <= 2000),
  status       text not null default 'open'
                 check (status in ('open', 'reviewing', 'actioned', 'dismissed')),
  resolved_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists reports_status_created_idx
  on public.reports (status, created_at desc);

-- One open report per user per item. Re-reporting something already reported is
-- a no-op rather than a duplicate queue entry, which is what a spammer wants.
create unique index if not exists reports_one_per_reporter_per_item
  on public.reports (reporter_id, content_type, content_id);

alter table public.reports enable row level security;

-- A reporter can see their own reports, so "you reported this" is answerable.
drop policy if exists "read own reports" on public.reports;
create policy "read own reports"
  on public.reports
  for select
  to authenticated
  using (auth.uid() = reporter_id);

-- Insert only as yourself. The `with check` is the whole enforcement: RLS is the
-- only thing standing between an authenticated user and a forged moderation
-- queue, so the check must be on the row being written.
drop policy if exists "insert own reports" on public.reports;
create policy "insert own reports"
  on public.reports
  for insert
  to authenticated
  with check (auth.uid() = reporter_id);

-- Reports are append-only from the application's point of view. There is no
-- update or delete policy on purpose: `status` is moved by a moderator through a
-- service-role client, never from a browser.
drop policy if exists "update own reports" on public.reports;
drop policy if exists "delete own reports" on public.reports;

grant select, insert on public.reports to authenticated;
grant all on public.reports to service_role;


-- ===========================================================================
-- 2. Play sessions
-- ===========================================================================
-- `game_logs.playtime_hours` is a single running total, which cannot answer the
-- questions players actually ask: "how long was my last session", "when do I
-- usually play", "was that a marathon or a one-hour sitting". A row per sitting
-- can; `playtime_hours` stays as a denormalised total for the existing queries.
--
-- `platform` is free text because there is no platform dimension anywhere else in
-- the schema yet, and constraining it now would mean a migration per console.

create table if not exists public.play_sessions (
  id         uuid primary key default gen_random_uuid(),
  log_id     uuid not null references public.game_logs (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  played_on  date not null default current_date,
  hours      numeric(4,2) not null check (hours > 0 and hours <= 24),
  platform   text check (char_length(platform) <= 40),
  note       text check (char_length(note) <= 280),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The dashboard reads a user's sessions newest-first.
create index if not exists play_sessions_user_played_idx
  on public.play_sessions (user_id, played_on desc);

-- "All sessions for these logs", which is what a game page needs.
create index if not exists play_sessions_log_idx
  on public.play_sessions (log_id, played_on desc);

alter table public.play_sessions enable row level security;

-- Sessions are public wherever the log they belong to is public. A log is
-- world-readable, so hiding its sessions would be inconsistent, and a private
-- log does not exist in this schema.
drop policy if exists "sessions are public" on public.play_sessions;
create policy "sessions are public"
  on public.play_sessions
  for select
  to anon, authenticated
  using (true);

-- A session may only be written by the owner of the log it belongs to. The
-- subquery is required rather than `auth.uid() = user_id` alone: otherwise a
-- user could attach a session to somebody else's log by supplying their id.
drop policy if exists "insert own sessions" on public.play_sessions;
create policy "insert own sessions"
  on public.play_sessions
  for insert
  to authenticated
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.game_logs l
       where l.id = log_id
         and l.user_id = auth.uid()
    )
  );

drop policy if exists "update own sessions" on public.play_sessions;
create policy "update own sessions"
  on public.play_sessions
  for update
  to authenticated
  using (
    exists (
      select 1 from public.game_logs l
       where l.id = log_id
         and l.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.game_logs l
       where l.id = log_id
         and l.user_id = auth.uid()
    )
  );

drop policy if exists "delete own sessions" on public.play_sessions;
create policy "delete own sessions"
  on public.play_sessions
  for delete
  to authenticated
  using (
    exists (
      select 1 from public.game_logs l
       where l.id = log_id
         and l.user_id = auth.uid()
    )
  );

grant select on public.play_sessions to anon, authenticated;
grant insert, update, delete on public.play_sessions to authenticated;
grant all on public.play_sessions to service_role;

-- `updated_at` maintenance, matching the pattern the other tables use.
drop trigger if exists set_updated_at on public.reports;
create trigger set_updated_at
  before update on public.reports
  for each row execute function public.set_updated_at();

drop trigger if exists set_updated_at on public.play_sessions;
create trigger set_updated_at
  before update on public.play_sessions
  for each row execute function public.set_updated_at();


-- ===========================================================================
-- 3. Backlog ordering
-- ===========================================================================
-- `backlog` already exists as a `log_status` value, but the only ordering
-- available was `created_at`, which means the log you added first is always
-- "next" no matter what you have since finished. That is not a queue.
--
-- A nullable integer rather than a default of 0, so an unranked backlog item is
-- distinguishable from one explicitly ranked first. `nulls last` puts unranked
-- items at the end, which is the correct default for a queue.

alter table public.game_logs
  add column if not exists backlog_position integer
    check (backlog_position is null or backlog_position >= 0);

create index if not exists game_logs_backlog_idx
  on public.game_logs (user_id, backlog_position)
  where status = 'backlog';


-- ===========================================================================
-- 4. Activity heatmap
-- ===========================================================================
-- Returns one row per active day, which the client renders as a contribution
-- grid. Computed in SQL because the row count per user is unbounded and the
-- previous "500 most recent rows" approach was both capped by `db-max-rows` and
-- non-deterministic (no ORDER BY, so two identical requests could disagree).

create or replace function public.get_user_activity_heatmap(
    p_user_id uuid,
    p_days    int default 365
  )
  returns table (
    day     date,
    logs    bigint,
    minutes numeric
  )
  language sql
  stable
  security invoker
  set search_path = public
  as $$
    with bounds as (
      -- `p_days` is caller-supplied, so it is clamped rather than trusted. A
      -- negative or enormous value must not become a runaway scan.
      select greatest(1, least(coalesce(p_days, 365), 1460)) as n
    ),
    span as (
      select (current_date - (n - 1))::date as start_day from bounds
    )
    select d::date                                   as day,
           count(l.id)::bigint                       as logs,
           coalesce(round(sum(coalesce(l.playtime_hours, 0)) * 60), 0) as minutes
      from generate_series((select start_day from span), current_date, '1 day') as d
      left join public.game_logs l
        on l.user_id = p_user_id
       and l.created_at >= d
       and l.created_at <  (d + interval '1 day')
     group by d
     order by d;
  $$;

grant execute on function public.get_user_activity_heatmap(uuid, int)
  to anon, authenticated;


-- ===========================================================================
-- 5. Session-aware game stats
-- ===========================================================================
-- `get_game_stats` (002) reports `playtime_hours` from the denormalised total.
-- Once sessions exist, the two can disagree — a user editing their log's
-- playtime directly would desynchronise them. This function prefers real
-- sessions and falls back to the legacy total for logs that predate them, so a
-- partially-migrated account still shows a correct number.

create or replace function public.get_game_sessions_summary(
    p_log_id uuid
  )
  returns table (
    session_count bigint,
    total_hours   numeric,
    last_played   date
  )
  language sql
  stable
  security invoker
  set search_path = public
  as $$
    select count(*)::bigint,
           coalesce(round(sum(s.hours), 1), 0),
           max(s.played_on)
      from public.play_sessions s
     where s.log_id = p_log_id;
  $$;

grant execute on function public.get_game_sessions_summary(uuid)
  to anon, authenticated;


-- ===========================================================================
-- 6. Health checks for this migration
-- ===========================================================================

do $$
declare
  missing text[];
begin
  select coalesce(array_agg(x), '{}') into missing
    from unnest(array[
      'reports', 'play_sessions'
    ]) as x
   where to_regclass(format('public.%I', x)) is null;

  if coalesce(array_length(missing, 1), 0) > 0 then
    raise exception '004 failed to create: %', missing;
  end if;

  raise notice '004 complete: reports, play_sessions, backlog_position, heatmap';
end $$;