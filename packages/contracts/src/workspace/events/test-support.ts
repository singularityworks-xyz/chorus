import { workspaceBoardSchema } from "../base/boards";
import { agentStepSchema } from "../base/tasks";
import type { WorkspaceEvent } from "../events";

const TS = 1_700_000_000_000;
const board = workspaceBoardSchema.parse({
  boardId: "board-1",
  columns: { queue: [], in_progress: [], approve: [], done: [] },
  modelSelection: null,
  position: { x: 10, y: 20 },
  repo: { directory: "/tmp/repo", worktree: "/tmp/repo" },
  reviewMode: "auto",
  session: { state: "active" },
  title: "Repo",
});
const step = agentStepSchema.parse({
  id: "step-1",
  kind: "thinking",
  status: "running",
  summary: "Thinking",
});
const EVENT_CORPUS: Record<WorkspaceEvent["type"], WorkspaceEvent> = {
  "board.created": { type: "board.created", ts: TS, boardId: "board-1", board },
  "board.moved": {
    type: "board.moved",
    ts: TS,
    boardId: "board-1",
    position: { x: 1, y: 2 },
  },
  "board.removed": { type: "board.removed", ts: TS, boardId: "board-1" },
  "board.selected": { type: "board.selected", ts: TS, boardId: "board-1" },
  "board.review_mode_set": {
    type: "board.review_mode_set",
    ts: TS,
    boardId: "board-1",
    reviewMode: "manual",
  },
  "board.model_set": {
    type: "board.model_set",
    ts: TS,
    boardId: "board-1",
    model: { providerID: "anthropic", modelID: "claude" },
  },
  "board.columns_replaced": {
    type: "board.columns_replaced",
    ts: TS,
    boardId: "board-1",
    columns: { queue: [], in_progress: [], approve: [], done: [] },
  },
  "board.session_patched": {
    type: "board.session_patched",
    ts: TS,
    boardId: "board-1",
    session: { state: "starting" },
  },
  "board.task_plan_updated": {
    type: "board.task_plan_updated",
    ts: TS,
    boardId: "board-1",
    taskId: "task-1",
    plan: "do the thing",
    questions: ["which one?"],
    questionAnswers: ["the first"],
    reviewApproved: true,
    errorMessage: null,
  },
  "card.created": {
    type: "card.created",
    ts: TS,
    boardId: "board-1",
    column: "queue",
    taskId: "task-1",
    task: {
      id: "task-1",
      label: "repo",
      labelVariant: "info-light",
      title: "Fix the bug",
    },
  },
  "card.queued": {
    type: "card.queued",
    ts: TS,
    boardId: "board-1",
    taskId: "task-1",
    column: "queue",
  },
  "card.started": {
    type: "card.started",
    ts: TS,
    boardId: "board-1",
    taskId: "task-1",
  },
  "card.moved": {
    type: "card.moved",
    ts: TS,
    boardId: "board-1",
    taskId: "task-1",
    column: "approve",
  },
  "card.reordered": {
    type: "card.reordered",
    ts: TS,
    boardId: "board-1",
    taskId: "task-1",
    column: "queue",
    beforeTaskId: null,
  },
  "card.waiting_for_approval": {
    type: "card.waiting_for_approval",
    ts: TS,
    boardId: "board-1",
    taskId: "task-1",
    kind: "permission",
    requestId: "perm-1",
  },
  "card.approval_resolved": {
    type: "card.approval_resolved",
    ts: TS,
    boardId: "board-1",
    requestId: "perm-1",
    taskId: "task-1",
  },
  "card.completed": {
    type: "card.completed",
    ts: TS,
    boardId: "board-1",
    taskId: "task-1",
  },
  "card.failed": {
    type: "card.failed",
    ts: TS,
    boardId: "board-1",
    taskId: "task-1",
    error: "boom",
  },
  "card.aborted": {
    type: "card.aborted",
    ts: TS,
    boardId: "board-1",
    taskId: "task-1",
    reason: "rejected",
  },
  "run.started": {
    type: "run.started",
    ts: TS,
    boardId: "board-1",
    taskId: "task-1",
    model: "claude",
    sessionId: "sess-1",
    startedAt: TS,
    taskTitle: "Fix the bug",
  },
  "step.upserted": {
    type: "step.upserted",
    ts: TS,
    boardId: "board-1",
    taskId: "task-1",
    step,
  },
  "step.delta_appended": {
    type: "step.delta_appended",
    ts: TS,
    boardId: "board-1",
    taskId: "task-1",
    stepId: "step-1",
    delta: "more text",
  },
  "session.attached": {
    type: "session.attached",
    ts: TS,
    boardId: "board-1",
    sessionId: "sess-1",
    taskId: "task-1",
  },
  "session.starting": { type: "session.starting", ts: TS, boardId: "board-1" },
  "session.idle": { type: "session.idle", ts: TS, boardId: "board-1" },
  "session.error": {
    type: "session.error",
    ts: TS,
    boardId: "board-1",
    error: "exploded",
  },
  "session.timeout": {
    type: "session.timeout",
    ts: TS,
    boardId: "board-1",
    error: "timed out",
  },
  "preference.recent_model_added": {
    type: "preference.recent_model_added",
    ts: TS,
    model: { providerID: "anthropic", modelID: "claude" },
  },
  "preference.default_model_set": {
    type: "preference.default_model_set",
    ts: TS,
    model: { providerID: "anthropic", modelID: "claude" },
  },
  "preference.composer_hint_dismissed": {
    type: "preference.composer_hint_dismissed",
    ts: TS,
  },
  "preference.speech_voice_set": {
    type: "preference.speech_voice_set",
    ts: TS,
    voiceId: "hannah",
  },
  "preference.board_view_mode_set": {
    type: "preference.board_view_mode_set",
    ts: TS,
    mode: "stacked",
  },
};

const ALL_TYPES = Object.keys(EVENT_CORPUS) as WorkspaceEvent["type"][];

export { ALL_TYPES, board, EVENT_CORPUS, TS };
