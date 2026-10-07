/**
 * Session field validation, shared by the form and the server action.
 *
 * The client previously carried its own copy of the date check which omitted the
 * future-date rule, so a user picking tomorrow passed client validation,
 * round-tripped to the server, and got an error banner instead of being stopped
 * before the write. Keeping one implementation means the browser and the server
 * agree by construction.
 *
 * These return `null` when valid and a message when not, so they read naturally
 * at a call site that wants to set state.
 */

/** A single sitting is capped at 24 hours — matches the database constraint. */
export const MAX_SESSION_HOURS = 24;
/**
 * A quarter-hour floor rather than zero. A zero-length session is not a session,
 * and the column's `check (hours > 0)` would reject it.
 */
export const MIN_SESSION_HOURS = 0.25;

export function isValidSessionHours(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || String(value).trim() === '') {
    return 'Enter how long you played for.';
  }

  const hours = typeof value === 'number' ? value : Number(value);

  if (!Number.isFinite(hours)) {
    return 'Enter how long you played for.';
  }

  if (hours < MIN_SESSION_HOURS || hours > MAX_SESSION_HOURS) {
    return `Session length must be between ${MIN_SESSION_HOURS} and ${MAX_SESSION_HOURS} hours.`;
  }

  return null;
}

/**
 * Accepts `YYYY-MM-DD`, and an empty value (meaning "today").
 *
 * A well-shaped but impossible date is rejected rather than rolled over —
 * `new Date('2024-02-31')` silently becomes 2 March.
 */
export function isValidSessionDate(
  value: string | null | undefined,
  now: string = new Date().toISOString()
): string | null {
  if (value === null || value === undefined || String(value).trim() === '') {
    return null; // empty is valid: the server fills in today
  }

  const raw = String(value).trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return 'That date is not valid.';
  }

  const parsed = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    return 'That date is not valid.';
  }

  // A future session is a typo, not a prediction. Compared as strings, which is
  // safe because both sides are zero-padded ISO dates.
  //
  // `now` is injectable because a check that reads the wall clock cannot be
  // tested: a future-date assertion written today starts failing tomorrow, and
  // there is no way to exercise the branch without waiting.
  const today = now.slice(0, 10);
  if (raw > today) {
    return 'You cannot log a session in the future.';
  }

  return null;
}

/**
 * Validates a whole draft, returning the first problem or `null`.
 *
 * Hours before date: an empty date is legal and the server fills in today, so
 * reporting a missing date first would be a false positive on the most common
 * legitimate submission.
 */
export function validateSessionDraft(
  draft: { hours?: string | number | null; playedOn?: string | null },
  now: string = new Date().toISOString()
): string | null {
  const draftDateError = isValidSessionDate(draft.playedOn, now);
  if (draftDateError) return draftDateError;

  return isValidSessionHours(draft.hours);
}