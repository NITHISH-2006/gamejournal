import { isLogStatus, type Game, type LogStatus } from '@/lib/types';
import { safeCoverUrl } from '@/lib/images';

/** A validation failure that is safe to show directly to the user. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export const LIMITS = {
  usernameMin: 3,
  usernameMax: 20,
  displayNameMax: 50,
  bioMax: 280,
  reviewMax: 2000,
  commentMax: 1000,
  listNameMax: 60,
  listDescriptionMax: 280,
  tagMaxLength: 24,
  tagMaxCount: 10,
  searchMin: 2,
  searchMax: 80,
} as const;

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const TAG_RE = /^[a-z0-9][a-z0-9-_]*$/;

/** Collapses whitespace and trims; returns '' for nullish input. */
export function clean(value: unknown, max = 2000): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Preserves newlines (for reviews and comments) but strips control characters. */
export function cleanMultiline(value: unknown, max: number = LIMITS.reviewMax): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max);
}

export function validateUsername(value: unknown): string {
  // Normalise whitespace/case only — deliberately NOT `clean(value, max)`,
  // because `clean` ends in `.slice(0, max)`. Truncating first made the length
  // check below unreachable for the upper bound: a 25-character handle became
  // 20 characters and passed, so the user was silently given a different
  // username than the one they typed, with no error and no confirmation. A
  // username is a permanent public identifier; an over-long one has to be an
  // error the user can see and correct.
  const username = clean(value, 200).toLowerCase();
  if (!username) throw new ValidationError('Username is required.');
  if (username.length < LIMITS.usernameMin || username.length > LIMITS.usernameMax) {
    throw new ValidationError(
      `Username must be ${LIMITS.usernameMin} to ${LIMITS.usernameMax} characters.`
    );
  }
  if (!USERNAME_RE.test(username)) {
    throw new ValidationError(
      'Username can only contain lowercase letters, numbers and underscores.'
    );
  }
  return username;
}

export function validateDisplayName(value: unknown): string | null {
  const name = clean(value, LIMITS.displayNameMax);
  return name.length ? name : null;
}

export function validateBio(value: unknown): string | null {
  const bio = clean(value, LIMITS.bioMax);
  return bio.length ? bio : null;
}

export function validateRating(value: unknown): number {
  const rating = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(rating)) {
    throw new ValidationError('Pick a rating from 1 to 10.');
  }
  const rounded = Math.round(rating);
  if (rounded < 1 || rounded > 10) {
    throw new ValidationError('Rating must be between 1 and 10.');
  }
  return rounded;
}

export function validateStatus(value: unknown): LogStatus {
  if (!isLogStatus(value)) {
    throw new ValidationError(
      'Status must be one of: backlog, playing, completed, abandoned.'
    );
  }
  return value;
}

export function validateReview(value: unknown): string | null {
  const review = cleanMultiline(value, LIMITS.reviewMax);
  return review.length ? review : null;
}

export function validateComment(value: unknown): string {
  const body = cleanMultiline(value, LIMITS.commentMax);
  if (!body) throw new ValidationError('Write something first.');
  if (body.length < 2) throw new ValidationError('Comment is too short.');
  return body;
}

/** Normalises a free-form tag list: lowercased, de-duplicated, length-capped. */
export function validateTags(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;

  const raw = Array.isArray(value)
    ? value
    : String(value)
        .split(',')
        .map((t) => t.trim());

  const seen = new Set<string>();
  const out: string[] = [];

  for (const item of raw) {
    if (out.length >= LIMITS.tagMaxCount) break;
    const tag = String(item).trim().toLowerCase().slice(0, LIMITS.tagMaxLength);
    if (!tag) continue;
    if (!TAG_RE.test(tag)) continue; // silently drop malformed tags
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }

  return out.length ? out : null;
}

export function validateListName(value: unknown): string {
  const name = clean(value, LIMITS.listNameMax);
  if (!name) throw new ValidationError('Give your list a name.');
  return name;
}

export function validateListDescription(value: unknown): string | null {
  const description = clean(value, LIMITS.listDescriptionMax);
  return description.length ? description : null;
}

/** Validates a free-text search query used against both Supabase and IGDB. */
export function validateSearchQuery(value: unknown): string {
  const query = clean(value, LIMITS.searchMax);
  if (query.length < LIMITS.searchMin) {
    throw new ValidationError(
      `Type at least ${LIMITS.searchMin} characters to search.`
    );
  }
  return query;
}

/**
 * Escapes LIKE/ILIKE wildcards so user input cannot broaden the match.
 * PostgREST sends the value as a pattern; without escaping, `%` or `_`
 * would let a searcher enumerate every row.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/([\\%_])/g, '\\$1');
}

/** Validates a route param that must be a positive integer (IGDB game id). */
export function validateGameId(value: unknown): number {
  const id = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ValidationError('Invalid game id.');
  }
  return id;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Validates a UUID (list id, log id, user id). */
export function validateUuid(value: unknown, label = 'id'): string {
  const str = String(value ?? '');
  if (!UUID_RE.test(str)) {
    throw new ValidationError(`Invalid ${label}.`);
  }
  return str;
}

/** Validates a game payload coming from the client before we trust its FK id. */
export function validateGamePayload(value: unknown): Game {
  if (!value || typeof value !== 'object') {
    throw new ValidationError('Invalid game.');
  }
  const raw = value as Record<string, unknown>;
  const id = validateGameId(raw.id);
  const name = clean(raw.name, 200);
  if (!name) throw new ValidationError('Game name is required.');

  // Host allow-list, not just a protocol check. `next/image` throws on an
  // unlisted host at render time, so an arbitrary cover URL here is a
  // site-wide 500 for that game. See src/lib/images.ts.
  const coverUrl = safeCoverUrl(raw.cover_url);

  const releaseDate =
    typeof raw.release_date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(raw.release_date)
      ? raw.release_date
      : null;

  // Carried through rather than dropped. `Game.summary` is optional, so
  // omitting it here type-checked cleanly while silently costing every game
  // cached through `ensureGameCached` — a deep link to /game/<id>, or logging
  // a game by id — its description. The search path (`toRow` in
  // app/actions/igdb.ts) always sent a summary, so the same game got one only
  // if the user happened to find it via search first.
  const summary =
    typeof raw.summary === 'string' ? clean(raw.summary, 2000) || null : null;

  return { id, name, cover_url: coverUrl, release_date: releaseDate, summary };
}

/**
 * Local calendar date as YYYY-MM-DD.
 *
 * `toISOString()` returns UTC, so a user in UTC+5:30 logging a game at 2am
 * local was previously given the previous day. This uses the local calendar.
 */
export function localDateString(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Parses YYYY-MM-DD safely, returning null for junk. */
export function parseLocalDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  if (
    date.getFullYear() !== y ||
    date.getMonth() !== m - 1 ||
    date.getDate() !== d
  ) {
    return null; // e.g. 2025-02-31
  }
  return value;
}
