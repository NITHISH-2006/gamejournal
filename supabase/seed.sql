-- ---------------------------------------------------------------------------
-- Seed data for local development
--
-- Optional. Run after 001_init.sql to get a populated UI without manually
-- logging a dozen games. Requires auth.users rows to already exist, because
-- profiles and game_logs both reference auth.users.
--
-- Create a couple of accounts in the app first (Settings -> Authentication),
-- then replace the placeholder UUIDs below with the real user ids from
-- `select id, email from auth.users;`.
-- ---------------------------------------------------------------------------

-- Cache a few IGDB games so search and logging have something to work with.
insert into public.games (id, name, cover_url, summary, release_date) values
  (1020, 'Grand Theft Auto V',
   'https://images.igdb.com/igdb/image/upload/t_cover_big/co1xzu.jpg',
   'Rockstar North''s sprawling open-world crime epic.', '2013-09-17'),
  (1021, 'Red Dead Redemption 2',
   'https://images.igdb.com/igdb/image/upload/t_cover_big/8m82e.jpg',
   'An epic western tale of life on the road in a fading frontier.', '2018-10-26'),
  (1942, 'The Witcher 3: Wild Hunt',
   'https://images.igdb.com/igdb/image/upload/t_cover_big/49xface.jpg',
   'A narrative monster-hunting RPG set in a vast, morally grey open world.', '2015-05-19'),
  (1158, 'Celeste',
   'https://images.igdb.com/igdb/image/upload/t_cover_big/celestegame.jpg',
   'A precision platformer about climbing a mountain and confronting yourself.', '2018-01-25'),
  (1020 + 100000, 'Outer Wilds',
   'https://images.igdb.com/igdb/image/upload/t_cover_big/ow.jpg',
   'A space exploration game about knowledge, curiosity and a time loop.', '2019-05-28')
on conflict (id) do update
  set name = excluded.name,
      cover_url = excluded.cover_url,
      summary = excluded.summary,
      release_date = excluded.release_date;

-- Example logs. Replace :user_id with a real auth.users id.
--
-- insert into public.game_logs (user_id, game_id, status, rating, review, diary_date, tags, is_favorite)
-- values
--   ('00000000-0000-0000-0000-000000000000', 1942, 'completed', 10,
--    'Still the best RPG ever written. The DLC is worth it too.', '2024-03-14',
--    array['rpg','masterpiece'], true),
--   ('00000000-0000-0000-0000-000000000000', 1021, 'completed', 9,
--    'Atmospheric and beautiful, but the missions drag late.', '2024-02-02',
--    array['open-world'], false);
