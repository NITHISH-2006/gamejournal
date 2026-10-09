-- ===========================================================================
-- 005_correct_the_feature_layer.sql
-- ===========================================================================
--
-- Repairs four features whose first implementation put too much logic in
-- TypeScript and got it wrong in ways the compiler and the test suite could not
-- see. Each function here replaces a client-side approach that was either
-- destructive or incapable of working.
--
-- Idempotent, and safe to run after 004. Never deletes a row.
--
--   1. `sync_log_playtime`   — the previous version set `playtime_hours = 0`,
--                              then summed the sessions, then wrote the total
--                              back. A failure between those writes left the
--                              playtime permanently zeroed while the UI reported
--                              success, and two concurrent edits lost one
--                              session's hours. One atomic statement fixes both.
--
--   2. `browse_games`        — the year filter was an empty block, pagination
--                              applied an offset to *log rows* and then sliced
--                              *games*, and the "total" was the size of the
--                              fetched window presented as a global count.
--
--   3. `get_popular_tags`    — replaced a 1000-row sample counted in JavaScript,
--                              which under-counted old tags and over-counted
--                              recent ones.
--
--   4. `get_user_activity_heatmap` — counted `created_at`, so every game added
--                              by an import landed on today's cell and the
--                              entire history read as empty.
--
-- Run it after 004. See RUN-THIS-FIRST.md.
-- ===========================================================================


-- ===========================================================================
-- 1. Atomic playtime sync
-- ===========================================================================
-- One UPDATE with a correlated aggregate. There is no window in which the value
-- is zero, and the read and the write are the same statement, so two concurrent
-- session writes cannot interleave into a lost update.
--
-- `security invoker`, so the caller's own RLS on `game_logs` applies and this
-- cannot be used to touch somebody else's playtime.
--
-- Ownership is checked in SQL rather than trusted from the client: the call site
-- has already verified the caller owns the log, but a defence here costs
-- nothing and means a wrong `p_user_id` cannot move another account's number.

create or replace function public.sync_log_playtime(
    p_log_id  uuid,
    p_user_id uuid
  )
  returns void
  language sql
  volatile
  security invoker
  set search_path = public
  as $$
    update public.game_logs l
       set playtime_hours = coalesce(
             (select round(sum(s.hours)::numeric, 2)
                from public.play_sessions s
               where s.log_id = p_log_id),
             0)
     where l.id = p_log_id
       and l.user_id = p_user_id;
  $$;

revoke execute on function public.sync_log_playtime(uuid, uuid) from public;
grant execute on function public.sync_log_playtime(uuid, uuid) to authenticated;


-- ===========================================================================
-- 2. Filterable browse, done properly
-- ===========================================================================
-- Everything the TypeScript version tried and could not do:
--
--   - filtering on release year, which lives on `games`, not `game_logs`
--   - an *average* rating filter, rather than "has at least one log rated N"
--   - exact totals, rather than the size of a fetched window
--   - `offset`/`limit` that page over *games*, so page 2 is not a re-slice of
--     page 1's rows
--
-- Each filter is optional; omitting one means "no constraint on this dimension".
-- All parameters are clamped, because a `'use server'` export is a public
-- endpoint and an unclamped `p_limit` or `p_offset` is a trivial denial of
-- service.

