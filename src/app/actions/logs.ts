'use server';

import { revalidatePath } from 'next/cache';
import { createClient, requireUser } from '@/lib/supabase';
import { getCapabilities } from '@/lib/capabilities';
import { enforce } from '@/lib/rate-limit';
import { callerKey } from '@/lib/limiter';
import { ensureGameCached } from '@/app/actions/igdb';
import {
  parseLocalDate,
  validateGamePayload,
  validateRating,
  validateReview,
  validateStatus,
  validateTags,
  validateUuid,
} from '@/lib/validation';

export type SaveLogInput = {
  game: unknown;
  status: unknown;
  rating: unknown;
  review?: unknown;
  diaryDate?: unknown;
  tags?: unknown;
  playtimeHours?: unknown;
  isFavorite?: unknown;
  hasSpoilers?: unknown;
};

export type SaveLogResult = {
  success: true;
  logId: string;
  /** True when an existing entry for this game was updated instead of created. */
  updated: boolean;
  gameId: number;
  gameName: string;
};

/**
 * Creates or updates a log for a game.
 *
 * Design change: one log per (user, game). Re-logging a game updates the
 * existing entry rather than inserting a duplicate, which previously let a
 * user create unbounded duplicate rows for the same title.
 */
export async function saveGameLog(input: SaveLogInput): Promise<SaveLogResult> {
  const user = await requireUser();
  await enforce(await callerKey('log:write'), 30, 60_000);

  const game = validateGamePayload(input.game);
  const status = validateStatus(input.status);
  const rating = validateRating(input.rating);
  const review = validateReview(input.review);
  const tags = validateTags(input.tags);
  const diaryDate = parseLocalDate(input.diaryDate);

  const caps = await getCapabilities();

  let playtimeHours: number | null = null;
  if (caps.logPlaytime && input.playtimeHours !== undefined && input.playtimeHours !== null && input.playtimeHours !== '') {
    const hours = Number(input.playtimeHours);
    if (Number.isFinite(hours) && hours > 0) {
      playtimeHours = Math.min(9999, Math.round(hours * 10) / 10);
    }
  }

  const isFavorite = caps.logFavorite ? Boolean(input.isFavorite) : false;
  const hasSpoilers = caps.logSpoiler ? Boolean(input.hasSpoilers) : false;

  // Cache the game row first so the foreign key is always satisfied.
  await ensureGameCached(game);

  const supabase = await createClient();

  const { data: existing } = await supabase
    .from('game_logs')
    .select('id')
    .eq('user_id', user.id)
    .eq('game_id', game.id)
    .maybeSingle();

  const base = {
    status,
    rating,
    review,
    tags,
    diary_date: diaryDate,
    ...(caps.logPlaytime ? { playtime_hours: playtimeHours } : {}),
    ...(caps.logFavorite ? { is_favorite: isFavorite } : {}),
    ...(caps.logSpoiler ? { has_spoilers: hasSpoilers } : {}),
  };

  if (existing) {
    const { error } = await supabase
      .from('game_logs')
      .update(base)
      .eq('id', existing.id);
    if (error) throw new Error(friendlyDbError(error.message));
    revalidateLogPaths(user.id, game.id);
    return {
      success: true,
      logId: existing.id,
      updated: true,
      gameId: game.id,
      gameName: game.name,
    };
  }

  const { data: created, error } = await supabase
    .from('game_logs')
    .insert({ ...base, user_id: user.id, game_id: game.id })
    .select('id')
    .single();

  if (error) {
    // Concurrent submit created the row first; fall back to update.
    if (error.code === '23505') {
      const { data: raced } = await supabase
        .from('game_logs')
        .select('id')
        .eq('user_id', user.id)
        .eq('game_id', game.id)
        .maybeSingle();
      if (raced) {
        await supabase.from('game_logs').update(base).eq('id', raced.id);
        revalidateLogPaths(user.id, game.id);
        return {
          success: true,
          logId: raced.id,
          updated: true,
          gameId: game.id,
          gameName: game.name,
        };
      }
    }
    throw new Error(friendlyDbError(error.message));
  }

  revalidateLogPaths(user.id, game.id);
  return {
    success: true,
    logId: created.id,
    updated: false,
    gameId: game.id,
    gameName: game.name,
  };
}

