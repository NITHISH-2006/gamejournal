import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Cross-checks the SQL migrations against the generated types.
 *
 * These two artefacts are maintained by hand and drift silently. The mismatch
 * that matters most is a Postgres function present in the migrations but absent
 * from `database.types.ts`: PostgREST would then reject the call with PGRST202
 * at runtime, while TypeScript — now that the clients are typed — would report
 * the same call as valid. The result is a function that builds, type-checks and
 * then fails on every page that uses it.
 *
 * That is not hypothetical: `get_game_stats`, `get_log_likes`,
 * `get_top_rated_games`, `search_logs`, `get_trending_games`,
 * `get_user_activity_stats`, `get_user_log_history` and `get_year_in_review`
 * were all missing from the live database while the application called them.
 *
 * The reverse direction is also checked: a type declared for a function no
 * migration creates would send a developer looking for SQL that does not exist.
 */

const MIGRATIONS_DIR = 'supabase/migrations';
const TYPES_FILE = 'src/lib/database.types.ts';

/**
 * `Database` is a type-only export, so it has no runtime representation and
 * cannot be introspected with `Object.keys`. The declarations are therefore read
 * out of the source file. That is also the better check: it asserts what is
 * actually written down, not what a compiler inferred.
 */
function readTypes(): string {
  return readFileSync(TYPES_FILE, 'utf8');
}

/**
 * Extracts the keys of a nested block, e.g. `Functions:` inside `public:`.
 *
 * Tracks brace depth from the opening `{` so a key declared at the wrong nesting
 * level is not picked up.
 */
function blockKeys(src: string, blockName: string): string[] {
  const start = src.indexOf(blockName);
  if (start === -1) return [];

  const open = src.indexOf('{', start);
  if (open === -1) return [];

  let depth = 0;
  const keys: string[] = [];
  let lineStart = open + 1;
  // Depth at the first character of the current line. A declaration line ends
  // with `{`, which raises the depth before its newline is reached, so the
  // depth must be sampled at the *start* of the line rather than at its end.
  let lineDepth = 1;

  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') {
      depth++;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth === 0) break;
      continue;
    }
    if (ch === '\n') {
      if (lineDepth === 1) {
        const line = src.slice(lineStart, i).trim();
        const m = line.match(/^([a-z_][a-z_0-9]*)\??\s*:/i);
        if (m) keys.push(m[1]);
      }
      lineStart = i + 1;
      lineDepth = depth;
    }
  }

  return keys;
}

function readMigrations(): { file: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ file: f, sql: readFileSync(join(MIGRATIONS_DIR, f), 'utf8') }));
}

/**
 * Functions that exist in SQL but are not RPCs.
 *
 * `handle_new_user`, `set_updated_at` and `touch_updated_at` are all trigger
 * bodies: they are invoked by `create trigger`, never by `.rpc()`, so they have
 * no entry in the `Functions` type and are not expected to.
 *
 * `touch_updated_at` is the 001 name for what 002 renamed to `set_updated_at`.
 * It is orphaned — the audit noted this — and migration 003 drops it.
 */
const NON_RPC_FUNCTIONS = new Set([
  'handle_new_user',
  'set_updated_at',
  'touch_updated_at',
]);

