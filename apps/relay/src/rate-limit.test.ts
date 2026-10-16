import { describe, expect, test } from "bun:test";
import { RelayRateLimiter } from "./rate-limit";

describe("relay ingress limits", () => {
  test("bounds both request frequency and identities without clearing active limits", () => {
    let now = 0;
    const limiter = new RelayRateLimiter(() => now);
    expect(limiter.allow("one", 1)).toBe(true);
    expect(limiter.allow("one", 1)).toBe(false);
    for (let index = 1; index < 10_000; index += 1) {
      expect(limiter.allow(`other-${index}`, 1)).toBe(true);
    }
    expect(limiter.allow("overflow", 1)).toBe(false);
    expect(limiter.allow("one", 1)).toBe(false);
    now += 60_001;
    expect(limiter.allow("overflow", 1)).toBe(true);
  });
});
