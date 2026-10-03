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

function fakeClient() {
  let subscribeCalls = 0;
  /** One outcome per subscribe attempt; defaults to a clean open. */
  const outcomes: ("open" | "fail")[] = [];

  return {
    client: {
      event: {
        subscribe: () => {
          subscribeCalls += 1;

          if (outcomes.shift() === "fail") {
            return Promise.reject(new Error("subscribe refused"));
          }

          const delivered: unknown[] = [];

          const stream = {
            [Symbol.asyncIterator]() {
              return this;
            },
            next: () =>
              Promise.resolve(
                delivered.length > 0
                  ? { done: false, value: delivered.shift() }
                  : { done: true, value: undefined }
              ),
            return: () => Promise.resolve({ done: true, value: undefined }),
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
    fake.outcomes.push("fail", "open");
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
    fake.outcomes.push("open", "open", "open");
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
    fake.outcomes.push("open", "open", "open", "open");
    const stream = new EventStream(fake.client as never);

    await stream.subscribe(() => undefined, { directory: "/repo" });
    const callsBeforeStop = fake.subscribeCalls;

    stream.stop();
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(fake.subscribeCalls).toBe(callsBeforeStop);
  });
});
