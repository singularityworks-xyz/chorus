import { describe, expect, test } from "bun:test";
import { BACKOFF_BASE_MS, BACKOFF_MAX_MS, Backoff } from "./backoff";

describe("Backoff", () => {
  test("the schedule starts at 250 ms and caps at 30 s", () => {
    expect(BACKOFF_BASE_MS).toBe(250);
    expect(BACKOFF_MAX_MS).toBe(30_000);

    const backoff = new Backoff({ random: () => 1 });
    const schedule: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      schedule.push(Math.round(backoff.next()));
    }

    expect(schedule.slice(0, 6)).toEqual([250, 500, 1000, 2000, 4000, 8000]);
    expect(Math.max(...schedule)).toBe(BACKOFF_MAX_MS);
    expect(schedule.at(-1)).toBe(BACKOFF_MAX_MS);
  });

  test("the ceiling doubles until it saturates", () => {
    const backoff = new Backoff();

    expect(backoff.ceilingForAttempt).toBe(250);
    backoff.next();
    expect(backoff.ceilingForAttempt).toBe(500);
    backoff.next();
    expect(backoff.ceilingForAttempt).toBe(1000);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      backoff.next();
    }
    expect(backoff.ceilingForAttempt).toBe(BACKOFF_MAX_MS);
  });

  test("jitter stays within [0, ceiling)", () => {
    const low = new Backoff({ random: () => 0 });
    const high = new Backoff({ random: () => 0.999_999 });

    expect(low.next()).toBe(0);
    expect(high.next()).toBeLessThan(high.ceilingForAttempt + 1);
  });

  test("jitter is full-jitter, so a reconnect can be immediate", () => {
    const backoff = new Backoff({ random: () => 0 });

    for (let attempt = 0; attempt < 8; attempt += 1) {
      expect(backoff.next()).toBe(0);
    }
  });

  test("reset returns to the first attempt", () => {
    const backoff = new Backoff({ random: () => 1 });

    for (let attempt = 0; attempt < 6; attempt += 1) {
      backoff.next();
    }
    expect(backoff.attempt).toBe(6);

    backoff.reset();

    expect(backoff.attempt).toBe(0);
    expect(backoff.next()).toBe(250);
  });

  test("base and cap are configurable", () => {
    const backoff = new Backoff({
      baseMs: 10,
      maxMs: 40,
      random: () => 1,
    });

    const delays = [
      backoff.next(),
      backoff.next(),
      backoff.next(),
      backoff.next(),
    ];

    expect(delays).toEqual([10, 20, 40, 40]);
  });
});
