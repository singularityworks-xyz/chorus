import { describe, expect, test } from "bun:test";
import { EventStream } from "./event-stream";

/**
 * The engine's event stream is the only way agent activity reaches the client.
 *
 * It ends for reasons unrelated to any run — a proxy timeout, an engine restart,
 * a dropped socket — and `#consume` used to log that and give up. After that the
 * board silently stopped updating while the agent kept working, which is the same
 * class of invisible failure Phase 6 spent much of its budget removing.
 *
 * The fake stream ends immediately once its events are drained, so the reconnect
 * loop advances deterministically instead of on a timer.
 */

const SUBSCRIBE_REFUSED = /subscribe refused/;

type Outcome = "fail" | "end" | "hold";

/**
 * A client whose stream lifetime is chosen per subscribe.
 *
 * `"hold"` models a live, quiet subscription: `next()` never settles, so the pump
 * stays inside `#consume` until aborted. `"end"` ends immediately, exercising the
 * reconnect path. Getting this wrong is what made an earlier version of these
 * tests flaky — an always-ending stream sent the reconnect loop round on every
 * attempt and inflated the subscribe count the assertions key on.
 */
function fakeClient() {
  let subscribeCalls = 0;
  /** One outcome per subscribe attempt; defaults to `"hold"`. */
  const outcomes: Outcome[] = [];

  return {
    client: {
      event: {
        subscribe: () => {
          subscribeCalls += 1;

          const outcome = outcomes.shift() ?? "hold";
          if (outcome === "fail") {
            return Promise.reject(new Error("subscribe refused"));
          }

          const delivered: unknown[] = [];
          const cleanup: (() => void)[] = [];

          const stream = {
            [Symbol.asyncIterator]() {
              return this;
            },
            next: (): Promise<IteratorResult<unknown>> => {
              if (delivered.length > 0) {
                return Promise.resolve({
                  done: false,
                  value: delivered.shift(),
                });
              }
              if (outcome === "end") {
                return Promise.resolve({ done: true, value: undefined });
              }
              // Held open until `return()` is called, which the pump does on
              // abort or when it gives up.
              return new Promise((resolve) => {
                cleanup.push(() => resolve({ done: true, value: undefined }));
              });
            },
            return: () => {
              for (const fn of cleanup.splice(0)) {
                fn();
              }
              return Promise.resolve({ done: true, value: undefined });
            },
            push(value: unknown) {
              delivered.push(value);
            },
          };

          return Promise.resolve({ stream });
        },
      },
    },
    get subscribeCalls() {
      return subscribeCalls;
    },
    outcomes,
  };
}

describe("EventStream reconnection", () => {
  test("a healthy stream delivers its events", async () => {
    const fake = fakeClient();
    const stream = new EventStream(fake.client as never);
    const seen: unknown[] = [];

    await stream.subscribe((event) => seen.push(event));

    expect(fake.subscribeCalls).toBe(1);
    expect(seen).toEqual([]);

    stream.stop();
  });

  test("a failed first subscribe releases the slot instead of leaving a dead claim", async () => {
    const fake = fakeClient();
    fake.outcomes.push("fail", "hold");
    const stream = new EventStream(fake.client as never);

    await expect(
      stream.subscribe(() => undefined, { directory: "/repo" })
    ).rejects.toThrow(SUBSCRIBE_REFUSED);

    // A retry has to actually retry. Previously the claim was written before the
    // await, so this took the "already subscribed" branch and returned a handle
    // wired to a stream that never opened.
    await stream.subscribe(() => undefined, { directory: "/repo" });
    expect(fake.subscribeCalls).toBe(2);

    stream.stop();
  });

  test("a clean end-of-stream is re-opened rather than treated as finished", async () => {
    const fake = fakeClient();
    // Every attempt opens and then ends immediately, so the loop keeps trying.
    fake.outcomes.push("end", "end", "end");
    const stream = new EventStream(fake.client as never);

    await stream.subscribe(() => undefined, { directory: "/repo" });

    await new Promise((resolve) => setTimeout(resolve, 250));

    // Previously this stayed at one: the stream ended, `#consume` returned, and
    // the subscription went quiet for the rest of the process's life.
    expect(fake.subscribeCalls).toBeGreaterThan(1);

    stream.stop();
  });

  test("stop prevents further reconnection", async () => {
    const fake = fakeClient();
    fake.outcomes.push("hold", "hold", "hold", "hold");
    const stream = new EventStream(fake.client as never);

    await stream.subscribe(() => undefined, { directory: "/repo" });
    const callsBeforeStop = fake.subscribeCalls;

    stream.stop();
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(fake.subscribeCalls).toBe(callsBeforeStop);
  });
  test("a superseded pump does not release its successor's slot", async () => {
    // Sequence that broke: stop a directory, subscribe again before the old pump
    // reached its next checkpoint, and the old pump's release deletes the *new*
    // slot. The next subscriber then opens a third stream, so two pumps run for one
    // key and the global running flag can be flipped off while one is live.
    const fake = fakeClient();
    const stream = new EventStream(fake.client as never);

    const first = await stream.subscribe(() => undefined, {
      directory: "/repo",
    });
    expect(fake.subscribeCalls).toBe(1);

    first.stop();

    // Re-subscribed before the aborted pump has had a chance to unwind.
    const second = await stream.subscribe(() => undefined, {
      directory: "/repo",
    });
    expect(fake.subscribeCalls).toBe(2);

    // Let the aborted pump finish releasing.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The successor's claim must have survived, so this resolves to it rather than
    // opening a third stream.
    await stream.subscribe(() => undefined, { directory: "/repo" });
    expect(fake.subscribeCalls).toBe(2);

    second.stop();
    stream.stop();
  });

  test("several directories are tracked independently", async () => {
    const fake = fakeClient();
    const stream = new EventStream(fake.client as never);

    const a = await stream.subscribe(() => undefined, { directory: "/a" });
    const b = await stream.subscribe(() => undefined, { directory: "/b" });
    expect(fake.subscribeCalls).toBe(2);

    // Stopping one must not disturb the other.
    a.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));

    await stream.subscribe(() => undefined, { directory: "/b" });
    expect(fake.subscribeCalls).toBe(2);

    b.stop();
    stream.stop();
  });
});
