import { describe, expect, test } from "bun:test";
import type { Columns, Task } from "@chorus/contracts";
import {
  getBoardTaskCommandButtonState,
  hasLiveBoardTask,
  hasObservedTaskCommand,
  isBoardTaskCommandBusy,
} from "./board-task-state";

function task(id: string, outcome?: Task["outcome"]): Task {
  return {
    id,
    label: "Task",
    labelVariant: "primary-light",
    outcome,
    title: id,
  };
}

function columns(overrides: Partial<Columns> = {}): Columns {
  return {
    approve: [],
    done: [],
    in_progress: [],
    queue: [],
    ...overrides,
  };
}

describe("board task state", () => {
  test("treats in-progress work and unresolved reviews as live", () => {
    expect(hasLiveBoardTask(columns({ in_progress: [task("running")] }))).toBe(
      true
    );
    expect(
      hasLiveBoardTask(
        columns({ approve: [task("review", "awaiting_review")] })
      )
    ).toBe(true);
  });

  test("does not treat queued, completed, or resolved tasks as live", () => {
    expect(
      hasLiveBoardTask(
        columns({
          approve: [task("resolved-review", "succeeded")],
          done: [task("done", "succeeded")],
          queue: [task("queued")],
        })
      )
    ).toBe(false);
  });

  test("holds the board while a command is pending or awaiting its event", () => {
    expect(
      isBoardTaskCommandBusy(columns(), { task: { pending: "retry" } })
    ).toBe(true);
    expect(
      isBoardTaskCommandBusy(columns(), {
        task: { awaitingTaskCommandId: "retry-child" },
      })
    ).toBe(true);
    expect(
      isBoardTaskCommandBusy(columns(), {
        task: {
          awaitingTaskCommandId: "retry-child",
          awaitingTaskCommandTimedOut: true,
        },
      })
    ).toBe(false);
    expect(isBoardTaskCommandBusy(columns(), {})).toBe(false);
  });

  test("waits for the command target to leave Queue before acknowledging it", () => {
    const queued = columns({ queue: [task("task-1")] });
    expect(hasObservedTaskCommand("task-1", queued)).toBe(false);
    expect(
      hasObservedTaskCommand(
        "task-1",
        columns({ in_progress: [task("task-1")] })
      )
    ).toBe(true);
    expect(
      hasObservedTaskCommand(
        "retry-child",
        columns({ done: [task("retry-child", "succeeded")] })
      )
    ).toBe(true);
  });

  test("explains why Run and Retry are disabled", () => {
    expect(
      getBoardTaskCommandButtonState("run", undefined, true, true)
    ).toEqual({
      disabled: true,
      label: "Run",
      title: "Finish or resolve current work before starting another task",
    });
    expect(
      getBoardTaskCommandButtonState("retry", undefined, false, false)
    ).toEqual({
      disabled: true,
      label: "Retry",
      title: "The saved prompt is unavailable",
    });
  });

  test("shows pending, waiting, and recovery labels for command buttons", () => {
    expect(
      getBoardTaskCommandButtonState("run", { pending: "run" }, true, true)
    ).toMatchObject({ disabled: true, label: "Starting…" });
    expect(
      getBoardTaskCommandButtonState(
        "retry",
        { awaitingTaskCommandId: "retry-child" },
        true,
        true
      )
    ).toMatchObject({ disabled: true, label: "Waiting…" });
    expect(
      getBoardTaskCommandButtonState(
        "retry",
        {
          awaitingTaskCommandId: "retry-child",
          awaitingTaskCommandTimedOut: true,
        },
        false,
        true
      )
    ).toMatchObject({ disabled: false, label: "Retry" });
  });
});
