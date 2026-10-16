import { describe, expect, test } from "bun:test";
import type { SnapshotFileDiff } from "@opencode-ai/sdk/v2";
import { normalizeSessionDiff } from "./session-diff";

describe("normalizeSessionDiff", () => {
  test("reconstructs full original content for a modified file", async () => {
    const files: SnapshotFileDiff[] = [
      {
        additions: 1,
        deletions: 1,
        file: "src/main.ts",
        patch:
          "diff --git a/src/main.ts b/src/main.ts\n@@ -1,3 +1,3 @@\n first\n-old\n+new\n last\n",
        status: "modified",
      },
    ];

    const result = await normalizeSessionDiff(files, async () => ({
      content: "first\nnew\nlast\n",
      type: "text",
    }));

    expect(result).toEqual([
      {
        additions: 1,
        after: "first\nnew\nlast\n",
        before: "first\nold\nlast\n",
        deletions: 1,
        file: "src/main.ts",
      },
    ]);
  });

  test("uses current file content for additions and reconstructs deletions", async () => {
    const result = await normalizeSessionDiff(
      [
        {
          additions: 1,
          deletions: 0,
          file: "added.txt",
          patch: "@@ -0,0 +1 @@\n+new\n",
          status: "added",
        },
        {
          additions: 0,
          deletions: 1,
          file: "removed.txt",
          patch: "@@ -1 +0,0 @@\n-old\n",
          status: "deleted",
        },
      ],
      async (path) => ({
        content: `${path}\n`,
        type: "text",
      })
    );

    expect(result).toEqual([
      {
        additions: 1,
        after: "added.txt\n",
        before: "",
        deletions: 0,
        file: "added.txt",
      },
      {
        additions: 0,
        after: "",
        before: "old\n",
        deletions: 1,
        file: "removed.txt",
      },
    ]);
  });

  test("refuses paths that could escape the project root", async () => {
    await expect(
      normalizeSessionDiff(
        [
          {
            additions: 1,
            deletions: 0,
            file: "../.env",
            patch: "@@ -0,0 +1 @@\n+secret\n",
            status: "added",
          },
        ],
        async () => ({ content: "", type: "text" })
      )
    ).rejects.toThrow("unsafe session diff path");
  });
});
