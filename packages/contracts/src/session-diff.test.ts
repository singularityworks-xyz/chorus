import { describe, expect, test } from "bun:test";
import { sessionFileDiffsSchema } from "./session-diff";

describe("session diff contracts", () => {
  test("accepts the normalized file content shape consumed by the viewer", () => {
    expect(
      sessionFileDiffsSchema.parse([
        {
          additions: 1,
          after: "new\n",
          before: "old\n",
          deletions: 1,
          file: "src/main.ts",
        },
      ])
    ).toEqual([
      {
        additions: 1,
        after: "new\n",
        before: "old\n",
        deletions: 1,
        file: "src/main.ts",
      },
    ]);
  });

  test("rejects malformed file paths and negative counters", () => {
    expect(
      sessionFileDiffsSchema.safeParse([
        {
          additions: -1,
          after: "",
          before: "",
          deletions: 0,
          file: "src/main.ts",
        },
      ]).success
    ).toBe(false);
    expect(
      sessionFileDiffsSchema.safeParse([
        {
          additions: 0,
          after: "",
          before: "",
          deletions: 0,
          file: "",
        },
      ]).success
    ).toBe(false);
  });
});
