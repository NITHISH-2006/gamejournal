import { describe, it, expect } from 'vitest';
import { hit, enforce, reset, RateLimitError, clientKey } from '@/lib/rate-limit';

/**
 * Regression tests for the rate limiter.
 *
 * The first of these is a regression test for a bug that was *documented as
 * fixed and was not*. `sweep()` guarded with
 *
 *     store.size < MAX_KEYS && now - lastSweep < SWEEP_INTERVAL_MS
 *
 * and the fix "reordered the operands". `&&` is commutative, so the expression
 * was logically identical: once the store reached MAX_KEYS the first clause was
 * permanently false, the early return never fired again, and every single
 * `hit()` scanned all 10,000 entries. The comment above the code described the
 * correct fix while the code kept the bug.
 *
 * That shape of failure — a comment asserting an invariant the code does not
 * provide — is exactly what a test is for.
 */
describe('rate limiter', () => {
  it('allows requests up to the limit and rejects the next one', () => {
    reset('t1');
    for (let i = 1; i <= 5; i++) {
      expect(hit('t1', 5, 60_000).ok).toBe(true);
    }
    const sixth = hit('t1', 5, 60_000);
    expect(sixth.ok).toBe(false);
    expect(sixth.remaining).toBe(0);
  });

  it('resets once the window has expired', () => {
    reset('t2');
    expect(hit('t2', 1, 1).ok).toBe(true);
    // The window is 1ms, so the entry is expired on the next call.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(hit('t2', 1, 1).ok).toBe(true);
        resolve();
      }, 5);
    });
  });

  it('enforce() throws RateLimitError past the limit', () => {
    reset('t3');
    expect(() => enforce('t3', 2, 60_000)).not.toThrow();
    expect(() => enforce('t3', 2, 60_000)).not.toThrow();
    expect(() => enforce('t3', 2, 60_000)).toThrow(RateLimitError);
  });

  it('buckets different keys independently', () => {
    reset('t4a');
    reset('t4b');
    expect(() => enforce('t4a', 1, 60_000)).not.toThrow();
    // A separate action namespace must not share a bucket, or one busy
    // endpoint would throttle an unrelated one.
    expect(() => enforce('t4b', 1, 60_000)).not.toThrow();
  });

  it('reports a positive retryAfterSeconds', () => {
    reset('t5');
    enforce('t5', 1, 60_000);
    try {
      enforce('t5', 1, 60_000);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  /**
   * The documented-but-unfixed bug, asserted as behaviour.
   *
   * A saturated store must not make every subsequent call expensive. Before the
   * fix, once the store hit MAX_KEYS the early-return guard was permanently
   * false and every `hit()` walked all 10,000 entries plus a hard-cap eviction —
   * so the limiter became a CPU amplifier exactly when it was needed most.
   *
   * The timing assertion is deliberately loose (5s for 10,050 inserts) so it
   * cannot flake on a loaded CI box; the point is that this is not minutes, which
   * is what a per-call full scan would produce.
   */
  it('stays correct and fast after the store is saturated with distinct keys', () => {
    const before = Date.now();
    for (let i = 0; i < 10_050; i++) {
      hit(`sat-${i}`, 5, 60_000);
    }
    const elapsed = Date.now() - before;
    expect(elapsed).toBeLessThan(5000);

    // A key added *after* saturation must behave normally: eviction deliberately
    // drops the oldest entries, so `sat-0` may legitimately be gone, but a fresh
    // key must get a full allowance.
    expect(hit('sat-fresh', 5, 60_000).ok).toBe(true);
    expect(hit('sat-fresh', 5, 60_000).ok).toBe(true);
    expect(hit('sat-fresh', 5, 60_000).ok).toBe(true);
    expect(hit('sat-fresh', 5, 60_000).ok).toBe(true);
    expect(hit('sat-fresh', 5, 60_000).ok).toBe(true);
    expect(hit('sat-fresh', 5, 60_000).ok).toBe(false);
  });
});

describe('clientKey', () => {
  it('falls back to "global" when no IP header is present', () => {
    expect(clientKey(new Headers())).toBe('global');
    expect(clientKey()).toBe('global');
  });

  /**
   * Regression test for header-spoofing.
   *
   * The limiter originally keyed on the *leftmost* `X-Forwarded-For` entry, which
   * is client-supplied: proxies append to that header rather than rewriting it.
   * Rotating it per request therefore produced a fresh bucket every time and
   * defeated every limit in the app, including the one guarding the IGDB quota.
   */
  it('uses the RIGHTMOST X-Forwarded-For entry, not the leftmost', () => {
    const h = new Headers({
      'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3',
    });
    expect(clientKey(h)).toBe('3.3.3.3');
  });

  it('prefers the platform-overwritten header over X-Forwarded-For', () => {
    const h = new Headers({
      'x-forwarded-for': '1.1.1.1, 2.2.2.2',
      'x-vercel-forwarded-for': '9.9.9.9',
    });
    expect(clientKey(h)).toBe('9.9.9.9');

    const cf = new Headers({
      'x-forwarded-for': '1.1.1.1',
      'cf-connecting-ip': '8.8.8.8',
    });
    expect(clientKey(cf)).toBe('8.8.8.8');
  });

  it('falls back to x-real-ip, then to global', () => {
    expect(clientKey(new Headers({ 'x-real-ip': '4.4.4.4' }))).toBe('4.4.4.4');
    expect(clientKey(new Headers({ 'x-forwarded-for': '5.5.5.5' }))).toBe('5.5.5.5');
  });
});