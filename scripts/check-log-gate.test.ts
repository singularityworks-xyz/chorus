import { describe, expect, test } from "bun:test";
import { findSensitiveLogCalls } from "./check-log-gate";

describe("log gate", () => {
  test("reports sensitive words on a logger call site", () => {
    expect(
      findSensitiveLogCalls([
        {
          path: "apps/serve/src/auth.ts",
          source: 'logger.info("token issued");',
        },
      ])
    ).toEqual(['apps/serve/src/auth.ts:1:logger.info("token issued");']);
  });

  test("ignores unrelated lines and test or declaration files", () => {
    expect(
      findSensitiveLogCalls([
        { path: "apps/serve/src/auth.ts", source: 'logger.info("ready");' },
        {
          path: "apps/serve/src/auth.test.ts",
          source: 'logger.info("token");',
        },
        { path: "apps/serve/src/types.d.ts", source: 'logger.info("token");' },
      ])
    ).toEqual([]);
  });
});
