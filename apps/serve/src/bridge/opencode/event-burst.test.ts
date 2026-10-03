import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedAgentEvent } from "@chorus/oc-adapter";
import { normalizeEvent, resetMessageTracking } from "@chorus/oc-adapter";
import type { Event as OpencodeEvent } from "@opencode-ai/sdk/v2";
import { WorkspaceStore } from "../../workspace/store";

/**
 * An engine event burst, replayed (plan P6 verify step 6).
 *
 * Unit tests normalize one event at a time and the store tests hand-build the
 * state they need. Neither covers the shape that actually breaks: a real run's
 * events arriving in sequence — parent message, then a burst of part updates and
 * deltas — and being folded onto one board. Ordering assumptions are documented in
 * both files and neither test would catch one of them being wrong.
 */

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
      // `part.messageID` is what the normalizer uses to look the part up against
      // the roles it recorded from `message.updated`; omitting it makes the part
      // unclassifiable and it is dropped without complaint.
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

/**
 * The sequence a run produces for one assistant response.
 *
 * `part.updated` carries the text accumulated so far and each `part.delta` the
 * increment since — so the update is the prefix the deltas extend. Repeating the
 * final text in the update *and* appending the deltas would double-count, which
 * is a fixture bug rather than engine behaviour.
 */
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

/**
 * The streamed text a card has accumulated.
 *
 * Reads the run's steps rather than looking one up by id: the projector prefixes
 * step ids with the message id, so asserting on a raw part id would be asserting
 * that scheme instead of the content.
 */
function streamedText(
  card: { run?: { steps: { content?: string }[] } } | undefined
): string {
  return (card?.run?.steps ?? []).map((step) => step.content ?? "").join("");
}

/**
 * Finds a card wherever the run has moved it.
 *
 * A run does not leave its card in one column: `card.started` moves it to
 * `in_progress` and the terminal transition can move it again, so a fixture that
 * assumes a column is asserting the lifecycle rather than the event handling
 * under test.
 */
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
      // `message.updated` carries no board meaning — it only records the
      // message's role for the normalizer — so it legitimately commits nothing.
      // Every other event in a run must reach the store; a silently dropped one is
      // a card that never progresses, which is the failure this phase was about.
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

      // Both deltas landed on the same part rather than fragmenting into two
      // steps, and the part's own text prefixed them without being duplicated.
      expect(streamedText(card)).toBe("Working on it");

      await store.close();
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("the normalizer is order-sensitive and the store sees the difference", async () => {
    // Documented rather than incidental: the normalizer classifies part events
    // using the role from `message.updated`, so if that ordering ever stops
    // holding, content vanishes with no error at all. Pinning the consequence
    // means a change to the assumption has to be deliberate.
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

      // The delta arrives before any parent has been recorded.
      await store.applyAgentEvent(
        normalizeEvent(delta) as NormalizedAgentEvent
      );

      // Nothing was attributed: the normalizer refused to guess whose text a
      // part with an unrecorded parent belongs to.
      expect(findCard(store, boardId)?.run?.steps ?? []).toHaveLength(0);

      // Parents arrive, then the part, then the increment.
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

  test("the store does not dedup agent events, so the transport must not replay them", async () => {
    // Characterisation, not a guarantee. `applyMutation` dedups by mutation id;
    // agent events have no id and are not deduped here at all, and the projector
    // concatenates delta text. So a replayed delta is visible duplicated content.
    // The protection against that is the client's cursor and its
    // `eventsAfterSnapshot` filter, not this layer — which is exactly why the
    // transport has to be the thing that gets it right.
    resetMessageTracking();
    const { boardId, dir, store } = await seedStoreWithCard(
      "chorus-burst-twice-"
    );

    try {
      // The non-terminal events only. A terminal `session.idle` releases the
      // board's current task, after which late agent events are dropped by the
      // store rather than applied — so replay has to be tested while the card is
      // still the live one.
      const events = burst().slice(0, 4);
      for (const raw of events) {
        await store.applyAgentEvent(
          normalizeEvent(raw) as NormalizedAgentEvent
        );
      }

      const once = findCard(store, boardId);
      expect(streamedText(once)).toBe("Working on it");

      // Replay just the deltas, as an unfiltered resync would.
      const deltas = events.filter((raw) => raw.type === "message.part.delta");
      for (const raw of deltas) {
        await store.applyAgentEvent(
          normalizeEvent(raw) as NormalizedAgentEvent
        );
      }

      const twice = findCard(store, boardId);
      // The increment applied a second time, visibly.
      expect(streamedText(twice)).toBe("Working on it on it");

      await store.close();
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
