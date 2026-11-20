import { describe, expect, test } from "bun:test";
import { BOARD_WORKTREE, makeApp } from "../test-support";

describe("GET /sessions/:sessionID/diff", () => {
  test("reads the session diff from the board's authorized checkout", async () => {
    const { app, bridge } = makeApp();

    const response = await app.handle(
      new Request("http://localhost/sessions/sess-1/diff")
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      {
        additions: 1,
        after: "new\n",
        before: "old\n",
        deletions: 1,
        file: "src/main.ts",
      },
    ]);
    expect(bridge.sessionDiff).toHaveBeenCalledWith("sess-1", BOARD_WORKTREE);
  });

  test("rejects a session that has no owning board", async () => {
    const { app, bridge } = makeApp();

    const response = await app.handle(
      new Request("http://localhost/sessions/unknown/diff")
    );

    expect(response.status).toBe(404);
    expect(bridge.sessionDiff).not.toHaveBeenCalled();
  });
});
