import { describe, expect, test } from "bun:test";
import type { Columns, Task } from "@chorus/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import type { KanbanTaskActionState } from "../hooks/use-kanban-card-actions";
import { Kanban, KanbanColumnBody } from "./kanban";

function makeTask(id: string, outcome?: Task["outcome"]): Task {
  return {
    id,
    label: "Task",
    labelVariant: "primary-light",
    outcome,
    promptInput: { reviewMode: "auto", text: "Make the requested change" },
    title: id,
  };
}

function renderTaskColumn(
  columnId: "queue" | "done",
  task: Task,
  boardBusy: boolean,
  actionStates?: Record<string, KanbanTaskActionState | undefined>
) {
  const columns: Columns = {
    approve: [],
    done: [],
    in_progress: [],
    queue: [],
  };
  columns[columnId] = [task];

  return renderToStaticMarkup(
    <Kanban
      getItemValue={(item) => item.id}
      id="board-test"
      onValueChange={() => undefined}
      value={columns}
    >
      <KanbanColumnBody
        actionStates={actionStates}
        boardBusy={boardBusy}
        boardId="board-test"
        columnId={columnId}
        onApprove={() => undefined}
        onCreateTask={() => undefined}
        onPlanChange={() => undefined}
        onQuestionsAnswered={() => undefined}
        onReject={() => undefined}
        onRetry={() => undefined}
        onReviewModeChange={() => undefined}
        onRun={() => undefined}
        reviewMode="auto"
        reviewModeError={null}
        reviewModePending={false}
        tasks={[task]}
      />
    </Kanban>
  );
}

describe("board-wide task command controls", () => {
  test("explains busy state and disables queued Run", () => {
    const markup = renderTaskColumn("queue", makeTask("queued"), true);

    expect(markup).toContain('role="status"');
    expect(markup).toContain(
      "Finish or resolve current work before running or retrying another task."
    );
    expect(markup).toContain(
      'title="Finish or resolve current work before starting another task"'
    );
    expect(markup).toContain('disabled=""');
    expect(markup).toContain(">Run</button>");
  });

  test("disables Retry on a completed task while another board task is active", () => {
    const markup = renderTaskColumn(
      "done",
      makeTask("completed", "failed"),
      true
    );

    expect(markup).toContain(
      'title="Finish or resolve current work before retrying another task"'
    );
    expect(markup).toContain('disabled=""');
    expect(markup).toContain(">Retry</button>");
  });

  test("keeps Run enabled when the board is idle and the prompt is saved", () => {
    const markup = renderTaskColumn("queue", makeTask("queued"), false);

    expect(markup).toContain('title="Run task"');
    expect(markup).not.toContain('disabled=""');
  });

  test("keeps a rejected Run visible and retryable", () => {
    const markup = renderTaskColumn("queue", makeTask("queued"), false, {
      queued: { error: "Could not reach Chorus. Check the connection." },
    });

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Could not reach Chorus. Check the connection.");
    expect(markup).toContain('title="Run task"');
    expect(markup).not.toContain('disabled=""');
  });

  test("keeps an accepted Run visibly waiting for the board event", () => {
    const markup = renderTaskColumn("queue", makeTask("queued"), true, {
      queued: {
        awaitingTaskCommandId: "queued",
        message: "Request accepted. Waiting for the board to update…",
      },
    });

    expect(markup).toContain(
      "Request accepted. Waiting for the board to update"
    );
    expect(markup).toContain(">Waiting…</button>");
    expect(markup).toContain('disabled=""');
  });
});
