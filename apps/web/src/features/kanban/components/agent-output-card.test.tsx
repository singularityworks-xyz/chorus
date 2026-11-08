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
});
