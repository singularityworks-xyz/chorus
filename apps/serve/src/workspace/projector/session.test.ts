import { describe, expect, test } from "bun:test";
import { attachSessionToBoard } from "../projector";
import { column, makeBoard, TASK } from "./test-support";

describe("session", () => {
  test("binds the session id and clears a prior error", () => {
    const board = makeBoard({
      session: {
        currentTaskId: TASK,
        errorMessage: "old",
        sessionId: "sess-old",
        state: "error",
      },
    });

    const next = attachSessionToBoard(board, "sess-new");

    expect(next.session.sessionId).toBe("sess-new");
    expect(next.session.state).toBe("active");
    expect(next.session.errorMessage).toBeUndefined();
    expect(column(next, "in_progress")[0].runId).toBe("sess-new");
  });

  test("works on a board with no active task", () => {
    const board = makeBoard({ session: { state: "uninitialized" } });
    const next = attachSessionToBoard(board, "sess-new");

    expect(next.session.sessionId).toBe("sess-new");
    expect(next.session.state).toBe("active");
  });
});
