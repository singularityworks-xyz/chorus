import { describe, expect, test } from "bun:test";
import { type Task, taskSchema } from "@chorus/contracts";
import { submitTaskApproval, submitTaskRejection } from "./approval-requests";

type TaskActionFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

function makeTask(overrides: Partial<Task> = {}) {
  return taskSchema.parse({
    id: "task/1",
    label: "Task",
    labelVariant: "primary-light",
    title: "Review this plan",
    ...overrides,
  });
}

function acceptedResponse() {
  return new Response(JSON.stringify({ accepted: true }), { status: 200 });
}

function recordRequests() {
  const requests: { input: string; init?: RequestInit }[] = [];
  const fetcher: TaskActionFetch = (input, init) => {
    requests.push({ input: String(input), init });
    return Promise.resolve(acceptedResponse());
  };
  return { fetcher, requests };
}

describe("task approval requests", () => {
  test("approves a permission using the provider session and request ID", async () => {
    const { fetcher, requests } = recordRequests();

    await submitTaskApproval(
      {
        answers: [],
        boardId: "board",
        plan: "",
        sessionId: "fallback-session",
        task: makeTask({
          pendingApprovals: [{ kind: "permission", requestId: "perm/1" }],
          runId: "provider/session",
        }),
      },
      fetcher
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.input).toBe("/api/tasks/provider%2Fsession/approve");
    expect(requests[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      requestID: "perm/1",
    });
  });

  test("finalizes a review with edited plan and answers", async () => {
    const { fetcher, requests } = recordRequests();

    await submitTaskApproval(
      {
        answers: ["Use the existing queue"],
        boardId: "board/1",
        plan: "Refined plan",
        task: makeTask({ outcome: "awaiting_review" }),
      },
      fetcher
    );

    expect(requests[0]?.input).toBe(
      "/api/boards/board%2F1/tasks/task%2F1/finalize-review"
    );
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      answers: ["Use the existing queue"],
      plan: "Refined plan",
    });
  });

  test("rejects a pending question through its provider request", async () => {
    const { fetcher, requests } = recordRequests();

    await submitTaskRejection(
      {
        boardId: "board",
        sessionId: "provider/session",
        task: makeTask({
          pendingApprovals: [
            { kind: "question", questions: [], requestId: "question/1" },
          ],
        }),
      },
      fetcher
    );

    expect(requests[0]?.input).toBe(
      "/api/tasks/provider%2Fsession/questions/question%2F1/reject"
    );
    expect(requests[0]?.init?.method).toBe("POST");
    expect(requests[0]?.init?.body).toBeUndefined();
  });

  test("does not send a request for a question that must be answered", async () => {
    const { fetcher, requests } = recordRequests();

    await expect(
      submitTaskApproval(
        {
          answers: [],
          boardId: "board",
          plan: "",
          task: makeTask({
            pendingApprovals: [
              { kind: "question", questions: [], requestId: "question/1" },
            ],
          }),
        },
        fetcher
      )
    ).rejects.toThrow("Answer the pending question in this card");
    expect(requests).toHaveLength(0);
  });
});
