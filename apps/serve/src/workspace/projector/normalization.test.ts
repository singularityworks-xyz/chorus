import { describe, expect, test } from "bun:test";
import { workspaceEventSchema } from "@chorus/contracts";
import { toWorkspaceEvents } from "../projector";
import { agentEvent, BOARD, TASK } from "./test-support";

describe("normalization", () => {
  test("a thinking event yields a step and an in_progress move", () => {
    const events = toWorkspaceEvents(
      agentEvent({ activity: "thinking", partID: "p1", text: "pondering" }),
      { boardId: BOARD, taskId: TASK }
    );

    expect(events.map((e) => e.type)).toEqual([
      "step.upserted",
      "card.started",
    ]);
  });

  test("empty engine text produces valid non-empty step summaries", () => {
    const emptyThinking = toWorkspaceEvents(
      agentEvent({ activity: "thinking", partID: "thinking", text: "" }),
      { boardId: BOARD, taskId: TASK }
    );
    const whitespaceWriting = toWorkspaceEvents(
      agentEvent({ activity: "writing", partID: "response", text: "   " }),
      { boardId: BOARD, taskId: TASK }
    );

    for (const event of [...emptyThinking, ...whitespaceWriting]) {
      expect(workspaceEventSchema.safeParse(event).success).toBe(true);
    }

    const step = emptyThinking.find((event) => event.type === "step.upserted");
    expect(step?.type === "step.upserted" && step.step.summary).toBe(
      "Thinking"
    );
  });

  test("a tool event becomes a tool_call step", () => {
    const [step] = toWorkspaceEvents(
      agentEvent({
        activity: "idle",
        toolName: "bash",
        toolState: "completed",
        partID: "p2",
      }),
      { boardId: BOARD, taskId: TASK }
    );

    expect(step.type).toBe("step.upserted");
    expect(step.type === "step.upserted" && step.step.kind).toBe("tool_call");
    expect(step.type === "step.upserted" && step.step.summary).toBe(
      "bash · completed"
    );
  });

  test("a file diff downgrades the step to file_edit with contents", () => {
    const [step] = toWorkspaceEvents(
      agentEvent({
        activity: "idle",
        toolName: "edit",
        partID: "p3",
        fileDiff: {
          additions: 3,
          after: "after",
          before: "before",
          deletions: 1,
          filePath: "src/app.ts",
        },
      }),
      { boardId: BOARD, taskId: TASK }
    );

    expect(step.type === "step.upserted" && step.step.kind).toBe("file_edit");
    expect(step.type === "step.upserted" && step.step.filePath).toBe(
      "src/app.ts"
    );
    expect(step.type === "step.upserted" && step.step.originalContent).toBe(
      "before"
    );
    expect(step.type === "step.upserted" && step.step.linesAdded).toBe(3);
  });

  test("a permission request is normalized to a permission approval", () => {
    const events = toWorkspaceEvents(
      agentEvent({
        activity: "waiting_for_approval",
        permissionID: "perm-1",
      }),
      { boardId: BOARD, taskId: TASK }
    );

    const approval = events.find((e) => e.type === "card.waiting_for_approval");
    expect(approval).toBeDefined();
    expect(
      approval?.type === "card.waiting_for_approval" && approval.kind
    ).toBe("permission");
    expect(
      approval?.type === "card.waiting_for_approval" && approval.requestId
    ).toBe("perm-1");
  });

  test("an agent question is normalized to a question approval", () => {
    const events = toWorkspaceEvents(
      agentEvent({
        activity: "waiting_for_question",
        questionID: "q-1",
        questions: [
          { header: "Which approach?", options: [], question: "Which one?" },
        ],
      }),
      { boardId: BOARD, taskId: TASK }
    );

    const approval = events.find((e) => e.type === "card.waiting_for_approval");
    expect(
      approval?.type === "card.waiting_for_approval" && approval.kind
    ).toBe("question");
  });

  test("a timeout maps to session.timeout, not session.error", () => {
    const events = toWorkspaceEvents(
      agentEvent({
        activity: "error",
        type: "session.timeout",
        error: "no activity",
      }),
      { boardId: BOARD, taskId: TASK }
    );

    expect(events.some((e) => e.type === "session.timeout")).toBe(true);
    expect(events.some((e) => e.type === "session.error")).toBe(false);
  });

  test("every emitted event carries the board scope", () => {
    const events = toWorkspaceEvents(
      agentEvent({ activity: "thinking", partID: "p9", text: "x" }),
      { boardId: "board-xyz", taskId: "task-xyz" }
    );

    for (const event of events) {
      expect("boardId" in event && event.boardId).toBe("board-xyz");
    }
  });
});
