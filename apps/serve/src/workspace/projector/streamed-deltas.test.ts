import { describe, expect, test } from "bun:test";
import type { WorkspaceBoard } from "@chorus/contracts";
import { applyEventToBoard } from "@chorus/contracts";
import { applyAgentEventToBoard, toWorkspaceEvents } from "../projector";
import { agentEvent, BOARD, makeBoard, stepsOf, TASK } from "./test-support";

describe("streamed-deltas", () => {
  const scope = { boardId: BOARD, taskId: TASK };

  function applyDomainEvents(
    board: WorkspaceBoard,
    events: ReturnType<typeof toWorkspaceEvents>
  ): WorkspaceBoard {
    return events.reduce(applyEventToBoard, board);
  }

  function boardWithStreamingStep(content: string) {
    const board = makeBoard();
    const opened = applyDomainEvents(
      board,
      toWorkspaceEvents(
        agentEvent({
          activity: "writing",
          partID: "prt_1",
          messageID: "msg_1",
        }),
        scope
      )
    );
    return applyDomainEvents(
      opened,
      toWorkspaceEvents(
        agentEvent({
          activity: "writing",
          delta: content,
          messageID: "msg_1",
          partID: "prt_1",
        }),
        scope
      )
    );
  }

  test("appends a delta to the matching part step", () => {
    const board = boardWithStreamingStep("he");
    const next = applyAgentEventToBoard(
      board,
      agentEvent({
        activity: "writing",
        delta: "llo",
        messageID: "msg_1",
        partID: "prt_1",
      })
    );

    expect(stepsOf(next)).toHaveLength(1);
    expect(stepsOf(next)[0].content).toBe("hello");
    expect(stepsOf(next)[0].summary).toBe("hello");
  });

  test("does not leak deltas between different parts", () => {
    const board = boardWithStreamingStep("first");

    const withTwo = applyDomainEvents(
      board,
      toWorkspaceEvents(
        agentEvent({
          activity: "writing",
          partID: "prt_2",
          messageID: "msg_2",
        }),
        scope
      )
    );
    expect(stepsOf(withTwo)).toHaveLength(2);

    const appended = applyAgentEventToBoard(
      withTwo,
      agentEvent({
        activity: "writing",
        delta: "second",
        messageID: "msg_2",
        partID: "prt_2",
      })
    );

    expect(stepsOf(appended)).toHaveLength(2);
    expect(stepsOf(appended)[0].content).toBe("first");
    expect(stepsOf(appended)[1].content).toBe("second");
  });

  test("a delta with no matching step opens one instead of dropping text", () => {
    const board = makeBoard();
    const next = applyAgentEventToBoard(
      board,
      agentEvent({ activity: "writing", delta: "orphan tokens" })
    );

    expect(stepsOf(next)).toHaveLength(1);
    expect(stepsOf(next)[0].content).toBe("orphan tokens");
  });

  test("orphan deltas for one message accumulate into a single step", () => {
    let board = makeBoard();

    for (const chunk of ["alpha ", "beta ", "gamma"]) {
      board = applyAgentEventToBoard(
        board,
        agentEvent({
          activity: "writing",
          delta: chunk,
          messageID: "msg_orphan",
        })
      );
    }

    expect(stepsOf(board)).toHaveLength(1);
    expect(stepsOf(board)[0].content).toBe("alpha beta gamma");
  });

  test("orphan delta ids are reproducible so log replay matches", () => {
    const event = agentEvent({
      activity: "writing",
      delta: "x",
      messageID: "msg_replay",
    });

    const [first] = toWorkspaceEvents(event, { boardId: BOARD, taskId: TASK });
    const [second] = toWorkspaceEvents(event, { boardId: BOARD, taskId: TASK });

    expect(first.type).toBe("step.delta_appended");
    expect(first.type === "step.delta_appended" && first.stepId).toBe(
      second.type === "step.delta_appended" && second.stepId
    );
  });

  test("step ids are stable across the stream", () => {
    const board = boardWithStreamingStep("a");
    const ids = stepsOf(board).map((step) => step.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
