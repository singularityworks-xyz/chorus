import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
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

    const app = new Elysia().use(createWorkspaceRoutes(store));

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

    const app = new Elysia().use(createWorkspaceRoutes(store));

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

  test("a replayed mutationId is idempotent and commits only once", async () => {
    const { dir, store } = createStore("dedup");
    await store.load();

    // The hub is fed by the store's commit hook, so the meaningful assertion is
    // that a retried request produces exactly one commit — not that some
    // transport happened to stay quiet.
    const commits: number[] = [];
    store.onCommit((commit) => commits.push(commit.lastSeq));

    const app = new Elysia().use(createWorkspaceRoutes(store));
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
    expect(commits).toHaveLength(1);

    const second = await app.handle(
      new Request("http://localhost/workspace/mutations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      })
    );

    expect(second.status).toBe(200);
    // No new state, so no second commit — and therefore nothing new downstream.
    expect(commits).toHaveLength(1);
    expect(store.getSnapshot().boards).toHaveLength(1);
    expect(store.headSeq()).toBe(1);

    await store.close();
    rmSync(dir, { force: true, recursive: true });
  });

  test("rejects a malformed mutation with 422", async () => {
    const { dir, store } = createStore("invalid");
    await store.load();

    const app = new Elysia().use(createWorkspaceRoutes(store));

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
