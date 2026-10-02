/**
 * Reconnect backoff (plan P5 task 1).
 *
 * 250 ms doubling to a 30 s ceiling with jitter. Three properties matter and each
 * is a specific failure:
 *
 * - **Ceiling.** A phone that wakes to a dead server must not hammer it for
 *   hours; 30 s is the plan's number and roughly one probe per 2 minutes.
 * - **Jitter.** Without it, every client disconnected by a serve restart
 *   reconnects on the same schedule and arrives together — a thundering herd
 *   against the process that just came back up. Full jitter is used: the delay
 *   is drawn from `[0, min(cap, base * 2^attempt))`, which also guarantees a
 *   reconnect can happen immediately rather than being forced to wait out a
 *   long backoff.
 * - **Reset on success.** The attempt counter clears on an open socket, so a
 *   later blip starts fast again rather than inheriting a stale long delay.
 */

export const BACKOFF_BASE_MS = 250;
export const BACKOFF_MAX_MS = 30_000;

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  /** Injected so jitter is deterministic in tests. */
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

  /** Number of consecutive failures since the last reset. */
  get attempt(): number {
    return this.#attempt;
  }

  /** Un-jittered delay for the current attempt — the schedule itself. */
  get ceilingForAttempt(): number {
    return Math.min(this.#maxMs, this.#baseMs * 2 ** this.#attempt);
  }

  /** Returns the delay to wait before the next attempt, and advances. */
  next(): number {
    const delay = this.#random() * this.ceilingForAttempt;
    this.#attempt += 1;
    return delay;
  }

  /** Called once a connection is established. */
  reset(): void {
    this.#attempt = 0;
  }
}
