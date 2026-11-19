import { describe, expect, test } from "bun:test";
import { createCommandItems, fuzzyMatchFiles } from "./autocomplete-search";

describe("autocomplete search", () => {
  test("matches file paths and descriptions", () => {
    const items = [
      {
        description: "Application prompt input",
        id: "/repo/prompt-input.tsx",
        label: "prompt-input.tsx",
        path: "/repo/prompt-input.tsx",
        type: "file" as const,
      },
      {
        description: "Canvas renderer",
        id: "/repo/canvas.tsx",
        label: "canvas.tsx",
        path: "/repo/canvas.tsx",
        type: "file" as const,
      },
    ];

    expect(fuzzyMatchFiles(items, "prompt").map((item) => item.id)).toEqual([
      "/repo/prompt-input.tsx",
    ]);
    expect(fuzzyMatchFiles(items, "")).toBe(items);
  });

  test("combines built-in commands, repository commands, and skills", () => {
    const items = createCommandItems(
      "review",
      [{ name: "review" }],
      [{ description: "Review changes", name: "review" }]
    );

    expect(items.map((item) => item.id).sort()).toEqual([
      "cmd:review",
      "skill:review",
    ]);
  });

  test("keeps built-in undo and redo commands searchable", () => {
    const items = createCommandItems("undo", [], []);

    expect(items.map((item) => item.id)).toEqual(["builtin:undo"]);
  });
});
