import { describe, expect, test } from "bun:test";
import type { Columns, Task } from "@/features/kanban/components/kanban";
import {
  canRedoKanbanHistory,
  canUndoKanbanHistory,
  EMPTY_KANBAN_HISTORY,
  recordKanbanHistory,
  redoKanbanHistory,
  undoKanbanHistory,
} from "./kanban-history-state";

function makeTask(id: string): Task {
  return {
    id,
    label: id,
    labelVariant: "primary-light",
    title: id,
  };
}

function makeEntry(boardId: string, taskId: string) {
  const task = makeTask(taskId);
  const columnsBefore: Columns = {
    queue: [task],
  };
  const columnsAfter: Columns = {
    done: [task],
  };
  return {
    boardId,
    columnsAfter,
    columnsBefore,
    prompt: `Prompt for ${taskId}`,
    task,
    timestamp: 1,
  };
}

describe("Kanban history state", () => {
  test("undo and redo select entries from the requested board", () => {
    let state = EMPTY_KANBAN_HISTORY;
    state = recordKanbanHistory(state, makeEntry("board-a", "a-1"));
    state = recordKanbanHistory(state, makeEntry("board-b", "b-1"));
    state = recordKanbanHistory(state, makeEntry("board-a", "a-2"));

    const undoA = undoKanbanHistory(state, "board-a");
    expect(undoA?.entry.task.id).toBe("a-2");
    expect(canUndoKanbanHistory(undoA?.state ?? state, "board-a")).toBe(true);
    expect(canUndoKanbanHistory(undoA?.state ?? state, "board-b")).toBe(true);
    expect(canRedoKanbanHistory(undoA?.state ?? state, "board-a")).toBe(true);
    expect(canRedoKanbanHistory(undoA?.state ?? state, "board-b")).toBe(false);

    const redoA = redoKanbanHistory(undoA?.state ?? state, "board-a");
    expect(redoA?.entry.task.id).toBe("a-2");
    expect(canRedoKanbanHistory(redoA?.state ?? state, "board-a")).toBe(false);
    expect(canUndoKanbanHistory(redoA?.state ?? state, "board-b")).toBe(true);
  });

  test("recording a board action clears only that board's redo stack", () => {
    let state = EMPTY_KANBAN_HISTORY;
    state = recordKanbanHistory(state, makeEntry("board-a", "a-1"));
    state = recordKanbanHistory(state, makeEntry("board-b", "b-1"));

    const undoneA = undoKanbanHistory(state, "board-a");
    const undoneB = undoKanbanHistory(undoneA?.state ?? state, "board-b");
    const newA = recordKanbanHistory(
      undoneB?.state ?? state,
      makeEntry("board-a", "a-2")
    );

    expect(canRedoKanbanHistory(newA, "board-a")).toBe(false);
    expect(canRedoKanbanHistory(newA, "board-b")).toBe(true);
    expect(redoKanbanHistory(newA, "board-b")?.entry.task.id).toBe("b-1");
  });

  test("empty board history does not consume another board's entries", () => {
    const state = recordKanbanHistory(
      EMPTY_KANBAN_HISTORY,
      makeEntry("board-a", "a-1")
    );

    expect(undoKanbanHistory(state, "board-b")).toBeNull();
    expect(canUndoKanbanHistory(state, "board-a")).toBe(true);
  });

  test("history retention on one board does not evict another board", () => {
    let state = recordKanbanHistory(
      EMPTY_KANBAN_HISTORY,
      makeEntry("board-b", "b-1")
    );
    for (let index = 0; index < 51; index++) {
      state = recordKanbanHistory(state, makeEntry("board-a", `a-${index}`));
    }

    expect(canUndoKanbanHistory(state, "board-b")).toBe(true);
    expect(canUndoKanbanHistory(state, "board-a")).toBe(true);
    expect(undoKanbanHistory(state, "board-b")?.entry.task.id).toBe("b-1");
    expect(undoKanbanHistory(state, "board-a")?.entry.task.id).toBe("a-50");
  });

  test("retained history stays bounded across boards", () => {
    let state = EMPTY_KANBAN_HISTORY;
    for (let index = 0; index < 101; index++) {
      state = recordKanbanHistory(
        state,
        makeEntry(`board-${index}`, `task-${index}`)
      );
    }

    expect(canUndoKanbanHistory(state, "board-0")).toBe(false);
    expect(canUndoKanbanHistory(state, "board-100")).toBe(true);
  });
});
