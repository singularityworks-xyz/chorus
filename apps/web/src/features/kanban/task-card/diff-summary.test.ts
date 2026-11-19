import { describe, expect, test } from "bun:test";
import type { AgentStep } from "../agent-output/types";
import { computeDiffTotals, extractChangedFiles } from "./diff-summary";

function editStep(
  id: string,
  filePath: string,
  linesAdded: number,
  linesRemoved: number
): AgentStep {
  return {
    filePath,
    id,
    kind: "file_edit",
    linesAdded,
    linesRemoved,
    status: "done",
    summary: `Updated ${filePath}`,
  };
}

describe("task diff summaries", () => {
  test("combines repeated edits by path and counts each file once", () => {
    const steps = [
      editStep("edit-1", "src/feature.ts", 2, 1),
      editStep("edit-2", "src/feature.ts", 3, 0),
      editStep("edit-3", "src/other.ts", 0, 4),
    ];

    expect(extractChangedFiles(steps)).toEqual([
      { added: 5, path: "src/feature.ts", removed: 1 },
      { added: 0, path: "src/other.ts", removed: 4 },
    ]);
    expect(computeDiffTotals(steps)).toEqual({
      added: 5,
      fileCount: 2,
      removed: 5,
    });
  });
});
