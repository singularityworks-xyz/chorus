import { describe, expect, test } from "bun:test";
import { INITIAL_WORKSPACE_STATE, workspaceReducer } from "../reducer";
import { board, withBoards } from "./test-support";

describe("the projector is not idempotent", () => {
  test("card.created appends rather than deduping", () => {
    const snapshotBoard = board("board-1", {
      columns: {
        approve: [],
        done: [],
        in_progress: [],
        queue: [
          {
            id: "card-1",
            label: "Write spec",
            labelVariant: "primary-light",
            title: "Write spec",
          },
        ],
      },
    });

    const afterSnapshot = workspaceReducer(withBoards([snapshotBoard]), {
      boards: [snapshotBoard],
      preferences: INITIAL_WORKSPACE_STATE.preferences,
      selectedBoardId: "board-1",
      type: "server/snapshot",
    });

    const afterReplay = workspaceReducer(afterSnapshot, {
      events: [
        {
          boardId: "board-1",
          column: "queue",
          task: {
            id: "card-1",
            label: "Write spec",
            labelVariant: "primary-light",
            title: "Write spec",
          },
          taskId: "card-1",
          ts: 1,
          type: "card.created",
        },
      ],
      type: "server/events",
    });

    expect(
      afterReplay.boards[0]?.columns.queue.filter((t) => t.id === "card-1")
    ).toHaveLength(2);
  });

  test("step.delta_appended concatenates rather than replacing", () => {
    const snapshotBoard = board("board-1", {
      columns: {
        approve: [],
        done: [],
        in_progress: [],
        queue: [
          {
            id: "card-1",
            label: "Write spec",
            labelVariant: "primary-light",
            run: {
              elapsed: "0s",
              model: "test-model",
              startedAt: 1,
              steps: [
                {
                  content: "hello",
                  id: "step-1",
                  kind: "response",
                  status: "running",
                  summary: "hello",
                },
              ],
              taskTitle: "Write spec",
            },
            title: "Write spec",
          },
        ],
      },
    });

    const afterSnapshot = workspaceReducer(withBoards([snapshotBoard]), {
      boards: [snapshotBoard],
      preferences: INITIAL_WORKSPACE_STATE.preferences,
      selectedBoardId: "board-1",
      type: "server/snapshot",
    });

    const afterReplay = workspaceReducer(afterSnapshot, {
      events: [
        {
          boardId: "board-1",
          delta: "hello",
          stepId: "step-1",
          taskId: "card-1",
          ts: 2,
          type: "step.delta_appended",
        },
      ],
      type: "server/events",
    });

    const step = afterReplay.boards[0]?.columns.queue[0]?.run?.steps[0];
    expect(step?.content).toBe("hellohello");
  });
});
