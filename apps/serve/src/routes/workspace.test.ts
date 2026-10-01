import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { createWsClientManager } from "../events/broadcaster";
import { WorkspaceStore } from "../workspace/store";
import { createWorkspaceRoutes } from "./workspace";

function createStore(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `chorus-workspace-route-${name}-`));
  const store = new WorkspaceStore(dir);
  return { dir, store };
}

const SEED = {
  repo: { directory: "/tmp/repo", worktree: "/tmp/repo" },
  title: "Repo Board",
};

describe("workspace routes", () => {
  test("returns the persisted workspace snapshot", async () => {
    const { dir, store } = createStore("get");
    await store.load();

    const app = new Elysia().use(
      createWorkspaceRoutes(store, createWsClientManager())
    );

    const response = await app.handle(
      new Request("http://localhost/workspace")
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { boards: unknown[] };
    expect(body.boards).toEqual([]);

    await store.close();
    rmSync(dir, { force: true, recursive: true });
  });

  test("applies a board.create mutation and returns the new snapshot", async () => {
    const { dir, store } = createStore("put");
    await store.load();

    const wsManager = createWsClientManager();
    const app = new Elysia().use(createWorkspaceRoutes(store, wsManager));

    const response = await app.handle(
      new Request("http://localhost/workspace/mutations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseRevision: 0,
          clientId: "client-1",
          mutationId: "mutation-1",
          payload: { seed: SEED },
          type: "board.create",
        }),
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      boards: { title: string }[];
    };
    expect(body.boards[0]?.title).toBe("Repo Board");
    expect(store.getSnapshot().boards[0]?.title).toBe("Repo Board");
    expect(store.headSeq()).toBe(1);

    await store.close();
    rmSync(dir, { force: true, recursive: true });
  });

  test("a replayed mutationId is idempotent and does not re-broadcast", async () => {
    const { dir, store } = createStore("dedup");
    await store.load();

    const wsManager = createWsClientManager();
    const sent: string[] = [];
    const originalBroadcast = wsManager.broadcastRaw.bind(wsManager);
    wsManager.broadcastRaw = (message: string) => {
      sent.push(message);
      originalBroadcast(message);
    };

    const app = new Elysia().use(createWorkspaceRoutes(store, wsManager));
    const body = JSON.stringify({
      baseRevision: 0,
      clientId: "client-1",
      mutationId: "same-id",
      payload: { seed: SEED },
      type: "board.create",
    });

    const first = await app.handle(
      new Request("http://localhost/workspace/mutations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      })
    );
    expect(first.status).toBe(200);
    expect(sent).toHaveLength(1);

    const second = await app.handle(
      new Request("http://localhost/workspace/mutations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      })
    );

    expect(second.status).toBe(200);
    // No new state, so nothing is pushed to clients.
    expect(sent).toHaveLength(1);
    expect(store.getSnapshot().boards).toHaveLength(1);
    expect(store.headSeq()).toBe(1);

    await store.close();
    rmSync(dir, { force: true, recursive: true });
  });

  test("rejects a malformed mutation with 422", async () => {
    const { dir, store } = createStore("invalid");
    await store.load();

    const app = new Elysia().use(
      createWorkspaceRoutes(store, createWsClientManager())
    );

    const response = await app.handle(
      new Request("http://localhost/workspace/mutations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "not.a.mutation" }),
      })
    );

    expect(response.status).toBe(422);

    await store.close();
    rmSync(dir, { force: true, recursive: true });
  });
});
