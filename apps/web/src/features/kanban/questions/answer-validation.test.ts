import { describe, expect, test } from "bun:test";
import type { PendingQuestion } from "@chorus/contracts";
import {
  questionAnswerKey,
  validateQuestionAnswers,
} from "./answer-validation";

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
    const answerKey = questionAnswerKey(pending.id, 0, choiceQuestion);

    expect(
      validateQuestionAnswers(pending, { [answerKey]: [1] }, {})
    ).toBeNull();
  });

  test("accepts custom text when the request allows it", () => {
    const customQuestion = { ...choiceQuestion, custom: true };
    const pending = makePendingQuestion([customQuestion]);
    const answerKey = questionAnswerKey(pending.id, 0, customQuestion);

    expect(
      validateQuestionAnswers(pending, {}, { [answerKey]: "  Keep both  " })
    ).toBeNull();
  });

  test("rejects stale option indices and blank custom text", () => {
    const customQuestion = { ...choiceQuestion, custom: true };
    const pending = makePendingQuestion([customQuestion]);
    const answerKey = questionAnswerKey(pending.id, 0, customQuestion);

    expect(
      validateQuestionAnswers(
        pending,
        { [answerKey]: [12] },
        { [answerKey]: "   " }
      )
    ).toBe("Answer “Implementation” before submitting.");
  });

  test("identifies the first unanswered question in a multi-question request", () => {
    const pending = makePendingQuestion([
      choiceQuestion,
      { ...choiceQuestion, header: "Risk" },
    ]);
    const firstAnswerKey = questionAnswerKey(pending.id, 0, choiceQuestion);

    expect(
      validateQuestionAnswers(pending, { [firstAnswerKey]: [0] }, {})
    ).toBe("Answer “Risk” before submitting.");
  });

  test("does not reuse an answer when a synchronized question changes", () => {
    const oldAnswerKey = questionAnswerKey("request-1", 0, choiceQuestion);
    const changedQuestion = {
      ...choiceQuestion,
      question: "Which option should now be used?",
    };
    const pending = makePendingQuestion([changedQuestion]);

    expect(validateQuestionAnswers(pending, { [oldAnswerKey]: [0] }, {})).toBe(
      "Answer “Implementation” before submitting."
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
