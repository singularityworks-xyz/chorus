import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedAgentEvent } from "@chorus/oc-adapter";
import { normalizeEvent, resetMessageTracking } from "@chorus/oc-adapter";

type OpencodeEvent = Parameters<typeof normalizeEvent>[0];

import { WorkspaceStore } from "../../workspace/store";

const SESSION = "sess-burst";
const MESSAGE = "msg-1";

function messageUpdated(role: "assistant" | "user"): OpencodeEvent {
  return {
    id: "evt-msg",
    properties: { info: { id: MESSAGE, role }, sessionID: SESSION },
    type: "message.updated",
  } as OpencodeEvent;
}

function partUpdated(text: string, partId: string): OpencodeEvent {
  return {
    id: `evt-${partId}`,
    properties: {
      part: {
        id: partId,
        messageID: MESSAGE,
        sessionID: SESSION,
        text,
        time: { start: 1 },
        type: "text",
      },
      sessionID: SESSION,
      time: 1,
    },
    type: "message.part.updated",
  } as OpencodeEvent;
}

function partDelta(delta: string, partId: string): OpencodeEvent {
  return {
    id: `evt-d-${partId}`,
    properties: {
      delta,
      field: "text",
      messageID: MESSAGE,
      partID: partId,
      sessionID: SESSION,
    },
    type: "message.part.delta",
  } as OpencodeEvent;
}

function burst(): OpencodeEvent[] {
  return [
    messageUpdated("user"),
    messageUpdated("assistant"),
    partUpdated("Working", "part-1"),
    partDelta(" on it", "part-1"),
    {
      id: "evt-status",
      properties: { sessionID: SESSION, status: { type: "busy" } },
      type: "session.status",
    } as OpencodeEvent,
    {
      id: "evt-idle",
      properties: { sessionID: SESSION },
      type: "session.idle",
    } as OpencodeEvent,
  ];
}

async function seedStoreWithCard(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const store = new WorkspaceStore(dir);
  await store.load();

  const created = await store.applyMutation({
    baseRevision: null,
    clientId: "burst-test",
    mutationId: `board-${crypto.randomUUID()}`,
    payload: {
      seed: {
        repo: { directory: "/tmp/repo", sandboxes: [], worktree: "/tmp/repo" },
        title: "Burst Board",
      },
    },
    type: "board.create",
  });

  const event = created?.events[0];
  if (!created || event?.type !== "board.created") {
    throw new Error("expected board.created");
  }
  const boardId = event.board.boardId;

  await store.applyMutation({
    baseRevision: null,
    clientId: "burst-test",
    mutationId: `session-${crypto.randomUUID()}`,
    payload: { boardId, session: { sessionId: SESSION, state: "active" } },
    type: "board.session.patch",
  });

  await store.applyBoardEvents(boardId, [
    {
      boardId,
      column: "queue",
      task: {
        id: "task-1",
        label: "do it",
        labelVariant: "primary-light",
        title: "do it",
      },
      taskId: "task-1",
      ts: Date.now(),
      type: "card.created",
    },
  ]);

  return { boardId, dir, store };
}

function streamedText(
  card: { run?: { steps: { content?: string }[] } } | undefined
): string {
  return (card?.run?.steps ?? []).map((step) => step.content ?? "").join("");
}

function findCard(store: WorkspaceStore, boardId: string) {
  const board = store.getBoard(boardId);
  if (!board) {
    return undefined;
  }

  for (const column of Object.values(board.columns)) {
    const found = column?.find((card) => card.id === "task-1");
    if (found) {
      return found;
    }
  }

  return undefined;
}

describe("engine event burst replay", () => {
  test("a full run's events fold onto one board in order", async () => {
    resetMessageTracking();
    const { boardId, dir, store } = await seedStoreWithCard("chorus-burst-");

    try {
      const BOARD_MEANINGFUL = new Set([
        "message.part.updated",
        "message.part.delta",
        "session.status",
        "session.idle",
      ]);

      for (const raw of burst()) {
        const commit = await store.applyAgentEvent(
          normalizeEvent(raw) as NormalizedAgentEvent
        );
        if (BOARD_MEANINGFUL.has(raw.type)) {
          expect(commit).not.toBeNull();
        }
      }

      const card = findCard(store, boardId);
      expect(card?.id).toBe("task-1");

      expect(streamedText(card)).toBe("Working on it");

      await store.close();
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("an event dropped before its parent is not receipted and can be replayed", async () => {
    resetMessageTracking();
    const { boardId, dir, store } = await seedStoreWithCard(
      "chorus-burst-order-"
    );

    try {
      const events = burst();
      const userMessage = events[0] as OpencodeEvent;
      const assistantMessage = events[1] as OpencodeEvent;
      const textPart = events[2] as OpencodeEvent;
      const delta = events[3] as OpencodeEvent;

      await store.applyAgentEvent(
        normalizeEvent(delta) as NormalizedAgentEvent
      );

      expect(findCard(store, boardId)?.run?.steps ?? []).toHaveLength(0);

      for (const raw of [userMessage, assistantMessage, textPart, delta]) {
        await store.applyAgentEvent(
          normalizeEvent(raw as OpencodeEvent) as NormalizedAgentEvent
        );
      }

      expect(streamedText(findCard(store, boardId))).toBe("Working on it");

      await store.close();
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("durable source receipts deduplicate a replayed event burst", async () => {
    resetMessageTracking();
    const { boardId, dir, store } = await seedStoreWithCard(
      "chorus-burst-twice-"
    );

    try {
      const events = burst().slice(0, 4);
      for (const raw of events) {
        await store.applyAgentEvent(
          normalizeEvent(raw) as NormalizedAgentEvent
        );
      }

      const once = findCard(store, boardId);
      expect(streamedText(once)).toBe("Working on it");

      const deltas = events.filter((raw) => raw.type === "message.part.delta");
      for (const raw of deltas) {
        await store.applyAgentEvent(
          normalizeEvent(raw) as NormalizedAgentEvent
        );
      }

      const twice = findCard(store, boardId);

      expect(streamedText(twice)).toBe("Working on it");

      await store.close();
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
