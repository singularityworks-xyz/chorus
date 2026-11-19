import type { PendingApprovalRequest } from "@chorus/contracts";

export type QuestionApproval = Extract<
  PendingApprovalRequest,
  { kind: "question" }
>;
export type QuestionInfo = QuestionApproval["questions"][number];

export interface QuestionCardProps {
  requests: QuestionApproval[];
  sessionID: string;
}

export interface QuestionPromptProps {
  customAnswers: Record<string, string>;
  onCustomChange: (answerKey: string, value: string) => void;
  onOptionToggle: (
    answerKey: string,
    optionIndex: number,
    multiple?: boolean
  ) => void;
  question: QuestionInfo;
  questionIndex: number;
  requestKey: string;
  selected: Record<string, number[]>;
}

export interface QuestionRequestCardProps {
  customAnswers: Record<string, string>;
  onCustomChange: (answerKey: string, value: string) => void;
  onOptionToggle: (
    answerKey: string,
    optionIndex: number,
    multiple?: boolean
  ) => void;
  onReject: (question: QuestionApproval) => void;
  onSubmit: (question: QuestionApproval) => void;
  request: QuestionApproval;
  requestIndex: number;
  selected: Record<string, number[]>;
  submitting: boolean;
}
