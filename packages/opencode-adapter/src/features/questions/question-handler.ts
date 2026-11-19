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

export class QuestionHandler {
  readonly client: OpencodeClient;

  constructor(client: OpencodeClient) {
    this.client = client;
  }

  async list(directory?: string): Promise<QuestionRequest[]> {
    const result = await this.client.question.list({ directory });
    return result.data ?? [];
  }

  async reply(input: QuestionReplyInput): Promise<void> {
    const result = await this.client.question.list({
      directory: input.directory,
    });
    const request = result.data?.find(({ id }) => id === input.requestID);
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

    await this.client.question.reply({
      requestID: input.requestID,
      answers,
      directory: input.directory,
    });
  }

  async reject(requestID: string, directory?: string): Promise<void> {
    await this.client.question.reject({ requestID, directory });
  }
}
