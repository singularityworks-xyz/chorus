import { describe, expect, test } from "bun:test";
import { inferDiffLanguage } from "./diff-language";

describe("inferDiffLanguage", () => {
  test("maps supported source extensions", () => {
    expect(inferDiffLanguage("src/feature.tsx")).toBe("typescript");
    expect(inferDiffLanguage("scripts/deploy.sh")).toBe("shell");
    expect(inferDiffLanguage("docs/guide.MD")).toBe("markdown");
  });

  test("uses plaintext for missing and unknown extensions", () => {
    expect(inferDiffLanguage()).toBe("plaintext");
    expect(inferDiffLanguage("assets/data.unknown")).toBe("plaintext");
  });
});
