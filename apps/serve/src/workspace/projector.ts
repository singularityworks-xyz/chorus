import {
  type AgentStep,
  applyEventToBoard,
  attachSession,
  type WorkspaceBoard,
  type WorkspaceEvent,
} from "@chorus/contracts";
import type { NormalizedAgentEvent } from "@chorus/oc-adapter";

/**
 * Boundary adapter: opencode `NormalizedAgentEvent` → Chorus `WorkspaceEvent`.
 *
 * This is the *only* place that knows what a tool call, a thinking block, or a
 * permission request looks like on the wire. Everything downstream of it — the
 * store, the event log, the WS hub, the UI — speaks `WorkspaceEvent` only
 * (spec §2 rule 5: external shapes never reach UI or storage directly).
 *
 * Reduction itself lives in `@chorus/contracts` as the pure `applyEventToBoard`.
 * The two duplicate copies that used to exist here and in
 * `apps/web/src/features/workspace/state.ts` had already drifted apart; both are
 * gone.
 */

const SUMMARY_MAX = 72;

function stepIdFor(event: NormalizedAgentEvent): string {
  if (event.partID) {
    const prefix = event.messageID ? `msg-${event.messageID}-` : "";
    return `part-${prefix}${event.partID}`;
  }
  return `${event.type}-${event.timestamp}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeToolStep(event: NormalizedAgentEvent): AgentStep {
  const step: AgentStep = {
    id: stepIdFor(event),
    kind: "tool_call",
    status: event.activity === "error" ? "error" : "done",
    summary: `${event.toolName}${event.toolState ? ` · ${event.toolState}` : ""}`,
    content: event.text,
  };

  if (event.fileDiff) {
    step.kind = "file_edit";
    step.filePath = event.fileDiff.filePath;
    step.originalContent = event.fileDiff.before;
    step.modifiedContent = event.fileDiff.after;
    step.linesAdded = event.fileDiff.additions;
    step.linesRemoved = event.fileDiff.deletions;
  }

  return step;
}

function buildStep(event: NormalizedAgentEvent): AgentStep | null {
  if (event.toolName) {
    return makeToolStep(event);
  }

  if (event.activity === "thinking") {
    return {
      id: stepIdFor(event),
      kind: "thinking",
      status: "running",
      summary: event.text?.slice(0, SUMMARY_MAX) ?? "Thinking",
      content: event.text,
    };
  }

  if (event.activity === "writing") {
    return {
      id: stepIdFor(event),
      kind: "response",
      status: "running",
      summary: event.text?.slice(0, SUMMARY_MAX) ?? "Streaming response",
      content: event.text,
    };
  }

  if (event.activity === "waiting_for_approval") {
    return {
      id: stepIdFor(event),
      kind: "response",
      status: "running",
      summary: "Awaiting approval",
      content: event.permissionID,
    };
  }

  if (event.activity === "waiting_for_question") {
    return {
      id: stepIdFor(event),
      kind: "response",
      status: "running",
      summary: event.questions?.[0]?.header ?? "Question",
      content: event.questionID,
    };
  }

  if (event.activity === "error") {
    return {
      id: stepIdFor(event),
      kind: "response",
      status: "error",
      summary: event.error ?? "Session error",
      content: event.error,
    };
  }

  return null;
}

/**
 * Translates one agent event into the ordered domain events it implies.
 *
 * A single agent event can mean several things at once — "the tool finished"
 * both appends a step *and* may move the card — so agent events are not held
 * to the 1-mutation-to-1-event rule that client mutations follow. Ordering
 * matters: the step lands before any lane move, matching prior behaviour.
 */
export function toWorkspaceEvents(
  event: NormalizedAgentEvent,
  scope: { boardId: string; taskId: string }
): WorkspaceEvent[] {
  const ts = event.timestamp;
  const events: WorkspaceEvent[] = [];

  if (event.delta && event.partID) {
    events.push({
      type: "step.delta_appended",
      boardId: scope.boardId,
      taskId: scope.taskId,
      ts,
      stepId: stepIdFor(event),
      delta: event.delta,
    });
  } else if (event.delta) {
    // A delta with no part scope cannot be merged into an existing step. Open a
    // response step that carries the text outright — routing it through
    // `buildStep` would key `content` off `event.text` and silently drop it.
    events.push({
      type: "step.upserted",
      boardId: scope.boardId,
      taskId: scope.taskId,
      ts,
      step: {
        id: `${event.type}-${ts}`,
        kind: "response",
        status: "running",
        summary: event.delta.slice(0, SUMMARY_MAX),
        content: event.delta,
      },
    });
  } else {
    const step = buildStep(event);
    if (step) {
      events.push({
        type: "step.upserted",
        boardId: scope.boardId,
        taskId: scope.taskId,
        ts,
        step,
      });
    }
  }

  switch (event.activity) {
    case "writing":
    case "thinking":
      events.push({
        type: "card.started",
        boardId: scope.boardId,
        taskId: scope.taskId,
        ts,
      });
      break;

    case "waiting_for_approval":
      events.push({
        type: "card.waiting_for_approval",
        boardId: scope.boardId,
        taskId: scope.taskId,
        ts,
        kind: "permission",
        requestId: event.permissionID,
      });
      break;

    case "waiting_for_question":
      events.push({
        type: "card.waiting_for_approval",
        boardId: scope.boardId,
        taskId: scope.taskId,
        ts,
        kind: "question",
        requestId: event.questionID,
      });
      break;

    case "idle":
      // `session.idle` carries no taskId by design — the projector resolves it
      // from `board.session.currentTaskId`.
      events.push({
        type: "session.idle",
        boardId: scope.boardId,
        ts,
      });
      break;

    case "error":
      events.push(
        event.type === "session.timeout"
          ? {
              type: "session.timeout",
              boardId: scope.boardId,
              taskId: scope.taskId,
              ts,
              error: event.error,
            }
          : {
              type: "session.error",
              boardId: scope.boardId,
              taskId: scope.taskId,
              ts,
              error: event.error,
            }
      );
      break;

    default:
      break;
  }

  return events;
}

/**
 * Applies one normalized agent event to a board.
 *
 * The guard is deliberately kept here: correlating an adapter event to a board
 * requires the session binding, which is adapter knowledge, not projector
 * knowledge.
 */
export function applyAgentEventToBoard(
  board: WorkspaceBoard,
  event: NormalizedAgentEvent
): WorkspaceBoard {
  if (
    !board.session.currentTaskId ||
    board.session.sessionId !== event.sessionID
  ) {
    return board;
  }

  const scope = {
    boardId: board.boardId,
    taskId: board.session.currentTaskId,
  };

  let next = board;
  for (const domainEvent of toWorkspaceEvents(event, scope)) {
    next = applyEventToBoard(next, domainEvent);
  }

  return next;
}

/**
 * Binds a session using the local clock. The reduction itself is the shared
 * one in `@chorus/contracts` — only the clock choice is per-app.
 */
export function attachSessionToBoard(
  board: WorkspaceBoard,
  sessionId: string
): WorkspaceBoard {
  return attachSession(board, sessionId, Date.now());
}
