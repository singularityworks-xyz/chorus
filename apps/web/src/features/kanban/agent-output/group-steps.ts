import type { AgentStep } from "./types";

export interface GroupedThinkingStep {
  content: string;
  id: string;
  kind: "thinking";
  sourceSteps: AgentStep[];
  status: AgentStep["status"];
  summary: string;
}

export interface GroupedResponseStep {
  content: string;
  id: string;
  kind: "response";
  sourceSteps: AgentStep[];
  status: AgentStep["status"];
  summary: string;
}

export interface GroupedFileEditStep {
  kind: "file_edit";
  step: AgentStep;
}

export interface GroupedToolCallStep {
  kind: "tool_call";
  step: AgentStep;
}

export interface GroupedCommandStep {
  kind: "command";
  step: AgentStep;
}

export type GroupedStep =
  | GroupedThinkingStep
  | GroupedResponseStep
  | GroupedFileEditStep
  | GroupedToolCallStep
  | GroupedCommandStep;

function isMergeableKind(kind: AgentStep["kind"]): boolean {
  return kind === "thinking" || kind === "response";
}

function mergeSteps(steps: AgentStep[]): {
  id: string;
  status: AgentStep["status"];
  summary: string;
  content: string;
} {
  const runningStep = steps.find((s) => s.status === "running");
  const hasError = steps.some((s) => s.status === "error");
  const contents = steps.map((s) => s.content).filter((c): c is string => !!c);
  const summaries = steps
    .map((s) => s.summary)
    .filter((s) => s !== "Thinking" && s !== "Streaming response");

  return {
    id: steps[0].id,
    status: hasError ? "error" : (runningStep?.status ?? "done"),
    summary: summaries[0] ?? steps[0].summary,
    content: contents.join("\n\n"),
  };
}

export function groupSteps(steps: AgentStep[]): GroupedStep[] {
  const result: GroupedStep[] = [];
  let mergeBuffer: AgentStep[] = [];
  let mergeKind: AgentStep["kind"] | null = null;

  function flushBuffer() {
    if (mergeBuffer.length === 0) {
      return;
    }

    if (mergeBuffer.length === 1) {
      const step = mergeBuffer[0];
      switch (step.kind) {
        case "thinking":
          result.push({
            kind: "thinking",
            id: step.id,
            status: step.status,
            summary: step.summary,
            content: step.content ?? "",
            sourceSteps: [step],
          });
          break;
        case "response":
          result.push({
            kind: "response",
            id: step.id,
            status: step.status,
            summary: step.summary,
            content: step.content ?? "",
            sourceSteps: [step],
          });
          break;
        case "file_edit":
          result.push({ kind: "file_edit", step });
          break;
        case "tool_call":
          result.push({ kind: "tool_call", step });
          break;
        case "command":
          result.push({ kind: "command", step });
          break;
        default:
          break;
      }
    } else if (mergeKind === "thinking") {
      const merged = mergeSteps(mergeBuffer);
      result.push({
        kind: "thinking",
        ...merged,
        sourceSteps: [...mergeBuffer],
      });
    } else if (mergeKind === "response") {
      const merged = mergeSteps(mergeBuffer);
      result.push({
        kind: "response",
        ...merged,
        sourceSteps: [...mergeBuffer],
      });
    }

    mergeBuffer = [];
    mergeKind = null;
  }

  for (const step of steps) {
    if (isMergeableKind(step.kind)) {
      if (mergeKind === step.kind) {
        mergeBuffer.push(step);
      } else {
        flushBuffer();
        mergeKind = step.kind;
        mergeBuffer = [step];
      }
    } else {
      flushBuffer();
      switch (step.kind) {
        case "file_edit":
          result.push({ kind: "file_edit", step });
          break;
        case "tool_call":
          result.push({ kind: "tool_call", step });
          break;
        case "command":
          result.push({ kind: "command", step });
          break;
        default:
          break;
      }
    }
  }

  flushBuffer();
  return result;
}
