import type {
  AgentRunContext,
  AgentStep,
  Columns,
  ModelSelection,
  Task,
  WorkspaceBoard,
  WorkspaceSnapshotInput,
} from "./base";
import type {
  BoardScopedEvent,
  WorkspaceColumnId,
  WorkspaceEvent,
} from "./events";
import { isBoardScopedEvent, WORKSPACE_COLUMN_IDS } from "./events";

/**
 * The single shared projector (spec §4 / plan Phase 1).
 *
 * Pure by construction: no clock reads, no randomness, no mutation of inputs.
 * Run elapsed time is derived from `event.ts`, never `Date.now()`, so replaying
 * the same event log always produces the same board.
 *
 * Before this module existed, `apps/serve/src/workspace/projector.ts` and
 * `apps/web/src/features/workspace/state.ts` each carried their own copy — and
 * the copies had already drifted (delta step-id prefixing, `session.timeout`
 * handling). Neither app may define board-reduction logic again.
 */

const SUMMARY_MAX = 72;

/** Placeholder run model until `run.started` reports the real one. */
const DEFAULT_RUN_MODEL = "OpenCode";

function emptyColumns(): Columns {
  return { queue: [], in_progress: [], approve: [], done: [] };
}

function normalizeColumns(columns: Columns): Columns {
  const next = emptyColumns();
  for (const columnId of WORKSPACE_COLUMN_IDS) {
    next[columnId] = columns[columnId] ?? [];
  }
  return next;
}

function withTaskUpdated(
  columns: Columns,
  taskId: string,
  updater: (task: Task) => Task
): Columns {
  let changed = false;
  const next: Columns = {};

  for (const [columnId, tasks] of Object.entries(columns)) {
    next[columnId] = tasks.map((task) => {
      if (task.id !== taskId) {
        return task;
      }
      changed = true;
      return updater(task);
    });
  }

  return changed ? next : columns;
}

export function findTaskInColumns(
  columns: Columns,
  taskId: string
): Task | null {
  for (const tasks of Object.values(columns)) {
    const found = tasks.find((task) => task.id === taskId);
    if (found) {
      return found;
    }
  }
  return null;
}

function findTaskColumn(
  columns: Columns,
  taskId: string
): WorkspaceColumnId | null {
  for (const columnId of WORKSPACE_COLUMN_IDS) {
    if ((columns[columnId] ?? []).some((task) => task.id === taskId)) {
      return columnId;
    }
  }
  return null;
}

function makeLabelVariant(columnId: WorkspaceColumnId): Task["labelVariant"] {
  switch (columnId) {
    case "approve":
      return "warning-light";
    case "done":
      return "success-light";
    case "in_progress":
      return "primary-light";
    default:
      return "info-light";
  }
}

/**
 * Moves a card between lanes. Returns the original object when the card is
 * absent or already in the target lane so callers can cheaply detect no-ops.
 */
function moveCard(
  columns: Columns,
  taskId: string,
  targetColumn: WorkspaceColumnId
): Columns {
  const task = findTaskInColumns(columns, taskId);
  if (!task) {
    return columns;
  }

  const sourceColumn = findTaskColumn(columns, taskId);
  if (sourceColumn === targetColumn) {
    return columns;
  }

  const next: Columns = { ...columns };
  for (const columnId of WORKSPACE_COLUMN_IDS) {
    next[columnId] = (columns[columnId] ?? []).filter(
      (entry) => entry.id !== taskId
    );
  }
  next[targetColumn] = [
    ...next[targetColumn],
    { ...task, labelVariant: makeLabelVariant(targetColumn) },
  ];

  return next;
}

