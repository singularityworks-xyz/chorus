/**
 * Per-IP login brute-force guard (spec §6.6, plan P4.8).
 *
 * A sliding window, not a fixed bucket: a fixed bucket lets an attacker spend
 * its whole allowance at the end of one window and again at the start of the
 * next, which is twice the intended rate at the boundary.
 *
 * Scoped per IP so one operator's typo lockout does not take out a second
 * device on the same NAT — and, more importantly, so a distributed attempt
 * against one account is still rate-limited per source.
 */

/** Plan P4.8: ten attempts per ten minutes. */
export const MAX_LOGIN_ATTEMPTS = 10;

/** Plan P4.8: the window those attempts are counted in. */
export const LOGIN_WINDOW_MS = 600_000;

export interface LoginAttempt {
  at: number;
}

export interface BruteForceOptions {
  maxAttempts?: number;
  now?: () => number;
  windowMs?: number;
}

export type LoginDecision = "allow" | "rate-limited";

export class LoginRateLimiter {
  readonly #attempts = new Map<string, LoginAttempt[]>();
  readonly #maxAttempts: number;
  readonly #now: () => number;
  readonly #windowMs: number;

  constructor(options: BruteForceOptions = {}) {
    this.#maxAttempts = options.maxAttempts ?? MAX_LOGIN_ATTEMPTS;
    this.#now = options.now ?? Date.now;
    this.#windowMs = options.windowMs ?? LOGIN_WINDOW_MS;
  }

  /**
   * Records a failed login and reports whether this attempt is over budget.
   *
   * The limit is checked *after* recording, so the eleventh attempt is the one
   * refused rather than the twelfth.
   */
  recordFailure(key: string): LoginDecision {
    const now = this.#now();
    const windowStart = now - this.#windowMs;
    const recent = (this.#attempts.get(key) ?? []).filter(
      (attempt) => attempt.at > windowStart
    );

    recent.push({ at: now });
    this.#attempts.set(key, recent);

    return recent.length > this.#maxAttempts ? "rate-limited" : "allow";
  }

  /** Whether a further attempt would be refused, without recording one. */
  isBlocked(key: string): LoginDecision {
    const windowStart = this.#now() - this.#windowMs;
    const recent = (this.#attempts.get(key) ?? []).filter(
      (attempt) => attempt.at > windowStart
    );
    return recent.length >= this.#maxAttempts ? "rate-limited" : "allow";
  }

  /** Clears a key's history — called after a successful login. */
  reset(key: string): void {
    this.#attempts.delete(key);
  }

  /** Drops empty buckets so the map cannot grow with distinct source IPs. */
  prune(): void {
    const windowStart = this.#now() - this.#windowMs;
    for (const [key, attempts] of this.#attempts) {
      const recent = attempts.filter((attempt) => attempt.at > windowStart);
      if (recent.length === 0) {
        this.#attempts.delete(key);
      } else if (recent.length !== attempts.length) {
        this.#attempts.set(key, recent);
      }
    }
  }

  /** Entries currently tracked; for tests and the `/status` surface. */
  get size(): number {
    return this.#attempts.size;
  }
}
