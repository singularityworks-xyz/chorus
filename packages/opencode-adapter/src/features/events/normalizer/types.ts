import type { Message, Part } from "@opencode-ai/sdk/v2";

export type NormalizedActivity =
  | "writing"
  | "thinking"
  | "waiting_for_approval"
  | "waiting_for_question"
  | "error"
  | "idle";

export interface FileDiffInfo {
  additions?: number;
  after?: string;
  before?: string;
  deletions?: number;
  filePath: string;
}

export interface QuestionOption {
  description: string;
  label: string;
}

export interface QuestionInfo {
  custom?: boolean;
  header: string;
  multiple?: boolean;
  options: QuestionOption[];
  question: string;
}

export interface NormalizedAgentEvent {
  activity?: NormalizedActivity;
  delta?: string;
  error?: string;
  fileDiff?: FileDiffInfo;
  messageID?: string;
  partID?: string;
  partType?: "text" | "reasoning" | "tool";
  permission?: string;
  permissionID?: string;
  questionID?: string;
  questions?: QuestionInfo[];
  sessionID?: string;
  sourceEventId?: string;
  text?: string;
  timestamp: number;
  toolName?: string;
  toolState?: string;
  type: string;
}

export interface SessionMessageWithParts {
  info: Message;
  parts: Part[];
}
