import type { WorkspaceBoard } from "../base/boards";
import type { AgentRunContext, AgentStep, Task } from "../base/tasks";
import { withTaskUpdated } from "./task-state";

const SUMMARY_MAX = 72;
const DEFAULT_RUN_MODEL = "OpenCode";

export function formatElapsed(startedAt: number, now: number): string {
  const elapsedMs = Math.max(now - startedAt, 0);
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

export function ensureRun(
  task: Task,
  init: {
    model: string;
    sessionId?: string;
    startedAt: number;
    taskTitle: string;
  }
): AgentRunContext {
  return (
    task.run ?? {
      elapsed: "0m 00s",
      model: init.model,
      sessionId: init.sessionId,
      startedAt: init.startedAt,
      steps: [],
      taskTitle: init.taskTitle,
    }
  );
}

export function upsertStep(
  run: AgentRunContext,
  step: AgentStep,
  now: number
): AgentRunContext {
  const existingIndex = run.steps.findIndex((entry) => entry.id === step.id);

  if (existingIndex !== -1) {
    const steps = run.steps.map((entry, index) =>
      index === existingIndex ? step : entry
    );
    return { ...run, elapsed: formatElapsed(run.startedAt ?? now, now), steps };
  }

  const steps = run.steps
    .map((entry) =>
      entry.status === "running" ? { ...entry, status: "done" as const } : entry
    )
    .concat(step);

  return { ...run, elapsed: formatElapsed(run.startedAt ?? now, now), steps };
}

export function appendDelta(
  run: AgentRunContext,
  stepId: string,
  delta: string,
  now: number
): AgentRunContext {
  const index = run.steps.findIndex((entry) => entry.id === stepId);
  if (index === -1) {
    return {
      ...run,
      elapsed: formatElapsed(run.startedAt ?? now, now),
      steps: [
        ...run.steps,
        {
          id: stepId,
          kind: "response",
          status: "running",
          summary: delta.trim().slice(0, SUMMARY_MAX) || "Streaming response",
          content: delta,
        },
      ],
    };
  }

  const existing = run.steps[index];
  const content = `${existing.content ?? ""}${delta}`;

  const steps = run.steps.map((entry, position) =>
    position === index
      ? {
          ...entry,
          content,
          summary:
            content.length > 0 ? content.slice(0, SUMMARY_MAX) : entry.summary,
        }
      : entry
  );

  return { ...run, elapsed: formatElapsed(run.startedAt ?? now, now), steps };
}

export function extractPlanFromSteps(steps: AgentStep[]): string | null {
  const responseSteps = steps.filter(
    (step) => step.kind === "response" || step.kind === "thinking"
  );

  if (responseSteps.length === 0) {
    return null;
  }

  const plan = responseSteps
    .map((step) => step.content ?? step.summary)
    .filter((part): part is string => Boolean(part))
    .join("\n\n");

  return plan.length > 0 ? plan : null;
}

export function withRun(
  board: WorkspaceBoard,
  taskId: string,
  update: (run: AgentRunContext) => AgentRunContext,
  now: number
): WorkspaceBoard {
  const columns = withTaskUpdated(board.columns, taskId, (task) => {
    const run =
      task.run ??
      ({
        elapsed: "0m 00s",
        model: DEFAULT_RUN_MODEL,
        sessionId: board.session.sessionId,
        startedAt: now,
        steps: [],
        taskTitle: task.title,
      } satisfies AgentRunContext);

    const nextRun = update(run);
    if (nextRun === run && task.run) {
      return task;
    }

    return {
      ...task,
      run: nextRun,
      runId: board.session.sessionId ?? task.runId,
    };
  });

  return columns === board.columns ? board : { ...board, columns };
}
