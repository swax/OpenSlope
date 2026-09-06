import { createLogger } from '../log';

/**
 * How many times a credential may be got wrong, and the log line each failure leaves.
 *
 * Login and redemption are the two endpoints where a guess is worth anything, and they are also the two an
 * unauthenticated caller can reach — so they are counted, and every failure is logged (docs/038). Counting
 * failures rather than attempts is what keeps a member who signs in fifty times a day from ever meeting the
 * limit, while a caller working through a word list meets it in seconds.
 *
 * Held in memory: a restart forgives, which is the right trade for a table that must not become another
 * read-modify-write on the account record for every wrong password.
 */

const log = createLogger('accounts');

export interface RateLimit {
  /** Failures allowed inside the window before the bucket refuses. */
  max: number;
  windowMs: number;
}

/** Eight wrong passwords in a quarter of an hour, per address and per username. Two buckets rather than one,
 *  because one address guessing many usernames and many addresses guessing one are different attacks and
 *  either alone would leave the other uncounted. */
export const LOGIN_LIMIT: RateLimit = { max: 8, windowMs: 15 * 60_000 };

/** Redemption is a token in a link, not a password, so a wrong one is nearly always a mistyped or already
 *  spent link rather than a guess — but it creates accounts, so it is counted the same way. */
export const REDEEM_LIMIT: RateLimit = { max: 8, windowMs: 15 * 60_000 };

interface Bucket { failures: number; resetAt: number }

const buckets = new Map<string, Bucket>();

/** How long this bucket stays refused, in milliseconds; 0 when it is not. */
export function throttledFor(bucket: string, limit: RateLimit): number {
  const held = buckets.get(bucket);
  if (!held) return 0;
  const now = Date.now();
  if (held.resetAt <= now) { buckets.delete(bucket); return 0; }
  return held.failures >= limit.max ? held.resetAt - now : 0;
}

/**
 * Count one failure and say so in the log.
 *
 * The message names what failed and where from, and never what was tried — a log full of attempted passwords
 * is a second copy of the thing the hashing exists to avoid holding.
 */
export function recordFailure(bucket: string, limit: RateLimit, what: string): void {
  const now = Date.now();
  const held = buckets.get(bucket);
  const next = held && held.resetAt > now ? held : { failures: 0, resetAt: now + limit.windowMs };
  next.failures++;
  buckets.set(bucket, next);
  const blocked = next.failures >= limit.max;
  log.warn(`${what} — ${next.failures} failure${next.failures === 1 ? '' : 's'} in this window`
    + (blocked ? `, refusing further attempts for ${Math.ceil((next.resetAt - now) / 1000)}s` : ''));
}

/** A success clears the count, so an author who mistypes twice and then gets it right starts clean. */
export function clearFailures(bucket: string): void { buckets.delete(bucket); }

/** Drop every count — for a test that has just finished exercising a limit. */
export function forgetRateLimits(): void { buckets.clear(); }
