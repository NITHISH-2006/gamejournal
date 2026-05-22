'use server';

import { createClient } from '@/lib/supabase';

const CLIENT_ID = process.env.IGDB_CLIENT_ID!;
const CLIENT_SECRET = process.env.IGDB_CLIENT_SECRET!;

let accessToken = '';
let tokenExpiresAt = 0;

async function getAccessToken() {
  if (Date.now() < tokenExpiresAt) return accessToken;

  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });

  const data = await res.json();
  accessToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return accessToken;
}

export async function searchGames(query: string, limit = 10) {
  if (!query || query.length < 2) return [];

  const supabase = await createClient();

  // 1. Check Supabase cache first
  const { data: cached } = await supabase
    .from('games')
    .select('id, name, cover_url, release_date')
    .ilike('name', `%${query}%`)
    .limit(limit)
    .order('name');

  if (cached && cached.length > 0) return cached;

  // 2. Fetch from IGDB
  const token = await getAccessToken();

  const res = await fetch('https://api.igdb.com/v4/games', {
    method: 'POST',
    headers: {
      'Client-ID': CLIENT_ID,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'text/plain',
    },
    body: `search "${query}"; fields name, cover.url, first_release_date; limit ${limit};`,
  });

  if (!res.ok) {
    console.error('IGDB fetch failed:', await res.text());
    return [];
  }

  const games = await res.json();
  if (!games?.length) return [];

  // 3. Shape and upsert into games table so FK is always satisfied
  const rows = games.map((g: any) => ({
    id: g.id,
    name: g.name,
    cover_url: g.cover?.url
      ? `https:${g.cover.url.replace('t_thumb', 't_cover_big')}`
      : null,
    release_date: g.first_release_date
      ? new Date(g.first_release_date * 1000).toISOString().split('T')[0]
      : null,
  }));

  const { error: upsertError } = await supabase
    .from('games')
    .upsert(rows, { onConflict: 'id' });

  if (upsertError) {
    // Code 42501 = RLS violation — means INSERT/UPDATE policy is missing on games table
    console.error(`Games upsert failed [${upsertError.code}]:`, upsertError.message);
  }

  return rows;
}

/**
 * Ensures a single game row exists in the games table.
 * Call this before inserting into game_logs to prevent FK violations.
 */
export async function ensureGameCached(game: {
  id: number;
  name: string;
  cover_url?: string | null;
  release_date?: string | null;
}) {
  const supabase = await createClient();

  const { error } = await supabase
    .from('games')
    .upsert(
      {
        id: game.id,
        name: game.name,
        cover_url: game.cover_url ?? null,
        release_date: game.release_date ?? null,
      },
      { onConflict: 'id' }
    );

  if (error) {
    // Code 42501 = RLS violation — run the games table policy SQL in Supabase SQL Editor
    const hint = error.code === '42501'
      ? ' (RLS policy missing — add INSERT/UPDATE policies on the games table)'
      : '';
    console.error(`ensureGameCached [${error.code}]:`, error.message);
    throw new Error(`Could not cache game "${game.name}": ${error.message}${hint}`);
  }
}
