import { describe, expect, test } from "bun:test";
import { abortBoardTask } from "./task-abort-client";

describe("board task abort client", () => {
  test("sends an encoded, bounded stop command to the selected board and task", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;

    await abortBoardTask("board / one", "task/one", (input, init) => {
      requestUrl = input instanceof Request ? input.url : String(input);
      requestInit = init;
      return Promise.resolve(
        new Response(JSON.stringify({ accepted: true }), { status: 200 })
      );
    });

    expect(requestUrl).toBe(
      "/api/boards/board%20%2F%20one/tasks/task%2Fone/abort"
    );
    expect(requestInit?.method).toBe("POST");
    expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
  });

  test("surfaces a rejected stop and invalid acknowledgments", async () => {
    await expect(
      abortBoardTask("board-1", "task-1", () =>
        Promise.resolve(
          new Response(JSON.stringify({ accepted: false }), { status: 200 })
        )
      )
    ).rejects.toThrow("The engine did not accept the stop request");

    await expect(
      abortBoardTask("board-1", "task-1", () =>
        Promise.resolve(new Response("not json", { status: 200 }))
      )
    ).rejects.toThrow("invalid command acknowledgment");
  });

  test("preserves server failures and makes ambiguous transport failures actionable", async () => {
    await expect(
      abortBoardTask(
        "board-1",
        "task-1",
        async () =>
          new Response(
            JSON.stringify({
              code: "task_not_active",
              message: "This task has already finished.",
            }),
            { status: 409 }
          )
      )
    ).rejects.toThrow("This task has already finished.");

    await expect(
      abortBoardTask("board-1", "task-1", () =>
        Promise.reject(new DOMException("Timed out", "TimeoutError"))
      )
    ).rejects.toThrow("task may still be running");

    await expect(
      abortBoardTask("board-1", "task-1", () =>
        Promise.reject(new TypeError("Failed to fetch"))
      )
    ).rejects.toThrow("Could not reach Chorus");
  });
});