describe('migrations vs database.types.ts', () => {
  const migrations = readMigrations();
  const combined = migrations.map((m) => m.sql).join('\n');

  const sqlFunctions = new Set<string>();
  for (const match of combined.matchAll(
    /create\s+or\s+replace\s+function\s+(?:public\.)?"?([a-z_0-9]+)"?/gi
  )) {
    const name = match[1].toLowerCase();
    if (!NON_RPC_FUNCTIONS.has(name)) sqlFunctions.add(name);
  }

  const typedFunctions = new Set(
    blockKeys(readTypes(), 'Functions:').map((k) => k.toLowerCase())
  );

  it('finds the migrations at all', () => {
    expect(migrations.length).toBeGreaterThanOrEqual(3);
    expect(migrations.map((m) => m.file)).toContain('003_verify_and_harden.sql');
  });

  it('every function created by a migration is declared in database.types.ts', () => {
    const missing = [...sqlFunctions].filter((f) => !typedFunctions.has(f)).sort();
    expect(
      missing,
      `these functions exist in SQL but not in Database['public']['Functions']. ` +
        `PostgREST will accept them while TypeScript reports every call as an error ` +
        `(or, worse, if the call site casts, the mismatch is invisible): ${missing.join(', ')}`
    ).toEqual([]);
  });

  it('every declared function is created by some migration', () => {
    const phantom = [...typedFunctions].filter((f) => !sqlFunctions.has(f)).sort();
    expect(
      phantom,
      `these are declared in database.types.ts but no migration creates them, ` +
        `so every call will fail with PGRST202: ${phantom.join(', ')}`
    ).toEqual([]);
  });

  it('declares the functions the application actually calls', () => {
    // Called from the action layer. Kept explicit so removing one is a decision
    // rather than an accident.
    const required = [
      'get_log_likes',
      'get_game_stats',
      'get_top_rated_games',
      'get_trending_games',
      'get_user_activity_stats',
      'get_user_log_history',
      'get_year_in_review',
      'search_logs',
      'upsert_game',
      'get_suggested_users',
    ];
    const absent = required.filter((f) => !typedFunctions.has(f));
    expect(absent, `missing from the type: ${absent.join(', ')}`).toEqual([]);
  });

  it('declares every table the application queries', () => {
    const required = [
      'profiles',
      'games',
      'game_logs',
      'follows',
      'log_likes',
      'lists',
      'list_games',
      'notifications',
      'comments',
    ];
    const tables = new Set(blockKeys(readTypes(), 'Tables:'));
    const absent = required.filter((t) => !tables.has(t));
    expect(absent, `missing from the type: ${absent.join(', ')}`).toEqual([]);
  });

  it('declares the surrogate id on follows and log_likes', () => {
    // Without this the unfollow bug is one edit away from returning. Both tables
    // were keyed by their composite pair with no `id` column, which is what made
    // unfollow impossible and every follower count read 0.
    const src = readTypes();
    for (const table of ['follows', 'log_likes']) {
      const at = src.indexOf(`${table}: {`);
      expect(at, `${table} is declared`).toBeGreaterThan(-1);
      const block = src.slice(at, src.indexOf('Relationships:', at));
      expect(block, `${table}.id`).toMatch(/^\s*id:\s*string/m);
    }
  });

  it('declares has_spoilers on game_logs as a required boolean', () => {
    const src = readTypes();
    const at = src.indexOf('game_logs: {');
    const rowBlock = src.slice(at, src.indexOf('Insert:', at));
    expect(rowBlock).toMatch(/^\s*has_spoilers:\s*boolean;/m);

    // Non-optional, because 002 sets NOT NULL DEFAULT false. When this was
    // `has_spoilers?: boolean`, omitting it from a projection type-checked and
    // every spoiler-flagged review rendered in the open — which is exactly what
    // happened on /profile and /user/[username].
    expect(rowBlock).not.toMatch(/has_spoilers\?/);
  });

  it('keeps every migration idempotent-safe by preferring if-not-exists forms', () => {
    // A bare `create table`/`add column` without a guard is fine on a fresh
    // database and fails on every re-run, which is how the drift in this project
    // became invisible in the first place.
    const unguarded = migrations.flatMap(({ file, sql }) =>
      sql
        .split('\n')
        .map((line, i) => ({ file, n: i + 1, line: line.trim() }))
        .filter(
          ({ line }) =>
            /^alter\s+table\s+[\w.]+\s+add\s+column\s/i.test(line) &&
            !/if\s+not\s+exists/i.test(line)
        )
        .map(({ file, n, line }) => `${file}:${n} -> ${line}`)
    );

    expect(
      unguarded,
      `unguarded "add column" statements will abort the migration if re-run:\n${unguarded.join('\n')}`
    ).toEqual([]);
  });
});