import {
  type AgentStep,
  applyEventToBoard,
  attachSession,
  type WorkspaceBoard,
  type WorkspaceEvent,
} from "@chorus/contracts";
import type { NormalizedAgentEvent } from "@chorus/oc-adapter";

const SUMMARY_MAX = 72;

function summaryOr(text: string | undefined, fallback: string): string {
  return text?.trim().slice(0, SUMMARY_MAX) || fallback;
}

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
    summary: summaryOr(
      `${event.toolName}${event.toolState ? ` · ${event.toolState}` : ""}`,
      "Tool call"
    ),
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
      summary: summaryOr(event.text, "Thinking"),
      content: event.text,
    };
  }

  if (event.activity === "writing") {
    return {
      id: stepIdFor(event),
      kind: "response",
      status: "running",
      summary: summaryOr(event.text, "Streaming response"),
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
      summary: summaryOr(event.questions?.[0]?.header, "Question"),
      content: event.questionID,
    };
  }

  if (event.activity === "error") {
    return {
      id: stepIdFor(event),
      kind: "response",
      status: "error",
      summary: summaryOr(event.error, "Session error"),
      content: event.error,
    };
  }

  return null;
}

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
    events.push({
      type: "step.delta_appended",
      boardId: scope.boardId,
      taskId: scope.taskId,
      ts,
      stepId: `orphan-${event.messageID ?? event.sessionID ?? "stream"}`,
      delta: event.delta,
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
        pendingApproval: {
          kind: "permission",
          permission: event.permission,
          requestId: event.permissionID,
        },
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
        pendingApproval: {
          kind: "question",
          questions: event.questions ?? [],
          requestId: event.questionID,
        },
        requestId: event.questionID,
      });
      break;

    case "idle":
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

export function attachSessionToBoard(
  board: WorkspaceBoard,
  sessionId: string
): WorkspaceBoard {
  return attachSession(board, sessionId, Date.now());
}
