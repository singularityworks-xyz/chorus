import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QuestionCard } from "./question-card";

const question = {
  custom: false,
  header: "Implementation",
  options: [{ description: "", label: "Keep it simple" }],
  question: "Which option should be used?",
};

describe("QuestionCard", () => {
  test("renders synchronized pending question data immediately", () => {
    const markup = renderToStaticMarkup(
      <QuestionCard
        requests={[
          { kind: "question", requestId: "question-1", questions: [question] },
        ]}
        sessionID="session-1"
      />
    );

    expect(markup).toContain("Which option should be used?");
    expect(markup).toContain("Keep it simple");
    expect(markup).not.toContain("Loading question");
    expect(markup).not.toContain("No active question is available");
  });

  test("disables actions and explains when a synchronized request has no ID", () => {
    const markup = renderToStaticMarkup(
      <QuestionCard
        requests={[{ kind: "question", questions: [question] }]}
        sessionID="session-1"
      />
    );

    expect(markup).toContain("missing its request ID");
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
  });
});
