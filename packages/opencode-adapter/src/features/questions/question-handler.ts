import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import type { QuestionInfo } from "../events/normalizer/types";

export interface QuestionRequest {
  id: string;
  questions: QuestionInfo[];
  sessionID: string;
}

export interface QuestionReplyInput {
  answers: Array<{
    questionIndex: number;
    optionIndices?: number[];
    customAnswer?: string;
  }>;

  directory?: string;
  requestID: string;
}

function unwrap<T>(
  result: { data?: T; error?: unknown },
  operation: string
): T {
  if (result.data !== undefined) {
    return result.data;
  }
  if (result.error !== undefined) {
    throw new Error(
      `OpenCode question.${operation} failed: ${describeError(result.error)}`
    );
  }
  throw new Error(
    `OpenCode question.${operation} returned no data and no error`
  );
}

function describeError(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return String(error);
  }
  if ("message" in error && typeof error.message === "string") {
    return error.message;
  }
  return JSON.stringify(error);
}

export class QuestionHandler {
  readonly client: OpencodeClient;

  constructor(client: OpencodeClient) {
    this.client = client;
  }

  async list(directory?: string): Promise<QuestionRequest[]> {
    const result = await this.client.question.list({ directory });
    return unwrap(result, "list");
  }

  async reply(input: QuestionReplyInput): Promise<boolean> {
    const result = await this.client.question.list({
      directory: input.directory,
    });
    const request = unwrap(result, "list").find(
      ({ id }) => id === input.requestID
    );
    if (!request) {
      throw new Error("the question request is no longer pending");
    }

    const answersByQuestion = new Map(
      input.answers.map((answer) => [answer.questionIndex, answer])
    );
    if (answersByQuestion.size !== input.answers.length) {
      throw new Error("a question cannot have more than one answer entry");
    }

    const answers = request.questions.map((question, questionIndex) => {
      const answer = answersByQuestion.get(questionIndex);
      if (!answer) {
        throw new Error("every question needs an answer");
      }

      const labels = (answer.optionIndices ?? []).map((optionIndex) => {
        if (!Number.isInteger(optionIndex)) {
          throw new Error("question option indices must be integers");
        }
        const option = question.options[optionIndex];
        if (!option) {
          throw new Error("a selected question option no longer exists");
        }
        return option.label;
      });
      const customAnswer = answer.customAnswer?.trim();
      if (customAnswer && question.custom === false) {
        throw new Error("this question does not accept a custom answer");
      }
      if (customAnswer) {
        labels.push(customAnswer);
      }
      if (labels.length === 0) {
        throw new Error("every question needs at least one selected answer");
      }
      return labels;
    });

    if (answersByQuestion.size !== request.questions.length) {
      throw new Error("the answer set does not match the pending questions");
    }

    const replyResult = await this.client.question.reply({
      requestID: input.requestID,
      answers,
      directory: input.directory,
    });
    return unwrap(replyResult, "reply");
  }

  async reject(requestID: string, directory?: string): Promise<boolean> {
    const result = await this.client.question.reject({ requestID, directory });
    return unwrap(result, "reject");
  }
}
