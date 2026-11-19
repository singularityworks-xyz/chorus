import type { PendingQuestion } from "@chorus/contracts";

export function questionAnswerKey(
  requestId: string,
  questionIndex: number,
  question: PendingQuestion["questions"][number]
) {
  return `${requestId}:${questionIndex}:${JSON.stringify(question)}`;
}

export function validateQuestionAnswers(
  pendingQuestion: PendingQuestion,
  selected: Record<string, number[]>,
  customAnswers: Record<string, string>
): string | null {
  for (const [questionIndex, question] of pendingQuestion.questions.entries()) {
    const answerKey = questionAnswerKey(
      pendingQuestion.id,
      questionIndex,
      question
    );
    const selectedOptions = selected[answerKey] ?? [];
    const hasValidOption = selectedOptions.some(
      (optionIndex) => optionIndex >= 0 && optionIndex < question.options.length
    );
    const hasCustomAnswer = Boolean(customAnswers[answerKey]?.trim());

    if (!question.options.length && question.custom === false) {
      return `“${question.header}” has no available answer field. Skip it or refresh the board.`;
    }
    if (!(hasValidOption || (question.custom !== false && hasCustomAnswer))) {
      return `Answer “${question.header}” before submitting.`;
    }
  }

  return null;
}
