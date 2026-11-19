export const BACKOFF_BASE_MS = 250;
export const BACKOFF_MAX_MS = 30_000;

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  random?: () => number;
}

export class Backoff {
  readonly #baseMs: number;
  readonly #maxMs: number;
  readonly #random: () => number;
  #attempt = 0;

  constructor(options: BackoffOptions = {}) {
    this.#baseMs = options.baseMs ?? BACKOFF_BASE_MS;
    this.#maxMs = options.maxMs ?? BACKOFF_MAX_MS;
    this.#random = options.random ?? Math.random;
  }

  get attempt(): number {
    return this.#attempt;
  }

  get ceilingForAttempt(): number {
    return Math.min(this.#maxMs, this.#baseMs * 2 ** this.#attempt);
  }

  next(): number {
    // Full jitter spreads reconnects after a shared outage.
    const delay = this.#random() * this.ceilingForAttempt;
    this.#attempt += 1;
    return delay;
  }

  reset(): void {
    this.#attempt = 0;
  }
}
