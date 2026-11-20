import { describe, expect, test } from "bun:test";
import type { Columns, Task } from "@chorus/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { Kanban } from "../components/kanban";
import { TaskCard } from "./task-card";

describe("TaskCard", () => {
  test("shows auto review file changes once", () => {
    const task: Task = {
      changedFiles: [{ added: 2, path: "src/feature.ts", removed: 1 }],
      id: "task-1",
      label: "Feature",
      labelVariant: "primary-light",
      title: "Update a feature",
    };
    const columns: Columns = {
      approve: [task],
      done: [],
      in_progress: [],
      queue: [],
    };
    const markup = renderToStaticMarkup(
      <Kanban
        getItemValue={(item) => item.id}
        id="board-test"
        onReorderTask={() => undefined}
        value={columns}
      >
        <TaskCard
          boardBusy={false}
          boardId="board-test"
          draggable={false}
          onApprove={() => undefined}
          onPlanChange={() => undefined}
          onQuestionsAnswered={() => undefined}
          onReject={() => undefined}
          onRetry={() => undefined}
          onRun={() => undefined}
          reviewMode="auto"
          showApprovalControls
          task={task}
        />
      </Kanban>
    );

    expect(markup.match(/title="src\/feature\.ts"/g)).toHaveLength(1);
  });
});
