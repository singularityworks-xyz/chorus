import { expect, test } from "bun:test";
import { findSdkImports } from "./check-import-boundaries";

test("finds SDK root, subpath, type, and dynamic imports", () => {
  const source = [
    'import type { Client } from "@opencode-ai/sdk/v2/client";',
    'export { createClient } from "@opencode-ai/sdk/client";',
    'const client = await import("@opencode-ai/sdk/v2");',
    'const server = require("@opencode-ai/sdk/server");',
    'type SDK = import("@opencode-ai/sdk/v2/types").Client;',
  ].join("\n");

  expect(findSdkImports(source, "outside.ts")).toEqual([1, 2, 3, 4, 5]);
});

test("ignores comments, strings, and similarly named packages", () => {
  const source = [
    '// import { createClient } from "@opencode-ai/sdk";',
    'const note = "require(\\"@opencode-ai/sdk/v2\\")";',
    'import client from "@opencode-ai/sdk-extra";',
    'import client from "@opencode-ai/sdkish/v2";',
  ].join("\n");

  expect(findSdkImports(source, "outside.ts")).toEqual([]);
});
