/**
 * In-memory rate limiting and lockout.
 *
 * Deliberately not backed by the database: this is a single-process,
 * single-user deployment, and keeping counters in memory means a flood of
 * login attempts cannot itself become a write-amplification attack. The
 * trade-off is that counters reset on restart, which is why persistent lockout
 * (users.lockedUntil) backs this up for the account-level case.
 */

export interface RateLimitRule {
  /** Attempts permitted within the window. */
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Milliseconds until the caller may try again. Zero when allowed. */
  retryAfterMs: number;
}

interface Bucket {
  hits: number[];
  /** Set once a bucket trips, and extended on every further attempt. */
  penaltyUntil: number;
  /** How many times this bucket has tripped, driving the backoff curve. */
  strikes: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Backoff after repeated failures: 1s, 4s, 16s, ... capped at 15 minutes.
 * Squaring makes casual guessing pointless within a few attempts while keeping
 * a genuine typo cheap to recover from.
 */
function penaltyMs(strikes: number): number {
  return Math.min(1000 * 4 ** (strikes - 1), 15 * 60 * 1000);
}

export function checkRateLimit(
  key: string,
  rule: RateLimitRule,
  now = Date.now(),
): RateLimitResult {
  const bucket = buckets.get(key) ?? { hits: [], penaltyUntil: 0, strikes: 0 };

  if (bucket.penaltyUntil > now) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: bucket.penaltyUntil - now,
    };
  }

  bucket.hits = bucket.hits.filter((at) => at > now - rule.windowMs);

  if (bucket.hits.length >= rule.limit) {
    bucket.strikes += 1;
    bucket.penaltyUntil = now + penaltyMs(bucket.strikes);
    buckets.set(key, bucket);
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: bucket.penaltyUntil - now,
    };
  }

  bucket.hits.push(now);
  buckets.set(key, bucket);
  return {
    allowed: true,
    remaining: rule.limit - bucket.hits.length,
    retryAfterMs: 0,
  };
}

/** Called after a success, so a correct login clears the slate. */
export function resetRateLimit(key: string): void {
  buckets.delete(key);
}

/** Drops expired buckets so a long uptime cannot grow the map without bound. */
export function sweepRateLimits(now = Date.now(), maxWindowMs = 60 * 60 * 1000): void {
  for (const [key, bucket] of buckets) {
    const lastHit = bucket.hits.at(-1) ?? 0;
    if (bucket.penaltyUntil < now && lastHit < now - maxWindowMs) {
      buckets.delete(key);
    }
  }
}

/** Test-only helper; never called from application code. */
export function __resetAllRateLimits(): void {
  buckets.clear();
}

/**
 * Both dimensions are checked on every attempt. The per-account rule stops
 * someone rotating through proxies against one password; the per-IP rule stops
 * one host spraying many accounts.
 */
export const LOGIN_RULES = {
  perAccount: { limit: 5, windowMs: 15 * 60 * 1000 },
  perIp: { limit: 20, windowMs: 15 * 60 * 1000 },
} satisfies Record<string, RateLimitRule>;

/**
 * Tighter than the password rule: the search space is only a million codes, so
 * an attacker who already has the password must not get many guesses.
 */
export const TOTP_RULES = {
  perAccount: { limit: 5, windowMs: 5 * 60 * 1000 },
} satisfies Record<string, RateLimitRule>;