/** Updates an existing log. Ownership is enforced. */
export async function updateGameLog(
  logId: unknown,
  patch: {
    status?: unknown;
    rating?: unknown;
    review?: unknown;
    tags?: unknown;
    diaryDate?: unknown;
    playtimeHours?: unknown;
    isFavorite?: unknown;
    hasSpoilers?: unknown;
  }
): Promise<{ success: true }> {
  const user = await requireUser();
  await enforce(await callerKey('log:update'), 60, 60_000);

  const id = validateUuid(logId, 'log id');
  const caps = await getCapabilities();
  const supabase = await createClient();

  // Confirm ownership before mutating.
  const { data: existing } = await supabase
    .from('game_logs')
    .select('id, game_id')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!existing) throw new Error('That log does not exist or is not yours.');

  const update: Record<string, unknown> = {};
  if (patch.status !== undefined) update.status = validateStatus(patch.status);
  if (patch.rating !== undefined) update.rating = validateRating(patch.rating);
  if (patch.review !== undefined) update.review = validateReview(patch.review);
  if (patch.tags !== undefined) update.tags = validateTags(patch.tags);
  if (patch.diaryDate !== undefined) {
    update.diary_date = parseLocalDate(patch.diaryDate);
  }
  if (caps.logPlaytime && patch.playtimeHours !== undefined) {
    const hours = Number(patch.playtimeHours);
    update.playtime_hours = Number.isFinite(hours) && hours > 0 ? Math.min(9999, Math.round(hours * 10) / 10) : null;
  }
  if (caps.logFavorite && patch.isFavorite !== undefined) {
    update.is_favorite = Boolean(patch.isFavorite);
  }
  if (caps.logSpoiler && patch.hasSpoilers !== undefined) {
    update.has_spoilers = Boolean(patch.hasSpoilers);
  }

  if (Object.keys(update).length === 0) return { success: true };

  const { error } = await supabase.from('game_logs').update(update).eq('id', id);
  if (error) throw new Error(friendlyDbError(error.message));

  revalidateLogPaths(user.id, existing.game_id as number);
  return { success: true };
}

/** Deletes a log. Ownership is enforced. */
export async function deleteGameLog(logId: unknown): Promise<{ success: true }> {
  const user = await requireUser();
  await enforce(await callerKey('log:delete'), 30, 60_000);

  const id = validateUuid(logId, 'log id');
  const supabase = await createClient();

  const { data: existing } = await supabase
    .from('game_logs')
    .select('id, game_id')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!existing) throw new Error('That log does not exist or is not yours.');

  const { error } = await supabase.from('game_logs').delete().eq('id', id);
  if (error) throw new Error(friendlyDbError(error.message));

  revalidateLogPaths(user.id, existing.game_id as number);
  return { success: true };
}

/**
 * Invalidates every surface that displays this log.
 *
 * Previously only '/' and `/game/${id}` were revalidated, so the profile and
 * list pages kept serving stale data.
 */
function revalidateLogPaths(userId: string, gameId: number): void {
  revalidatePath('/', 'layout');
  revalidatePath(`/game/${gameId}`);
  revalidatePath('/profile');
  revalidatePath('/discover');
  revalidatePath(`/api/og/log`);
  void userId;
}

/** Translates raw Postgres/PostgREST messages into something a user can read. */
function friendlyDbError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('row-level security') || m.includes('42501')) {
    return 'Your account is not allowed to do that yet. Check the database RLS policies.';
  }
  if (m.includes('duplicate key') || m.includes('23505')) {
    return 'You have already logged that game.';
  }
  if (m.includes('foreign key') || m.includes('23503')) {
    return 'That game could not be saved. Please search for it again.';
  }
  if (m.includes('check constraint') || m.includes('23514')) {
    return 'Some of those values were rejected. Please check the rating, status and date.';
  }
  return message;
}
