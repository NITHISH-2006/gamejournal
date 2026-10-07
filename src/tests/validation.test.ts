import { describe, it, expect } from 'vitest';
import {
  validateUuid,
  validateGameId,
  validateRating,
  validateStatus,
  validateUsername,
  escapeLikePattern,
  LIMITS,
  ValidationError,
} from '@/lib/validation';

/**
 * The validation layer is where several of this project's worst bugs met the
 * database. These tests pin the behaviour that the rest of the app assumes.
 */
describe('validateUuid', () => {
  it('accepts a canonical uuid', () => {
    const id = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    expect(validateUuid(id)).toBe(id);
  });

  it('rejects anything that is not one', () => {
    // `select('id')` against a non-uuid makes PostgREST reject the whole request,
    // so a loose check here becomes a 400 rather than a 404.
    for (const bad of ['', 'abc', '123', null, undefined, 42, {}, 'not-a-uuid']) {
      expect(() => validateUuid(bad)).toThrow(ValidationError);
    }
  });

  it('rejects a uuid with trailing junk', () => {
    expect(() =>
      validateUuid('3f2504e0-4f89-11d3-9a0c-0305e82c3301 OR 1=1')
    ).toThrow(ValidationError);
  });

  it('names the field in the error', () => {
    expect(() => validateUuid('nope', 'comment id')).toThrow(/comment id/);
  });
});

describe('validateGameId', () => {
  it('accepts positive integers, including from strings', () => {
    expect(validateGameId(115289)).toBe(115289);
    expect(validateGameId('115289')).toBe(115289);
  });

  it('rejects non-integers, negatives, zero and non-finite values', () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity, 'abc', null, undefined, {}]) {
      expect(() => validateGameId(bad)).toThrow(ValidationError);
    }
  });
});

describe('validateRating', () => {
  it('rounds to the nearest whole number', () => {
    expect(validateRating(7.4)).toBe(7);
    expect(validateRating(7.6)).toBe(8);
  });

  it('accepts 1 through 10', () => {
    for (let i = 1; i <= 10; i++) expect(validateRating(i)).toBe(i);
  });

  /**
   * 0 means "logged but not rated".
   *
   * Migrations 002 and 003 set `rating NOT NULL DEFAULT 0` with a
   * `between 0 and 10` check precisely so that state could exist, and the RPCs
   * all filter on `rating > 0` because of it. The validator rejected 0 anyway,
   * which made the whole design unreachable: every log had to be rated.
   */
  it('accepts 0 as "logged but not rated"', () => {
    expect(validateRating(0)).toBe(0);
    expect(validateRating('0')).toBe(0);
  });

  it('treats an absent rating as unrated rather than as an error', () => {
    // `Number(null)` and `Number('')` are both 0, so these would have become a
    // rating of 0 by accident. Making it explicit keeps "not rated" a decision
    // rather than a side effect of JavaScript coercion.
    expect(validateRating(null)).toBe(0);
    expect(validateRating(undefined)).toBe(0);
    expect(validateRating('')).toBe(0);
  });

  it('rejects negatives, >10, and non-numbers', () => {
    for (const bad of [-1, 11, 99, NaN, Infinity, 'abc', 'eight', {}]) {
      expect(() => validateRating(bad)).toThrow(ValidationError);
    }
  });
});

describe('validateStatus', () => {
  it('accepts exactly the four enum values', () => {
    for (const s of ['backlog', 'playing', 'completed', 'abandoned']) {
      expect(validateStatus(s)).toBe(s);
    }
  });

  it('rejects anything else', () => {
    for (const bad of ['done', 'BACKLOG', '', null, undefined, 7]) {
      expect(() => validateStatus(bad)).toThrow(ValidationError);
    }
  });
});

describe('validateUsername', () => {
  /**
   * The permitted set is `[a-z0-9_]` only — no hyphen.
   *
   * This is deliberate and matches the database check
   * `username ~ '^[a-z0-9_]{3,20}$'` added by migration 003. If the two ever
   * disagree, `getProfileByUsername` lowercases and then does an exact `.eq()`,
   * so a row containing any other character becomes permanently unreachable and
   * 404s for everyone.
   */
  it('accepts lowercase letters, digits and underscores', () => {
    expect(validateUsername('alice_99')).toBe('alice_99');
    expect(validateUsername('seshan')).toBe('seshan');
    expect(validateUsername('gamer444')).toBe('gamer444');
  });

  it('rejects a hyphen, spaces and punctuation', () => {
    for (const bad of ['co-op', 'has space', 'emoji!', '@handle', 'a.b']) {
      expect(() => validateUsername(bad)).toThrow(ValidationError);
    }
  });

  /**
   * Case is normalised, not rejected.
   *
   * `handle_new_user` lowercases too. Rejecting `Alice` outright would leave the
   * database constraint and the validator disagreeing about the same input.
   */
  it('lowercases rather than rejecting uppercase', () => {
    expect(validateUsername('Alice')).toBe('alice');
    expect(validateUsername('DRSTONE24')).toBe('drstone24');
  });

  /**
   * A username is a permanent public identifier, so an over-long one has to be a
   * visible error.
   *
   * `validateUsername` used to call `clean()`, which ends in `.slice(0, max)`.
   * Truncating *before* the length check made the upper bound unreachable: a
   * 25-character handle became 20 characters and passed, so the user was given a
   * different username than the one they typed, with no error. A rename also
   * changed the public handle of an existing account silently.
   */
  it('REJECTS an over-long username instead of truncating it', () => {
    const tooLong = 'a'.repeat(LIMITS.usernameMax + 5);
    expect(() => validateUsername(tooLong)).toThrow(ValidationError);
  });

  it('rejects a too-short username', () => {
    expect(() => validateUsername('ab')).toThrow(ValidationError);
    expect(() => validateUsername('')).toThrow(ValidationError);
  });
});

describe('escapeLikePattern', () => {
  /**
   * `%` and `_` are LIKE wildcards. Unescaped, a search for `%` matched every
   * profile and a search for `_` matched every single-character username.
   */
  it('escapes the LIKE metacharacters', () => {
    expect(escapeLikePattern('100%')).toBe('100\\%');
    expect(escapeLikePattern('a_b')).toBe('a\\_b');
    expect(escapeLikePattern('back\\slash')).toBe('back\\\\slash');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeLikePattern('alice')).toBe('alice');
  });

  it('makes a wildcard-only query literal rather than match-all', () => {
    const escaped = escapeLikePattern('%');
    // One escaped literal percent, not a wildcard.
    expect(escaped).toBe('\\%');
    expect(escaped).not.toBe('%');
  });
});