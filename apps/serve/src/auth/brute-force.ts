export const MAX_LOGIN_ATTEMPTS = 10;

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

  isBlocked(key: string): LoginDecision {
    const windowStart = this.#now() - this.#windowMs;
    const recent = (this.#attempts.get(key) ?? []).filter(
      (attempt) => attempt.at > windowStart
    );
    return recent.length >= this.#maxAttempts ? "rate-limited" : "allow";
  }

  reset(key: string): void {
    this.#attempts.delete(key);
  }

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

  get size(): number {
    return this.#attempts.size;
  }
}