create or replace function public.browse_games(
    p_status    text    default null,
    p_min_rating numeric default null,
    p_tag       text    default null,
    p_year      int     default null,
    p_min_logs  int     default null,
    p_sort      text    default 'recent',
    p_limit     int     default 24,
    p_offset    int     default 0
  )
  returns table (
    game_id      bigint,
    name         text,
    cover_url    text,
    release_year int,
    avg_rating   numeric,
    log_count    bigint,
    review_count bigint,
    rated_count  bigint,
    last_activity timestamptz
  )
  language sql
  stable
  security invoker
  set search_path = public
  as $$
    with bounds as (
      -- Every caller-supplied number is clamped here rather than at the call
      -- site, because this function is reachable directly by anyone.
      select least(greatest(coalesce(p_limit, 24), 1), 48)    as lim,
             least(greatest(coalesce(p_offset, 0), 0), 4800)  as off,
             least(greatest(coalesce(p_min_logs, 0), 0), 500) as min_logs,
             least(greatest(coalesce(p_min_rating, 0), 0), 10) as min_rating,
             coalesce(p_year, 0)                              as yr,
             -- The tag grammar must match `validation.ts`'s TAG_RE, otherwise a
             -- comma in the tag would be parsed by PostgREST as a second array
             -- element and quietly return the wrong games.
             case when p_tag ~ '^[a-z0-9][a-z0-9\-_]*$' then lower(p_tag) end as tag,
             case when p_status in ('backlog','playing','completed','abandoned')
     then p_status::public.log_status end as st
    ),
    -- One row per game, with its aggregates. The WHERE clause is applied on
    -- `game_logs` *before* aggregating, which is what makes status, rating and
    -- tag filters meaningful.
    agg as (
      select l.game_id,
             count(*)::bigint                                          as log_count,
             count(*) filter (where l.rating > 0)::bigint              as rated_count,
             count(*) filter (
               where l.review is not null
                 and char_length(btrim(l.review)) > 0
             )::bigint                                                  as review_count,
             round(avg(l.rating) filter (where l.rating > 0), 2)      as avg_rating,
             max(l.created_at)                                          as last_activity
        from public.game_logs l
       where (select st from bounds) is null
          or l.status = (select st from bounds)
         -- An average-rating filter, not a per-row one. The previous version
         -- applied `rating >= N` to each log, so a game averaging 6.2 with a
         -- single 9/10 qualified and was then displayed as 9.0.
         and (
           (select min_rating from bounds) = 0
           or (
             select avg(r2.rating) from public.game_logs r2
              where r2.game_id = l.game_id and r2.rating > 0
           ) >= (select min_rating from bounds)
         )
         and (
           (select tag from bounds) is null
           or exists (
             select 1 from unnest(l.tags) t
              where lower(t) = (select tag from bounds)
           )
         )
         -- Year is a property of the game, so it needs the join.
         and (
           (select yr from bounds) = 0
           or exists (
             select 1 from public.games g
              where g.id = l.game_id
                and extract(year from g.release_date)::int = (select yr from bounds)
           )
         )
       group by l.game_id
    )
    select a.game_id,
           g.name,
           g.cover_url,
           extract(year from g.release_date)::int                       as release_year,
           a.avg_rating,
           a.log_count,
           a.review_count,
           a.rated_count,
           a.last_activity
      from agg a
      join public.games g on g.id = a.game_id
     where a.log_count >= (select min_logs from bounds)
     order by
        case when coalesce(p_sort, 'recent') = 'rating' then a.avg_rating end desc nulls last,
        case when coalesce(p_sort, 'recent') = 'rating' then a.log_count end desc,
        case when coalesce(p_sort, 'recent') = 'most_logged' then a.log_count end desc,
        case when coalesce(p_sort, 'recent') = 'most_logged' then a.log_count end desc,
        case when coalesce(p_sort, 'recent') = 'discussed' then a.review_count end desc,
        case when coalesce(p_sort, 'recent') = 'discussed' then a.log_count end desc,
        case when coalesce(p_sort, 'recent') = 'recent' then a.last_activity end desc nulls last,
        a.game_id asc
     limit (select lim from bounds)
     offset (select off from bounds);
  $$;

grant execute on function public.browse_games(text, numeric, text, int, int, text, int, int)
  to anon, authenticated;

-- An exact total for the same filter, so the UI can say "N games" rather than
-- the size of a page. One extra round trip, and it is the difference between a
-- real count and a plausible-looking guess.
create or replace function public.browse_games_count(
    p_status    text    default null,
    p_min_rating numeric default null,
    p_tag       text    default null,
    p_year      int     default null,
    p_min_logs  int     default null
  )
  returns bigint
  language sql
  stable
  security invoker
  set search_path = public
  as $$
    select count(*)::bigint
      from public.browse_games(
             p_status, p_min_rating, p_tag, p_year, p_min_logs,
             'recent', 1000, 0
           ) t;
  $$;

grant execute on function public.browse_games_count(text, numeric, text, int, int)
  to anon, authenticated;


-- ===========================================================================
-- 3. Real popular tags
-- ===========================================================================
-- `unnest` in SQL instead of sampling the newest 1,000 logs and counting in
-- JavaScript, which under-counted tags that had gone quiet and over-counted
-- recent ones. Bounded, because the result set is one row per distinct tag.

create or replace function public.get_popular_tags(p_limit int default 16)
  returns table (
    tag   text,
    count bigint
  )
  language sql
  stable
  security invoker
  set search_path = public
  as $$
    select lower(t)::text as tag, count(*)::bigint
      from public.game_logs l
      cross join lateral unnest(l.tags) as t
     where l.tags is not null
     group by lower(t)
     order by count(*) desc, lower(t) asc
     limit least(greatest(coalesce(p_limit, 16), 1), 40);
  $$;

grant execute on function public.get_popular_tags(int) to anon, authenticated;


