import { describe, expect, test } from "bun:test";
import type { PendingQuestion } from "@chorus/contracts";
import { validateQuestionAnswers } from "./question-answer-validation";

function makePendingQuestion(
  questions: PendingQuestion["questions"]
): PendingQuestion {
  return {
    id: "request-1",
    questions,
    sessionID: "session-1",
  };
}

const choiceQuestion = {
  custom: false,
  header: "Implementation",
  options: [
    { description: "", label: "Keep it simple" },
    { description: "", label: "Add a fallback" },
  ],
  question: "Which option should be used?",
};

describe("validateQuestionAnswers", () => {
  test("requires an answer for each question", () => {
    const pending = makePendingQuestion([choiceQuestion]);

    expect(validateQuestionAnswers(pending, {}, {})).toBe(
      "Answer “Implementation” before submitting."
    );
  });

  test("accepts an in-range option selection", () => {
    const pending = makePendingQuestion([choiceQuestion]);

    expect(
      validateQuestionAnswers(pending, { "request-1:0": [1] }, {})
    ).toBeNull();
  });

  test("accepts custom text when the request allows it", () => {
    const pending = makePendingQuestion([{ ...choiceQuestion, custom: true }]);

    expect(
      validateQuestionAnswers(pending, {}, { "request-1:0": "  Keep both  " })
    ).toBeNull();
  });

  test("rejects stale option indices and blank custom text", () => {
    const pending = makePendingQuestion([{ ...choiceQuestion, custom: true }]);

    expect(
      validateQuestionAnswers(
        pending,
        { "request-1:0": [12] },
        { "request-1:0": "   " }
      )
    ).toBe("Answer “Implementation” before submitting.");
  });

  test("identifies the first unanswered question in a multi-question request", () => {
    const pending = makePendingQuestion([
      choiceQuestion,
      { ...choiceQuestion, header: "Risk" },
    ]);

    expect(validateQuestionAnswers(pending, { "request-1:0": [0] }, {})).toBe(
      "Answer “Risk” before submitting."
    );
  });

  test("reports an unanswerable question clearly", () => {
    const pending = makePendingQuestion([
      { ...choiceQuestion, custom: false, options: [] },
    ]);

    expect(validateQuestionAnswers(pending, {}, {})).toBe(
      "“Implementation” has no available answer field. Skip it or refresh the board."
    );
  });
});
