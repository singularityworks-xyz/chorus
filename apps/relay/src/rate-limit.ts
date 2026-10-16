/** Bounded ingress buckets; trusted ingress must overwrite x-real-ip. */
export class RelayRateLimiter {
  readonly #buckets = new Map<string, { expires: number; used: number }>();
  readonly #now: () => number;

  constructor(now = Date.now) {
    this.#now = now;
  }

  allow(key: string, max = 60): boolean {
    const now = this.#now();
    const prior = this.#buckets.get(key);
    if (prior && prior.expires > now) {
      prior.used += 1;
      return prior.used <= max;
    }
    if (this.#buckets.size >= 10_000) {
      for (const [id, value] of this.#buckets) {
        if (value.expires <= now) {
          this.#buckets.delete(id);
        }
      }
      if (this.#buckets.size >= 10_000) {
        return false;
      }
    }
    this.#buckets.set(key, { expires: now + 60_000, used: 1 });
    return true;
  }
}