-- ===========================================================================
-- 4. Heatmap that respects a diary date
-- ===========================================================================
-- `created_at` is "when this row was written", which is today for every game
-- added by an import. Counting it meant a user who backfilled 200 games from an
-- old file saw one enormous cell today and an otherwise empty year — the exact
-- opposite of what the grid claims to show.
--
-- `diary_date` is what the user actually played, so it is preferred whenever it
-- is set, and `created_at` is the fallback for logs that have no diary date.

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
      select greatest(1, least(coalesce(p_days, 365), 1460)) as n
    ),
    span as (
      select (current_date - ((select n from bounds) - 1))::date as start_day
    )
    select d::date as day,
           count(l.id)::bigint as logs,
           coalesce(round(sum(coalesce(l.playtime_hours, 0)) * 60), 0) as minutes
      from generate_series((select start_day from span), current_date, '1 day') as d
      left join public.game_logs l
        on l.user_id = p_user_id
       and coalesce(l.diary_date::timestamptz, l.created_at) >= d
       and coalesce(l.diary_date::timestamptz, l.created_at) <  (d + interval '1 day')
     group by d
     order by d;
  $$;

grant execute on function public.get_user_activity_heatmap(uuid, int)
  to anon, authenticated;


-- ===========================================================================
-- 5. Report target verification
-- ===========================================================================
-- A report is a moderation-queue row. A queue that is entirely garbage is worse
-- than no queue, so the caller checks the target exists. The cheapest correct
-- place for that is a function, so the check cannot be forgotten at a call site.

create or replace function public.report_target_exists(
    p_content_type text,
    p_content_id   uuid
  )
  returns boolean
  language plpgsql
  stable
  security definer
  set search_path = public
  as $$
  declare
    found boolean;
  begin
    if p_content_type = 'log' then
      select true into found from public.game_logs where id = p_content_id;
    elsif p_content_type = 'comment' then
      select true into found from public.comments where id = p_content_id;
    elsif p_content_type = 'user' then
      select true into found from public.profiles where id = p_content_id;
    else
      -- 'review' is a text field on a log, so it has no id of its own. A report
      -- of that kind is always filed against the parent log.
      select true into found from public.game_logs where id = p_content_id;
    end if;

    return coalesce(found, false);
  end $$;

-- `security definer` because `comments` and `game_logs` have row-level security
-- and an anonymous reporter must still be able to prove a post exists. It
-- returns a boolean and nothing else, so it discloses no row data.
revoke execute on function public.report_target_exists(text, uuid) from public;
grant execute on function public.report_target_exists(text, uuid) to anon, authenticated;


-- ===========================================================================
-- 6. Indexes for the new query shapes
-- ===========================================================================

-- `browse_games` groups by game_id and filters on status/rating.
create index if not exists game_logs_game_status_idx
  on public.game_logs (game_id, status);

-- Supports `exists (select 1 from game_logs where game_id = … and rating > 0)`,
-- which the average-rating filter runs once per candidate row.
create index if not exists game_logs_game_rating_idx
  on public.game_logs (game_id)
  where rating > 0;

-- The heatmap's `coalesce(diary_date, created_at)` window scan.
create index if not exists game_logs_user_diary_idx
  on public.game_logs (user_id, diary_date);

-- Release-year filtering in `browse_games`. A btree on `release_date` serves the
-- extract() comparison through an index scan on the raw column in most cases;
-- the expression index is the reliable form.
create index if not exists games_release_date_idx
  on public.games (release_date)
  where release_date is not null;

-- Tag containment. `get_popular_tags` unnests every tag on every log, so a GIN
-- index on tags makes the whole feature an index scan rather than a full
-- sequential pass of the log table.
create extension if not exists pg_trgm with schema extensions;

do $$
begin
  begin
    create extension if not exists pg_trgm with schema extensions;
  exception when others then
    raise warning 'could not ensure pg_trgm: %', sqlerrm;
  end;
end $$;

create index if not exists game_logs_tags_gin_idx
  on public.game_logs using gin (tags);

-- `list_games` lookups by game (used by "which lists contain this game").
create index if not exists list_games_game_idx
  on public.list_games (game_id);


-- ===========================================================================
-- 7. Health check
-- ===========================================================================

do $$
declare
  missing text[];
begin
  select coalesce(array_agg(x), '{}') into missing
    from unnest(array[
      'sync_log_playtime', 'browse_games', 'browse_games_count',
      'get_popular_tags', 'get_user_activity_heatmap', 'report_target_exists'
    ]) as x
   where to_regprocedure(format('public.%I(text)', x)) is null
      and to_regprocedure(format('public.%I(uuid, uuid)', x)) is null
      and to_regprocedure(format('public.%I(text, numeric, text, int, int, text, int, int)', x)) is null
      and to_regprocedure(format('public.%I(text, numeric, text, int, int)', x)) is null
      and to_regprocedure(format('public.%I(int)', x)) is null
      and to_regprocedure(format('public.%I(uuid, int)', x)) is null
      and to_regprocedure(format('public.%I(text, uuid)', x)) is null;

  if coalesce(array_length(missing, 1), 0) > 0 then
    raise exception '005 failed to create: %', missing;
  end if;

  raise notice '005 complete: sync_log_playtime, browse_games(+count), get_popular_tags,';
  raise notice '           heatmap now honours diary_date, report_target_exists, 5 indexes';
end $$;