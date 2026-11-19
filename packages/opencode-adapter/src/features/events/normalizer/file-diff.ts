import type { FileDiffInfo } from "./types";

function safeNum(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function safeStr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function extractCompletedDiff(
  toolName: string,
  metadata: Record<string, unknown>
): FileDiffInfo | undefined {
  if ((toolName === "edit" || toolName === "write") && metadata.filediff) {
    const filediff = metadata.filediff as Record<string, unknown>;
    return {
      additions: safeNum(filediff.additions),
      after: safeStr(filediff.after),
      before: safeStr(filediff.before),
      deletions: safeNum(filediff.deletions),
      filePath: safeStr(filediff.file) ?? "",
    };
  }

  if (toolName !== "apply_patch" || !Array.isArray(metadata.files)) {
    return undefined;
  }

  const [file] = metadata.files as Record<string, unknown>[];
  if (!file) {
    return undefined;
  }

  return {
    additions: safeNum(file.additions),
    after: safeStr(file.after),
    before: safeStr(file.before),
    deletions: safeNum(file.deletions),
    filePath: safeStr(file.filePath) ?? "",
  };
}

function extractRunningDiff(
  toolName: string,
  input: Record<string, unknown>
): FileDiffInfo | undefined {
  if (
    (toolName !== "edit" && toolName !== "write") ||
    typeof input.filePath !== "string"
  ) {
    return undefined;
  }

  const diff: FileDiffInfo = { filePath: input.filePath };
  if (
    toolName === "edit" &&
    typeof input.oldString === "string" &&
    typeof input.newString === "string"
  ) {
    diff.before = input.oldString;
    diff.after = input.newString;
  }
  return diff;
}

export function extractFileDiff(
  toolName: string,
  state: {
    input?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    status: string;
  }
): FileDiffInfo | undefined {
  if (state.status === "completed" && state.metadata) {
    return extractCompletedDiff(toolName, state.metadata);
  }
  if (state.status === "running" && state.input) {
    return extractRunningDiff(toolName, state.input);
  }
  return undefined;
}