function formatElapsed(startedAt: number, now: number): string {
  const elapsedMs = Math.max(now - startedAt, 0);
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function ensureRun(
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

/**
 * `step.upserted` semantics: a step id already present is replaced in place,
 * otherwise it is appended and every still-running step is closed out first.
 */
function upsertStep(
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

/**
 * Appends streamed text to a step, opening the step if it does not exist yet.
 *
 * Creating on demand matters: a delta can legitimately arrive before the event
 * that would have upserted its step (a stream starting mid-part, or a replay
 * resuming between the two log entries). Dropping it loses the first tokens of
 * the response, which is exactly what the pre-Phase-1 copy did.
 */
function appendDelta(
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
          summary: delta.slice(0, SUMMARY_MAX),
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

function extractPlanFromSteps(steps: AgentStep[]): string | null {
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

/**
 * Runs a step mutation against a card, creating the run context if this is the
 * card's first step. The lazy default mirrors pre-Phase-1 behaviour, where the
 * serve projector opened `run` with a placeholder model on the first event
 * rather than requiring an explicit `run.started`.
 */
function withRun(
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

/** Board-scoped change that must degrade to a no-op when nothing moved. */
function withColumns(board: WorkspaceBoard, columns: Columns): WorkspaceBoard {
  return columns === board.columns ? board : { ...board, columns };
}

function resolveTaskId(
  event: BoardScopedEvent,
  board: WorkspaceBoard
): string | null {
  if ("taskId" in event && typeof event.taskId === "string") {
    return event.taskId;
  }
  return board.session.currentTaskId ?? null;
}

type SessionScopedEvent = Extract<
  BoardScopedEvent,
  { type: `session.${string}` }
>;

type CardRunStepEvent = Extract<
  BoardScopedEvent,
  { type: `card.${string}` | `run.${string}` | `step.${string}` }
>;

type BoardLifecycleEvent = Extract<
  BoardScopedEvent,
  { type: `board.${string}` }
>;

function isSessionScopedEvent(
  event: BoardScopedEvent
): event is SessionScopedEvent {
  return event.type.startsWith("session.");
}

function isCardRunStepEvent(
  event: BoardScopedEvent
): event is CardRunStepEvent {
  return (
    event.type.startsWith("card.") ||
    event.type.startsWith("run.") ||
    event.type.startsWith("step.")
  );
}

/**
 * Applies one board-scoped event to one board. Returns the *same* board
 * reference when the event does not apply, which lets callers detect no-ops by
 * reference equality and keeps React re-renders cheap.
 */
/**
 * Compile-time exhaustiveness for the handler switches.
 *
 * Passing anything other than `never` here is a type error, so adding a
 * `WorkspaceEvent` variant without routing it through a handler fails the
 * build instead of silently falling through to `return board`. Type aliases
 * were tried first and proved useless: TypeScript checks an *unused* alias's
 * constraint lazily, so `Assert<Exclude<...> extends never ? true : false>`
 * passed even with a deliberately incomplete handler list.
 */
function unhandledBoardEvent(
  _event: never,
  board: WorkspaceBoard
): WorkspaceBoard {
  return board;
}

function applyBoardScopedEvent(
  board: WorkspaceBoard,
  event: BoardLifecycleEvent
): WorkspaceBoard {
  switch (event.type) {
    // ── board lifecycle ──
    case "board.moved":
      return { ...board, position: event.position };

    case "board.review_mode_set":
      return { ...board, reviewMode: event.reviewMode };

    case "board.model_set":
      return { ...board, modelSelection: event.model };

    case "board.columns_replaced":
      return { ...board, columns: normalizeColumns(event.columns) };

    case "board.session_patched":
      return { ...board, session: { ...board.session, ...event.session } };

    case "board.task_plan_updated":
      return {
        ...board,
        columns: withTaskUpdated(board.columns, event.taskId, (task) => ({
          ...task,
          plan: event.plan,
          questions: event.questions ?? task.questions,
        })),
      };

    // Structural events mutate the board *collection*, not one board's state.
    case "board.created":
    case "board.removed":
      return board;

    default:
      return unhandledBoardEvent(event, board);
  }
}

function applyCardEvent(
  board: WorkspaceBoard,
  event: CardRunStepEvent,
  now: number
): WorkspaceBoard {
  switch (event.type) {
    case "card.created": {
      const columns = normalizeColumns(board.columns);
      return {
        ...board,
        columns: {
          ...columns,
          [event.column]: [
            ...columns[event.column],
            { ...event.task, labelVariant: makeLabelVariant(event.column) },
          ],
        },
        session: { ...board.session, currentTaskId: event.taskId },
      };
    }

    case "card.queued": {
      if (!event.task) {
        return withColumns(
          board,
          moveCard(board.columns, event.taskId, event.column)
        );
      }
      const queued = moveCard(board.columns, event.taskId, "queue");
      return withColumns(
        board,
        withTaskUpdated(queued, event.taskId, (task) => event.task ?? task)
      );
    }

    case "card.started":
      return withColumns(
        board,
        moveCard(board.columns, event.taskId, "in_progress")
      );

    case "card.moved":
      return withColumns(
        board,
        moveCard(board.columns, event.taskId, event.column)
      );

    case "card.waiting_for_approval":
      return withColumns(
        board,
        moveCard(board.columns, event.taskId, "approve")
      );

    case "card.completed": {
      const columns = moveCard(board.columns, event.taskId, "done");
      const releasesTask = board.session.currentTaskId === event.taskId;
      if (columns === board.columns && !releasesTask) {
        return board;
      }
      return {
        ...board,
        columns,
        session: releasesTask
          ? { ...board.session, currentTaskId: undefined }
          : board.session,
      };
    }

    case "card.failed":
      return {
        ...board,
        columns: moveCard(board.columns, event.taskId, "done"),
        session: {
          ...board.session,
          currentTaskId: undefined,
          errorMessage: event.error,
          state: "error",
        },
      };

    case "run.started": {
      const columns = withTaskUpdated(board.columns, event.taskId, (task) => {
        const run = ensureRun(task, {
          model: event.model,
          sessionId: event.sessionId,
          startedAt: event.startedAt,
          taskTitle: event.taskTitle,
        });
        return {
          ...task,
          run: { ...run, elapsed: formatElapsed(run.startedAt ?? now, now) },
          runId: event.sessionId ?? task.runId,
        };
      });

      return {
        ...board,
        columns,
        session: {
          ...board.session,
          currentTaskId: event.taskId,
          errorMessage: undefined,
          sessionId: event.sessionId ?? board.session.sessionId,
          state: event.sessionId ? "active" : board.session.state,
        },
      };
    }

    case "step.upserted":
      return withRun(
        board,
        event.taskId,
        (run) => upsertStep(run, event.step, now),
        now
      );

    case "step.delta_appended":
      return withRun(
        board,
        event.taskId,
        (run) => appendDelta(run, event.stepId, event.delta, now),
        now
      );

    default:
      return unhandledBoardEvent(event, board);
  }
}

function applySessionEvent(
  board: WorkspaceBoard,
  event: SessionScopedEvent
): WorkspaceBoard {
  switch (event.type) {
    case "session.starting":
      return { ...board, session: { ...board.session, state: "starting" } };

    case "session.attached": {
      const taskId = event.taskId ?? board.session.currentTaskId;
      const columns = taskId
        ? withTaskUpdated(board.columns, taskId, (task) => ({
            ...task,
            runId: event.sessionId,
            run: task.run
              ? { ...task.run, sessionId: event.sessionId }
              : task.run,
          }))
        : board.columns;

      return {
        ...board,
        columns,
        session: {
          ...board.session,
          errorMessage: undefined,
          sessionId: event.sessionId,
          state: "active",
        },
      };
    }

    case "session.idle": {
      const taskId = resolveTaskId(event, board);
      if (!taskId) {
        return board;
      }

      const task = findTaskInColumns(board.columns, taskId);
      const isManualReview = board.reviewMode === "manual";
      const targetColumn: WorkspaceColumnId = isManualReview
        ? "approve"
        : "done";
      const planText = extractPlanFromSteps(task?.run?.steps ?? []);

      let columns = moveCard(board.columns, taskId, targetColumn);
      if (isManualReview && planText && task) {
        columns = withTaskUpdated(columns, taskId, (entry) => ({
          ...entry,
          plan: planText,
        }));
      }

      return {
        ...board,
        columns,
        session: {
          ...board.session,
          currentTaskId: undefined,
          state: "active",
        },
      };
    }

    case "session.error": {
      const taskId = event.taskId ?? board.session.currentTaskId;
      return {
        ...board,
        columns: taskId
          ? moveCard(board.columns, taskId, "done")
          : board.columns,
        session: {
          ...board.session,
          currentTaskId: undefined,
          errorMessage: event.error,
          state: "error",
        },
      };
    }

    case "session.timeout": {
      const taskId = event.taskId ?? board.session.currentTaskId;
      return {
        ...board,
        columns: taskId
          ? moveCard(board.columns, taskId, "done")
          : board.columns,
        session: { ...board.session, errorMessage: event.error },
      };
    }

    default:
      return board;
  }
}

/**
 * Applies one board-scoped event to one board. Returns the *same* board
 * reference when the event does not apply, which lets callers detect no-ops by
 * reference equality and keeps React re-renders cheap.
 */
export function applyEventToBoard(
  board: WorkspaceBoard,
  event: WorkspaceEvent
): WorkspaceBoard {
  if (!isBoardScopedEvent(event) || event.boardId !== board.boardId) {
    return board;
  }

  if (isSessionScopedEvent(event)) {
    return applySessionEvent(board, event);
  }

  if (isCardRunStepEvent(event)) {
    return applyCardEvent(board, event, event.ts);
  }

  return applyBoardScopedEvent(board, event);
}

/**
 * Applies a workspace-scoped event (selection + preferences) to a snapshot.
 * Board-scoped events are ignored here — route them through `applyEventToBoard`.
 */
export function applyEventToWorkspace(
  workspace: WorkspaceSnapshotInput,
  event: WorkspaceEvent
): WorkspaceSnapshotInput {
  switch (event.type) {
    case "board.selected":
      return { ...workspace, selectedBoardId: event.boardId };

    case "preference.composer_hint_dismissed":
      return {
        ...workspace,
        preferences: { ...workspace.preferences, composerHintDismissed: true },
      };

    case "preference.speech_voice_set":
      return {
        ...workspace,
        preferences: { ...workspace.preferences, speechVoiceId: event.voiceId },
      };

    case "preference.board_view_mode_set":
      return {
        ...workspace,
        preferences: { ...workspace.preferences, boardViewMode: event.mode },
      };

    case "preference.recent_model_added": {
      const existing = workspace.preferences.recentlyUsedModels ?? [];
      const withoutDuplicate = existing.filter(
        (model: ModelSelection) =>
          model.providerID !== event.model.providerID ||
          model.modelID !== event.model.modelID
      );
      return {
        ...workspace,
        preferences: {
          ...workspace.preferences,
          recentlyUsedModels: [event.model, ...withoutDuplicate].slice(0, 10),
        },
      };
    }

    default:
      return workspace;
  }
}

/**
 * Binds an opencode session id to a board.
 *
 * Shared by `apps/serve` (when the store learns a session) and `apps/web`
 * (when a prompt round-trips), so the two cannot drift on how a session binds.
 */
export function attachSession(
  board: WorkspaceBoard,
  sessionId: string,
  now: number
): WorkspaceBoard {
  return applyEventToBoard(board, {
    type: "session.attached",
    boardId: board.boardId,
    sessionId,
    taskId: board.session.currentTaskId,
    ts: now,
  });
}

/** Applies a board event across every board it targets. */
export function applyEventToBoards(
  boards: WorkspaceBoard[],
  event: WorkspaceEvent
): WorkspaceBoard[] {
  if (!("boardId" in event) || event.boardId === null) {
    return boards;
  }

  let changed = false;
  const next = boards.map((board) => {
    const updated = applyEventToBoard(board, event);
    if (updated !== board) {
      changed = true;
    }
    return updated;
  });

  return changed ? next : boards;
}
