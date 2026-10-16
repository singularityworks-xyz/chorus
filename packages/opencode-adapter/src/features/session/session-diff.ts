import type { SnapshotFileDiff } from "@opencode-ai/sdk/v2";

const DRIVE_PATH_PATTERN = /^[A-Za-z]:/;
const CARRIAGE_RETURN_PATTERN = /\r$/;
const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const CRLF_PATTERN = /\r\n/g;

export interface SessionFileDiff {
  additions: number;
  after: string;
  before: string;
  deletions: number;
  file: string;
}

interface DiffLine {
  kind: "add" | "context" | "remove";
  text: string;
  withoutNewline: boolean;
}

interface DiffHunk {
  lines: DiffLine[];
  newStart: number;
}

interface ReadFileResult {
  content: string;
  type: "binary" | "text";
}

function safeRelativePath(file: string): string {
  const path = file.replaceAll("\\", "/");
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    DRIVE_PATH_PATTERN.test(path) ||
    path.split("/").some((part) => part === ".." || part === "")
  ) {
    throw new Error("OpenCode returned an unsafe session diff path");
  }
  return path;
}

function parseHunks(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | undefined;

  for (const rawLine of patch.split("\n")) {
    const line = rawLine.replace(CARRIAGE_RETURN_PATTERN, "");
    const header = HUNK_HEADER_PATTERN.exec(line);
    if (header) {
      current = { newStart: Number(header[2]), lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) {
      continue;
    }
    if (line === "\\ No newline at end of file") {
      const previous = current.lines.at(-1);
      if (previous) {
        previous.withoutNewline = true;
      }
      continue;
    }

    const marker = line[0];
    if (marker === " " || marker === "+" || marker === "-") {
      let kind: DiffLine["kind"];
      if (marker === " ") {
        kind = "context";
      } else if (marker === "+") {
        kind = "add";
      } else {
        kind = "remove";
      }
      current.lines.push({
        kind,
        text: line.slice(1),
        withoutNewline: false,
      });
    }
  }

  return hunks;
}

function splitContent(content: string): {
  lines: string[];
  trailingNewline: boolean;
} {
  const normalized = content.replace(CRLF_PATTERN, "\n");
  const trailingNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (trailingNewline) {
    lines.pop();
  }
  return { lines, trailingNewline };
}

function compose(lines: string[], trailingNewline: boolean): string {
  if (lines.length === 0) {
    return "";
  }
  const content = lines.join("\n");
  return trailingNewline ? `${content}\n` : content;
}

function reconstructBefore(after: string, hunks: DiffHunk[]): string {
  const source = splitContent(after);
  const beforeLines: string[] = [];
  let sourceIndex = 0;
  let oldFileWithoutNewline = false;

  for (const hunk of hunks) {
    const hunkSourceStart = Math.max(0, hunk.newStart - 1);
    while (sourceIndex < hunkSourceStart) {
      const unchanged = source.lines[sourceIndex];
      if (unchanged === undefined) {
        throw new Error("OpenCode returned an inconsistent session diff");
      }
      beforeLines.push(unchanged);
      sourceIndex += 1;
    }

    for (const line of hunk.lines) {
      if (line.kind === "remove") {
        beforeLines.push(line.text);
        oldFileWithoutNewline ||= line.withoutNewline;
        continue;
      }

      const current = source.lines[sourceIndex];
      if (current !== line.text) {
        throw new Error("Session diff no longer matches the checkout contents");
      }
      sourceIndex += 1;
      if (line.kind === "context") {
        beforeLines.push(line.text);
        oldFileWithoutNewline ||= line.withoutNewline;
      }
    }
  }

  beforeLines.push(...source.lines.slice(sourceIndex));
  return compose(
    beforeLines,
    oldFileWithoutNewline ? false : source.trailingNewline
  );
}

function reconstructDeleted(hunks: DiffHunk[]): string {
  const lines = hunks.flatMap((hunk) =>
    hunk.lines.filter((line) => line.kind !== "add").map((line) => line.text)
  );
  const lastLine = hunks.flatMap((hunk) => hunk.lines).at(-1);
  const withoutNewline = lastLine?.withoutNewline ?? false;
  // A deleted file has no live content to read. OpenCode emits its removed
  // lines in the patch; preserve them so the diff remains useful after deletion.
  return compose(lines, !withoutNewline && lines.length > 0);
}

/** Converts SDK patches into the content pair consumed by Chorus's diff viewer. */
export async function normalizeSessionDiff(
  entries: SnapshotFileDiff[],
  readFile: (path: string) => Promise<ReadFileResult>
): Promise<SessionFileDiff[]> {
  const normalized: SessionFileDiff[] = [];

  for (const entry of entries) {
    if (!entry.file) {
      continue;
    }
    const file = safeRelativePath(entry.file);
    const patch = typeof entry.patch === "string" ? entry.patch : "";
    const hunks = parseHunks(patch);
    const status = entry.status ?? "modified";

    if (status === "deleted") {
      normalized.push({
        additions: entry.additions,
        after: "",
        before: reconstructDeleted(hunks),
        deletions: entry.deletions,
        file,
      });
      continue;
    }

    const current = await readFile(file);
    if (current.type !== "text") {
      continue;
    }
    const after = current.content;
    normalized.push({
      additions: entry.additions,
      after,
      before: status === "added" ? "" : reconstructBefore(after, hunks),
      deletions: entry.deletions,
      file,
    });
  }

  return normalized;
}
