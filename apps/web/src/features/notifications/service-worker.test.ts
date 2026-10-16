import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

const source = readFileSync(
  resolve(import.meta.dir, "../../../public/sw.js"),
  "utf8"
);
const payload = {
  version: 1,
  boardId: "board-1",
  cardId: "task-1",
  boardTitle: "Repository",
  cardTitle: "Permission request",
  kind: "permission",
  requestId: "request-1",
  url: "/?board=board-1&card=task-1",
};

interface WindowClient {
  focus(): Promise<void>;
  navigate(target: string): Promise<WindowClient | null>;
  url: string;
}

function harness(windows: WindowClient[] = []) {
  const handlers = new Map<
    string,
    (event: {
      data: { json(): unknown };
      notification: { close(): void; data: unknown };
      waitUntil(promise: Promise<unknown>): void;
    }) => void
  >();
  const showNotification = mock(
    async (_title: string, _options: { body: string; data: unknown }) =>
      undefined
  );
  const openWindow = mock(async (_target: string) => undefined);
  runInNewContext(source, {
    URL,
    URLSearchParams,
    self: {
      location: { origin: "https://chorus.test" },
      addEventListener: (
        type: string,
        handler: typeof handlers extends Map<string, infer T> ? T : never
      ) => handlers.set(type, handler),
      registration: { showNotification },
      clients: { matchAll: async () => windows, openWindow },
    },
  });
  async function emit(type: string, value: unknown) {
    const pending: Promise<unknown>[] = [];
    const close = mock(() => undefined);
    handlers.get(type)?.({
      data: { json: () => value },
      notification: { close, data: value },
      waitUntil: (promise) => pending.push(promise),
    });
    await Promise.all(pending);
    return close;
  }
  return { emit, openWindow, showNotification };
}

describe("approval service worker", () => {
  test("shows a minimal notification and strips unknown payload fields", async () => {
    const worker = harness();
    await worker.emit("push", { ...payload, prompt: "private prompt" });
    expect(worker.showNotification).toHaveBeenCalledTimes(1);
    const options = worker.showNotification.mock.calls[0]?.[1];
    expect(options?.body).toBe("Permission request · Repository");
    expect(options?.data).not.toHaveProperty("prompt");
  });

  test("ignores malformed and external notification targets", async () => {
    const worker = harness();
    for (const value of [
      null,
      {},
      { ...payload, url: "https://evil.test/" },
      { ...payload, cardId: "../escape" },
      { ...payload, requestId: {} },
      { ...payload, url: "/?board=board-1&card=task-1&next=evil" },
    ]) {
      await worker.emit("push", value);
      await worker.emit("notificationclick", value);
    }
    expect(worker.showNotification).not.toHaveBeenCalled();
    expect(worker.openWindow).not.toHaveBeenCalled();
  });

  test("navigates and focuses a same-origin tab", async () => {
    const client: WindowClient = {
      url: "https://chorus.test/",
      focus: mock(async () => undefined),
      navigate: mock(async () => client),
    };
    const worker = harness([client]);
    const close = await worker.emit("notificationclick", payload);
    expect(close).toHaveBeenCalledTimes(1);
    expect(client.navigate).toHaveBeenCalledWith(
      "https://chorus.test/?board=board-1&card=task-1"
    );
    expect(client.focus).toHaveBeenCalledTimes(1);
    expect(worker.openWindow).not.toHaveBeenCalled();
  });

  test("opens a new tab when the existing tab closes or refuses navigation", async () => {
    for (const navigate of [
      async () => null,
      () => Promise.reject(new Error("tab closed")),
    ]) {
      const worker = harness([
        { url: "https://chorus.test/", navigate, focus: async () => undefined },
      ]);
      await worker.emit("notificationclick", payload);
      expect(worker.openWindow).toHaveBeenCalledWith(
        "https://chorus.test/?board=board-1&card=task-1"
      );
    }
  });
});
