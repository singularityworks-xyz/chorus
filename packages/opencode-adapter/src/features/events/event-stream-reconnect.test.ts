import { describe, expect, test } from "bun:test";
import { EventStream } from "./event-stream";

const SUBSCRIBE_REFUSED = /subscribe refused/;

type Outcome = "fail" | "end" | "hold";

function fakeClient() {
  let subscribeCalls = 0;

  const outcomes: Outcome[] = [];
  const eventBatches: unknown[][] = [];

  return {
    client: {
      event: {
        subscribe: () => {
          subscribeCalls += 1;

          const outcome = outcomes.shift() ?? "hold";
          if (outcome === "fail") {
            return Promise.reject(new Error("subscribe refused"));
          }

          const delivered = eventBatches.shift() ?? [];
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
    eventBatches,
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

    await stream.subscribe(() => undefined, { directory: "/repo" });
    expect(fake.subscribeCalls).toBe(2);

    stream.stop();
  });

  test("a clean end-of-stream is re-opened rather than treated as finished", async () => {
    const fake = fakeClient();

    fake.outcomes.push("end", "end", "end");
    const stream = new EventStream(fake.client as never);

    await stream.subscribe(() => undefined, { directory: "/repo" });

    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(fake.subscribeCalls).toBeGreaterThan(1);

    stream.stop();
  });

  test("a transient reopen failure is retried until a stream is restored", async () => {
    const fake = fakeClient();
    fake.outcomes.push("end", "fail", "hold");
    const stream = new EventStream(fake.client as never);

    await stream.subscribe(() => undefined, { directory: "/repo" });
    await new Promise((resolve) => setTimeout(resolve, 900));

    expect(fake.subscribeCalls).toBe(3);

    stream.stop();
  });

  test("stable SDK event IDs are deduplicated across stream reconnects", async () => {
    const fake = fakeClient();
    fake.outcomes.push("end", "hold");
    const duplicate = { id: "engine-event-1", type: "session.idle" };
    fake.eventBatches.push([duplicate], [duplicate]);
    const stream = new EventStream(fake.client as never);
    const seen: unknown[] = [];

    await stream.subscribe((event) => seen.push(event), {
      directory: "/repo",
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(fake.subscribeCalls).toBe(2);
    expect(seen).toEqual([duplicate]);

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
    const fake = fakeClient();
    const stream = new EventStream(fake.client as never);

    const first = await stream.subscribe(() => undefined, {
      directory: "/repo",
    });
    expect(fake.subscribeCalls).toBe(1);

    first.stop();

    const second = await stream.subscribe(() => undefined, {
      directory: "/repo",
    });
    expect(fake.subscribeCalls).toBe(2);

    await new Promise((resolve) => setTimeout(resolve, 50));

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

    a.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));

    await stream.subscribe(() => undefined, { directory: "/b" });
    expect(fake.subscribeCalls).toBe(2);

    b.stop();
    stream.stop();
  });
});
