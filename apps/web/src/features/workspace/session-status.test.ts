import { expect, test } from "bun:test";
import { isWorkspaceSessionLive } from "./session-status";

test("authenticated workspace requests wait for a live session", () => {
  expect(isWorkspaceSessionLive("connecting")).toBe(false);
  expect(isWorkspaceSessionLive("offline")).toBe(false);
  expect(isWorkspaceSessionLive("auth-expired")).toBe(false);
  expect(isWorkspaceSessionLive("live")).toBe(true);
});
