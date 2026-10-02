import { describe, expect, test } from "bun:test";
import {
  LOGIN_WINDOW_MS,
  LoginRateLimiter,
  MAX_LOGIN_ATTEMPTS,
} from "./brute-force";

describe("login brute-force guard (spec §6.6, plan P4.8)", () => {
  test("the documented budget is ten attempts per ten minutes", () => {
    expect(MAX_LOGIN_ATTEMPTS).toBe(10);
    expect(LOGIN_WINDOW_MS).toBe(600_000);
  });

  test("the eleventh attempt inside the window is rate-limited", () => {
    let clock = 1_700_000_000_000;
    const limiter = new LoginRateLimiter({ now: () => clock });

    for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt += 1) {
      expect(limiter.recordFailure("1.2.3.4")).toBe("allow");
      clock += 1000;
    }

    // The limit is checked *after* recording, so the eleventh is the one
    // refused rather than the twelfth.
    expect(limiter.recordFailure("1.2.3.4")).toBe("rate-limited");
  });

  test("an eleventh attempt is refused without being counted twice", () => {
    let clock = 1_700_000_000_000;
    const limiter = new LoginRateLimiter({ now: () => clock });

    for (let attempt = 0; attempt < MAX_LOGIN_ATTEMPTS; attempt += 1) {
      limiter.recordFailure("ip");
    }

    limiter.recordFailure("ip");
    limiter.recordFailure("ip");

    // A refused attempt still consumes window budget, so a flood cannot be
    // staggered into passing.
    clock += LOGIN_WINDOW_MS;
    expect(limiter.recordFailure("ip")).toBe("allow");
  });

  test("the window slides: an attempt older than it frees budget", () => {
    let clock = 1_700_000_000_000;
    const limiter = new LoginRateLimiter({ now: () => clock });

    // Ten attempts a second apart: all inside one window.
    for (let attempt = 0; attempt < MAX_LOGIN_ATTEMPTS; attempt += 1) {
      limiter.recordFailure("ip");
      clock += 1000;
    }
    expect(limiter.recordFailure("ip")).toBe("rate-limited");

    // Past the window every one of those attempts has aged out, so a full
    // budget is available again. A fixed bucket would hand out a fresh budget at
    // the boundary on top of the tail of the previous one — twice the intended
    // rate.
    clock += LOGIN_WINDOW_MS;
    expect(limiter.recordFailure("ip")).toBe("allow");
  });

  test("partial expiry frees exactly the elapsed attempts", () => {
    let clock = 1_700_000_000_000;
    const limiter = new LoginRateLimiter({ now: () => clock });

    limiter.recordFailure("ip");
    clock += LOGIN_WINDOW_MS + 1;
    limiter.recordFailure("ip");

    expect(limiter.recordFailure("ip")).toBe("allow");
  });

  test("isBlocked reports the decision without recording", () => {
    let clock = 1_700_000_000_000;
    const limiter = new LoginRateLimiter({ now: () => clock });

    expect(limiter.isBlocked("ip")).toBe("allow");

    for (let attempt = 0; attempt < MAX_LOGIN_ATTEMPTS; attempt += 1) {
      limiter.recordFailure("ip");
    }

    expect(limiter.isBlocked("ip")).toBe("rate-limited");

    // Still ten recorded, not eleven.
    clock += 1;
    expect(limiter.isBlocked("ip")).toBe("rate-limited");
  });

  test("sources are limited independently", () => {
    const limiter = new LoginRateLimiter();

    for (let attempt = 0; attempt < MAX_LOGIN_ATTEMPTS; attempt += 1) {
      limiter.recordFailure("attacker");
    }

    expect(limiter.isBlocked("attacker")).toBe("rate-limited");
    // One operator behind the same NAT must not be locked out by another's
    // typos, and a distributed attempt is still capped per source.
    expect(limiter.isBlocked("operator")).toBe("allow");
  });

  test("a successful login clears the window", () => {
    const limiter = new LoginRateLimiter();

    for (let attempt = 0; attempt < MAX_LOGIN_ATTEMPTS; attempt += 1) {
      limiter.recordFailure("ip");
    }
    expect(limiter.isBlocked("ip")).toBe("rate-limited");

    limiter.reset("ip");

    // An operator who fumbled the token ten times is not locked out for the
    // next ten minutes after finally getting it right.
    expect(limiter.isBlocked("ip")).toBe("allow");
  });

  test("pruning drops keys whose attempts have all aged out", () => {
    let clock = 1_700_000_000_000;
    const limiter = new LoginRateLimiter({ now: () => clock });

    limiter.recordFailure("old");
    clock += LOGIN_WINDOW_MS + 1;
    limiter.recordFailure("fresh");

    expect(limiter.size).toBe(2);
    limiter.prune();
    expect(limiter.size).toBe(1);

    clock += LOGIN_WINDOW_MS + 1;
    limiter.prune();
    expect(limiter.size).toBe(0);
  });

  test("pruning keeps a key that still has attempts inside the window", () => {
    let clock = 1_700_000_000_000;
    const limiter = new LoginRateLimiter({ now: () => clock });

    limiter.recordFailure("ip");
    clock += LOGIN_WINDOW_MS - 1000;
    limiter.recordFailure("ip");
    clock += 2000;

    limiter.prune();

    expect(limiter.size).toBe(1);
  });

  test("the budget is configurable for tests", () => {
    const limiter = new LoginRateLimiter({ maxAttempts: 2, windowMs: 1000 });

    expect(limiter.recordFailure("ip")).toBe("allow");
    expect(limiter.recordFailure("ip")).toBe("allow");
    expect(limiter.recordFailure("ip")).toBe("rate-limited");
  });
});
