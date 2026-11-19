import { describe, expect, test } from "bun:test";
import type { OpencodeModelSummary } from "@chorus/contracts";
import { ChorusApiError } from "@/lib/chorus-api-error";
import {
  modelCatalogLoadErrorMessage,
  preserveAvailableModelSelection,
  promptSubmissionErrorMessage,
} from "./prompt-input";

const availableModel: OpencodeModelSummary = {
  attachment: false,
  connected: true,
  modelID: "swift",
  name: "Swift",
  providerID: "fixture",
  providerName: "Fixture",
  reasoning: false,
  releaseDate: "",
  temperature: false,
  toolCall: false,
};

describe("prompt model state", () => {
  test("preserves only a selected model still present in the catalog", () => {
    const models = [availableModel];

    expect(preserveAvailableModelSelection("", models)).toBe("");
    expect(preserveAvailableModelSelection("fixture/swift", models)).toBe(
      "fixture/swift"
    );
    expect(preserveAvailableModelSelection("fixture/retired", models)).toBe("");
  });

  test("explains catalog timeouts separately from other failures", () => {
    expect(
      modelCatalogLoadErrorMessage(new DOMException("late", "TimeoutError"))
    ).toContain("timed out");
    expect(modelCatalogLoadErrorMessage(new Error("offline"))).toContain(
      "Could not load models"
    );
  });
});

describe("prompt submission errors", () => {
  test("gives setup guidance when the global model is missing", () => {
    expect(
      promptSubmissionErrorMessage(
        new ChorusApiError("global_model_not_configured", "Choose a model")
      )
    ).toContain("Settings");
  });

  test("keeps safe server messages and gives a retry warning for unknown errors", () => {
    expect(
      promptSubmissionErrorMessage(new ChorusApiError("failed", "Try again"))
    ).toBe("Try again");
    expect(promptSubmissionErrorMessage(new Error("offline"))).toContain(
      "your draft is still here"
    );
  });
});
