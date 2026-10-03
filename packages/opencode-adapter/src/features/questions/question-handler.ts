import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import type { QuestionInfo } from "../events/event-stream";

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
  /**
   * The board's checkout, so the engine routes the reply to the session that
   * raised it. A board's worktree is not the directory serve was started in.
   */
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
    return (result.data ?? []) as QuestionRequest[];
  }

  async reply(input: QuestionReplyInput): Promise<void> {
    const answers = input.answers.map((a) => {
      const base: Record<string, unknown> = {};
      if (a.optionIndices && a.optionIndices.length > 0) {
        base.optionIndices = a.optionIndices;
      }
      if (a.customAnswer) {
        base.customAnswer = a.customAnswer;
      }
      return base;
    });

    await this.client.question.reply({
      requestID: input.requestID,
      answers: answers as never,
      directory: input.directory,
    });
  }

  async reject(requestID: string, directory?: string): Promise<void> {
    await this.client.question.reject({ requestID, directory });
  }
}
