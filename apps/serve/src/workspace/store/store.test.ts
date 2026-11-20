import { describe, expect, test } from "bun:test";
import type { WorkspaceMutation } from "@chorus/contracts";
import { workspaceIdSchema } from "@chorus/contracts";
import { WORKSPACE_ID_KEY } from "../database/connection";
import {
  createStore,
  createStoreAt,
  createTempDir,
  mutation,
  SEED,
  seedBoard,
} from "./test-support";

describe("WorkspaceStore persistence", () => {
  test("keeps a stable sync identity for this database and assigns a new one to another", async () => {
    const dir = createTempDir("chorus-store-identity-");

    const first = createStoreAt(dir);
    await first.load();
    const firstId = first.workspaceId;
    await first.close();

    const reopened = createStoreAt(dir);
    await reopened.load();
    expect(reopened.workspaceId).toBe(firstId);

    const separate = createStore();
    await separate.load();
    expect(separate.workspaceId).not.toBe(firstId);
  });

  test("repairs a malformed persisted sync identity", async () => {
    const dir = createTempDir("chorus-store-identity-");

    const first = createStoreAt(dir);
    await first.load();
    const originalId = first.workspaceId;
    first.meta.setMeta(WORKSPACE_ID_KEY, "not-a-uuid");
    await first.close();

    const reopened = createStoreAt(dir);
    await reopened.load();

    expect(reopened.workspaceId).not.toBe(originalId);
    expect(workspaceIdSchema.safeParse(reopened.workspaceId).success).toBe(
      true
    );
  });

  test("appends board.create as a single sequenced event", async () => {
    const store = createStore();
    await store.load();

    const commit = await store.applyMutation(
      mutation("board.create", { seed: SEED })
    );

    expect(commit).not.toBeNull();
    expect(commit?.events).toHaveLength(1);
    expect(commit?.events[0].type).toBe("board.created");
    expect(commit?.firstSeq).toBe(1);
    expect(commit?.lastSeq).toBe(1);
    expect(store.headSeq()).toBe(1);
    expect(store.getSnapshot().boards).toHaveLength(1);
  });

  test("a stale reorder cannot move a task after it starts", async () => {
    const store = createStore();
    await store.load();
    const boardId = await seedBoard(store);
    await store.applyBoardEvents(boardId, [
      {
        type: "board.columns_replaced",
        ts: Date.now(),
        boardId,
        columns: {
          queue: [
            {
              id: "task-a",
              label: "repo",
              labelVariant: "primary-light",
              title: "First task",
            },
            {
              id: "task-b",
              label: "repo",
              labelVariant: "primary-light",
              title: "Second task",
            },
          ],
          in_progress: [],
          approve: [],
          done: [],
        },
      },
    ]);

    await store.applyBoardEvents(boardId, [
      {
        type: "card.started",
        ts: Date.now(),
        boardId,
        taskId: "task-a",
      },
    ]);
    const commit = await store.applyMutation(
      mutation("board.task.reorder", {
        boardId,
        taskId: "task-a",
        column: "queue",
        beforeTaskId: "task-b",
      })
    );

    expect(commit?.events[0].type).toBe("card.reordered");
    expect(
      store.getBoard(boardId)?.columns.in_progress?.map((task) => task.id)
    ).toEqual(["task-a"]);
    expect(
      store.getBoard(boardId)?.columns.queue?.map((task) => task.id)
    ).toEqual(["task-b"]);
  });

  test("legacy column updates reorder current tasks without replacing their state", async () => {
    const store = createStore();
    await store.load();
    const boardId = await seedBoard(store);
    const currentTask = (id: string, title: string) => ({
      id,
      label: "repo",
      labelVariant: "primary-light" as const,
      title,
    });
    await store.applyBoardEvents(boardId, [
      {
        type: "board.columns_replaced",
        ts: Date.now(),
        boardId,
        columns: {
          queue: [currentTask("task-a", "A"), currentTask("task-b", "B")],
          in_progress: [],
          approve: [],
          done: [],
        },
      },
      {
        type: "card.created",
        ts: Date.now(),
        boardId,
        column: "queue",
        taskId: "task-c",
        task: currentTask("task-c", "C"),
      },
    ]);
    await store.applyBoardEvents(boardId, [
      { type: "card.started", ts: Date.now(), boardId, taskId: "task-a" },
    ]);

    const commit = await store.applyMutation(
      mutation("board.columns.replace", {
        boardId,
        columns: {
          queue: [
            currentTask("task-b", "stale B"),
            currentTask("task-a", "stale A"),
          ],
          in_progress: [],
          approve: [],
          done: [],
        },
      })
    );

    expect(commit?.events[0]?.type).toBe("board.columns_replaced");
    expect(
      store.getBoard(boardId)?.columns.queue?.map((task) => task.id)
    ).toEqual(["task-b", "task-c"]);
    expect(
      store.getBoard(boardId)?.columns.in_progress?.map((task) => task.id)
    ).toEqual(["task-a"]);
    expect(store.getBoard(boardId)?.columns.queue?.[0]?.title).toBe("B");
  });

  test("a reload replays the log into identical state", async () => {
    const dir = createTempDir("chorus-replay-");

    const first = createStoreAt(dir);
    await first.load();
    const boardId = await seedBoard(first);
    await first.applyMutation(
      mutation("board.move", { boardId, position: { x: 42, y: 43 } })
    );
    await first.applyMutation(
      mutation("board.model.set", {
        boardId,
        model: { providerID: "anthropic", modelID: "claude" },
      })
    );
    await first.applyMutation(
      mutation("preference.default_model.set", {
        model: { providerID: "openai", modelID: "gpt-5" },
      })
    );
    const before = first.getSnapshot();
    await first.close();

    const second = createStoreAt(dir);
    await second.load();

    expect(second.getSnapshot()).toEqual(before);
    expect(second.getBoard(boardId)?.position).toEqual({ x: 42, y: 43 });
    expect(second.getBoard(boardId)?.modelSelection?.modelID).toBe("claude");
    expect(second.getSnapshot().preferences.defaultModelSelection).toEqual({
      providerID: "openai",
      modelID: "gpt-5",
    });
    await second.close();
  });

  test("every mutation type produces exactly one event", async () => {
    const store = createStore();
    await store.load();
    const boardId = await seedBoard(store);

    const cases: WorkspaceMutation[] = [
      mutation("board.move", { boardId, position: { x: 1, y: 2 } }),
      mutation("board.model.set", { boardId, model: null }),
      mutation("board.review_mode.set", { boardId, reviewMode: "manual" }),
      mutation("board.task.reorder", {
        boardId,
        column: "queue",
        taskId: "task-missing",
        beforeTaskId: null,
      }),
      mutation("board.session.patch", {
        boardId,
        session: { state: "active" },
      }),
      mutation("board.task.plan.update", { boardId, taskId: "t1", plan: "p" }),
      mutation("preference.dismiss_composer_hint", {}),
      mutation("preference.speech_voice.set", { voiceId: "hannah" }),
      mutation("preference.set_voice", { voice: "daniel" }),
      mutation("preference.board_view_mode.set", { mode: "stacked" }),
      mutation("preference.recently_used_models.add", {
        model: { providerID: "p", modelID: "m" },
      }),
      mutation("preference.default_model.set", {
        model: { providerID: "p", modelID: "m" },
      }),
      mutation("board.select", { boardId }),
    ];

    for (const m of cases) {
      const commit = await store.applyMutation(m);
      expect(commit?.events).toHaveLength(1);
    }
  });

  test("recent model projections stay aligned after event-log replay", async () => {
    const directory = createTempDir("chorus-model-projection-");
    const first = createStoreAt(directory);
    await first.load();

    for (let index = 0; index < 7; index += 1) {
      await first.applyMutation(
        mutation("preference.recently_used_models.add", {
          model: { providerID: "provider", modelID: `model-${index}` },
        })
      );
    }

    await first.close();
    const replayed = createStoreAt(directory);
    await replayed.load();
    expect(
      replayed
        .getSnapshot()
        .preferences.recentlyUsedModels.map((model) => model.modelID)
    ).toEqual(["model-6", "model-5", "model-4", "model-3", "model-2"]);

    await replayed.applyMutation(
      mutation("preference.recently_used_models.add", {
        model: { providerID: "provider", modelID: "model-4" },
      })
    );
    expect(
      replayed
        .getSnapshot()
        .preferences.recentlyUsedModels.map((model) => model.modelID)
    ).toEqual(["model-4", "model-6", "model-5", "model-3", "model-2"]);
  });

  test("maps legacy voice mutations to the current preference event", async () => {
    const store = createStore();
    await store.load();

    const commit = await store.applyMutation(
      mutation("preference.set_voice", { voice: "daniel" })
    );

    expect(commit?.events[0].type).toBe("preference.speech_voice_set");
    expect(store.getSnapshot().preferences.speechVoiceId).toBe("daniel");
  });
});
