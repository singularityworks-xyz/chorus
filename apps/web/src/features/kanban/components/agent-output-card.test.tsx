import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentOutputCard } from "./agent-output-card";

describe("AgentOutputCard before the first provider event", () => {
  test("shows Stop and an honest waiting state for an active task without a run", () => {
    const markup = renderToStaticMarkup(
      <AgentOutputCard
        boardId="board-1"
        isActive
        taskId="task-1"
        taskTitle="Start the task"
      />
    );

    expect(markup).toContain('title="Interrupt agent"');
    expect(markup).toContain(">Stop</button>");
    expect(markup).toContain("Waiting for the agent to send its first update");
    expect(markup).not.toContain("NaN%");
  });

  test("does not show Stop after the task leaves the active lane", () => {
    const markup = renderToStaticMarkup(
      <AgentOutputCard
        boardId="board-1"
        isActive={false}
        taskId="task-1"
        taskTitle="Start the task"
      />
    );

    expect(markup).not.toContain('title="Interrupt agent"');
  });

  test("gives icon-only output controls accessible names", () => {
    const markup = renderToStaticMarkup(
      <AgentOutputCard
        boardId="board-1"
        isActive={false}
        run={{
          elapsed: "1s",
          model: "default",
          steps: [
            {
              content: "The response text",
              id: "response-1",
              kind: "response",
              status: "done",
              summary: "Finished",
            },
            {
              content: "const value = 1;",
              filePath: "src/example.ts",
              id: "edit-1",
              kind: "file_edit",
              linesAdded: 1,
              linesRemoved: 0,
              modifiedContent: "const value = 1;",
              originalContent: "",
              status: "done",
              summary: "Updated example",
            },
          ],
          taskTitle: "Accessibility controls",
        }}
        taskId="task-1"
        taskTitle="Accessibility controls"
      />
    );

    expect(markup).toContain('aria-label="Copy response"');
    expect(markup).toContain('aria-label="Expand response"');
    expect(markup).toContain('aria-label="Expand src/example.ts"');
  });
});
