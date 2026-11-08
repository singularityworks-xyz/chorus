import { describe, expect, test } from "bun:test";
import { ChorusApiError } from "@/lib/chorus-api-error";
import {
  OPEN_FOLDER_ERROR,
  WORKSPACE_MUTATION_ERROR,
  workspaceActionErrorMessage,
  workspaceApiError,
} from "./workspace-action-error";

describe("workspace action errors", () => {
  test("preserves validated safe API messages", () => {
    const error = workspaceApiError(
      {
        code: "host_folder_picker_disabled",
        message: "Configure repository roots on this server.",
      },
      OPEN_FOLDER_ERROR
    );

    expect(error).toBeInstanceOf(ChorusApiError);
    expect(error.code).toBe("host_folder_picker_disabled");
    expect(error.message).toBe("Configure repository roots on this server.");
  });

  test("uses actionable fallbacks for malformed API errors", () => {
    const error = workspaceApiError(
      { message: "untrusted partial response" },
      OPEN_FOLDER_ERROR
    );

    expect(error.message).toBe(OPEN_FOLDER_ERROR);
    expect(workspaceActionErrorMessage(error, WORKSPACE_MUTATION_ERROR)).toBe(
      OPEN_FOLDER_ERROR
    );
  });

  test("does not expose transport details or expired-session internals", () => {
    expect(
      workspaceActionErrorMessage(
        new TypeError("socket closed at 127.0.0.1"),
        OPEN_FOLDER_ERROR
      )
    ).toBe(OPEN_FOLDER_ERROR);
    expect(
      workspaceActionErrorMessage(
        new ChorusApiError("unauthorized", "unauthorized"),
        OPEN_FOLDER_ERROR
      )
    ).toBe(OPEN_FOLDER_ERROR);
  });
});
