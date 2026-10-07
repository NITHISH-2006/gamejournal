/**
 * Best-effort in-process rate limiter.
 *
 * Server Actions are publicly reachable endpoints, so write actions and
 * outbound-API-triggering reads (IGDB search) need a throttle. This uses a
 * module-level Map, which is correct for a single long-lived Node process and
 * is a useful safety net on serverless platforms that reuse warm instances.
 *
 * For horizontally-scaled production deployments swap `hit()` for a shared
 * store (Upstash Redis / Vercel KV) behind the same interface.
 */

type Entry = { count: number; resetAt: number };

const store = new Map<string, Entry>();

// Bound memory: sweep expired entries periodically and cap total keys.
const MAX_KEYS = 10_000;
const SWEEP_INTERVAL_MS = 60_000;
let lastSweep = 0;

function sweep(now: number) {
  // The two concerns are deliberately decoupled.
  //
  // An earlier version guarded with
  //     store.size < MAX_KEYS && now - lastSweep < SWEEP_INTERVAL_MS
  // on the theory that reordering the operands fixed it. It did not: `&&` is
  // commutative, so once the store reached MAX_KEYS the first clause was
  // permanently false, the early return never fired again, and *every*
  // subsequent `hit()` walked all 10,000 entries plus a hard-cap eviction. The
  // limiter then became a CPU amplifier precisely when it was needed most.
  //
  // Time alone decides when to sweep, so a saturated store costs one pass per
  // minute instead of one per request.
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;

  for (const [key, entry] of store) {
    if (entry.resetAt <= now) store.delete(key);
  }

  // Hard cap, in case of a flood of distinct keys inside one window. Runs at
  // most once per sweep interval.
  if (store.size > MAX_KEYS) {
    const excess = store.size - MAX_KEYS;
    let removed = 0;
    for (const key of store.keys()) {
      store.delete(key);
      if (++removed >= excess) break;
    }
  }
}

/**
 * Identifies the caller. Uses the forwarded IP, falling back to a global bucket.
 *
 * Security note, and the reason this is written the way it is: the *leftmost*
 * `X-Forwarded-For` entry is supplied by the client. Proxies append to the
 * header, they do not rewrite it, so `x-forwarded-for` read left-to-right is
 * fully attacker-controlled. Keying the limiter on it meant rotating the header
 * per request gave a fresh bucket every time, which defeated every limit in the
 * app — including the one standing between an anonymous visitor and the IGDB
 * quota.
 *
 * Order of preference, most trustworthy first:
 *  1. `x-vercel-forwarded-for` / `cf-connecting-ip` — the platform *overwrites*
 *     these, so they cannot be spoofed.
 *  2. The *rightmost* `X-Forwarded-For` entry — the one the nearest trusted
 *     proxy appended, rather than the one the client prepended.
 */
export function clientKey(headers?: Headers): string {
  if (headers) {
    // Overwritten by the edge platform, so not client-controlled.
    const platformIp =
      headers.get('x-vercel-forwarded-for') ?? headers.get('cf-connecting-ip');
    if (platformIp) return platformIp.split(',')[0].trim();

    // Rightmost, not leftmost. See the note above.
    const forwarded = headers.get('x-forwarded-for');
    if (forwarded) {
      const parts = forwarded.split(',').map((p) => p.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }

    const realIp = headers.get('x-real-ip');
    if (realIp) return realIp.trim();
  }
  return 'global';
}

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  resetAt: number;
};

/**
 * Registers a hit against `key` and reports whether it is within `limit`.
 * `windowMs` is a sliding window measured from the first hit in the window.
 */
export function hit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  sweep(now);

  const existing = store.get(key);
  if (!existing || existing.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1, resetAt: now + windowMs };
  }

  existing.count += 1;
  return {
    ok: existing.count <= limit,
    remaining: Math.max(0, limit - existing.count),
    resetAt: existing.resetAt,
  };
}

export function reset(key: string): void {
  store.delete(key);
}

/** Throws a ValidationError-style error when the limit is exceeded. */
export class RateLimitError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super(`Too many requests. Please wait ${retryAfterSeconds}s and try again.`);
    this.name = 'RateLimitError';
  }
}

export function enforce(key: string, limit: number, windowMs: number): void {
  const result = hit(key, limit, windowMs);
  if (!result.ok) {
    throw new RateLimitError(Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000)));
  }
}
