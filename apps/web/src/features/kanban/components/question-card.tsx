"use client";

import type { PendingApprovalRequest } from "@chorus/contracts";
import { CheckIcon, Loader2Icon, MessageSquareIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { requireAcceptedCommand } from "../command-client";
import {
  questionAnswerKey,
  validateQuestionAnswers,
} from "../utils/question-answer-validation";

type QuestionApproval = Extract<PendingApprovalRequest, { kind: "question" }>;
type QuestionInfo = QuestionApproval["questions"][number];

interface QuestionCardProps {
  requests: QuestionApproval[];
  sessionID: string;
}

interface QuestionRequestCardProps {
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

function questionCommandError(error: unknown, action: "answer" | "dismiss") {
  const fallback =
    action === "answer"
      ? "Could not send your answer. Your selections are still here; try again."
      : "Could not dismiss the agent's question. Try again.";
  if (!(error instanceof Error)) {
    return fallback;
  }
  if (error.name === "TimeoutError") {
    return action === "answer"
      ? "The answer request timed out. Your answers are preserved; check whether the question clears before retrying."
      : "The request timed out. Check whether the question clears before trying again.";
  }
  if (error.name === "TypeError") {
    return action === "answer"
      ? "Could not reach Chorus. Your answers are preserved; check the connection before retrying."
      : "Could not reach Chorus. Check the connection before trying again.";
  }
  return error.message || fallback;
}

function QuestionRequestCard({
  customAnswers,
  onCustomChange,
  onOptionToggle,
  onReject,
  onSubmit,
  request,
  requestIndex,
  selected,
  submitting,
}: QuestionRequestCardProps) {
  const requestKey = request.requestId ?? `missing-request-${requestIndex}`;

  return (
    <div className="flex flex-col gap-2 rounded-xs border border-amber-500/10 bg-amber-500/[0.03] px-3 py-2.5">
      {request.questions.map((question, questionIndex) => (
        <QuestionPrompt
          customAnswers={customAnswers}
          key={`${requestKey}-${question.header}-${question.question}`}
          onCustomChange={onCustomChange}
          onOptionToggle={onOptionToggle}
          question={question}
          questionIndex={questionIndex}
          requestKey={requestKey}
          selected={selected}
        />
      ))}
      {!request.requestId && (
        <p className="pl-5 text-[0.65rem] text-rose-300/85" role="alert">
          This question is missing its request ID. Refresh the board before
          answering.
        </p>
      )}
      <div className="flex items-center justify-end gap-1.5 pt-0.5">
        <button
          className={cn(
            "flex items-center gap-1 rounded-xs border px-2.5 py-1.5 font-medium text-[0.65rem] transition-colors",
            submitting
              ? "cursor-not-allowed border-white/5 bg-white/5 text-white/20"
              : "border-rose-500/15 bg-rose-500/10 text-rose-400 hover:bg-rose-500/20"
          )}
          disabled={submitting || !request.requestId}
          onClick={() => onReject(request)}
          title="Skip question"
          type="button"
        >
          {submitting ? (
            <Loader2Icon className="size-3 animate-spin" />
          ) : (
            <XIcon className="size-3" />
          )}
          Skip
        </button>
        <button
          className={cn(
            "flex items-center gap-1 rounded-xs border px-2.5 py-1.5 font-medium text-[0.65rem] transition-colors",
            submitting
              ? "cursor-not-allowed border-white/5 bg-white/5 text-white/20"
              : "border-emerald-500/15 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20"
          )}
          disabled={submitting || !request.requestId}
          onClick={() => onSubmit(request)}
          title="Submit answer"
          type="button"
        >
          {submitting ? (
            <Loader2Icon className="size-3 animate-spin" />
          ) : (
            <CheckIcon className="size-3" />
          )}
          {submitting ? "Sending…" : "Answer"}
        </button>
      </div>
    </div>
  );
}

function QuestionPrompt({
  customAnswers,
  onCustomChange,
  onOptionToggle,
  question,
  questionIndex,
  requestKey,
  selected,
}: {
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
}) {
  const answerKey = questionAnswerKey(requestKey, questionIndex, question);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <MessageSquareIcon className="mt-0.5 size-3 shrink-0 text-amber-400/60" />
        <div className="min-w-0 flex-1">
          <span className="font-medium font-mono text-[0.6rem] text-amber-400/50 uppercase tracking-wider">
            {question.header}
          </span>
          <p className="mt-0.5 text-[0.72rem] text-white/60 leading-relaxed">
            {question.question}
          </p>
        </div>
      </div>
      {question.options.length > 0 && (
        <div className="flex flex-col gap-1 pl-5">
          {question.options.map((option, optionIndex) => {
            const isSelected = (selected[answerKey] ?? []).includes(
              optionIndex
            );
            return (
              <button
                className={cn(
                  "flex items-start gap-2 rounded-xs border px-2.5 py-1.5 text-left transition-colors",
                  isSelected
                    ? "border-amber-500/30 bg-amber-500/10"
                    : "border-white/5 bg-white/2 hover:bg-white/5"
                )}
                key={`${requestKey}-${question.header}-opt-${option.label}`}
                onClick={() =>
                  onOptionToggle(answerKey, optionIndex, question.multiple)
                }
                type="button"
              >
                <span
                  className={cn(
                    "mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-sm border",
                    isSelected
                      ? "border-amber-500/50 bg-amber-500/20 text-amber-400"
                      : "border-white/10 text-transparent"
                  )}
                >
                  <CheckIcon className="size-2.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <span className="font-medium text-[0.7rem] text-white/70">
                    {option.label}
                  </span>
                  {option.description && (
                    <p className="text-[0.62rem] text-white/35">
                      {option.description}
                    </p>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
      {question.custom !== false && (
        <textarea
          className="w-full resize-none rounded-xs border border-white/5 bg-white/2 px-2.5 py-1.5 font-mono text-[0.68rem] text-white/60 placeholder:text-white/20 focus:border-amber-500/30 focus:outline-none focus:ring-1 focus:ring-amber-500/20"
          onChange={(event) => onCustomChange(answerKey, event.target.value)}
          placeholder="Type a custom answer…"
          rows={2}
          value={customAnswers[answerKey] ?? ""}
        />
      )}
    </div>
  );
}

export function QuestionCard({ requests, sessionID }: QuestionCardProps) {
  const [selected, setSelected] = useState<Record<string, number[]>>({});
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>(
    {}
  );
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const submittingRef = useRef(false);

  useEffect(() => {
    const activeAnswerKeys = new Set(
      requests.flatMap((request, requestIndex) =>
        request.questions.map((question, questionIndex) =>
          questionAnswerKey(
            request.requestId ?? `missing-request-${requestIndex}`,
            questionIndex,
            question
          )
        )
      )
    );
    setSelected((previous) => {
      const next = Object.fromEntries(
        Object.entries(previous).filter(([key]) => activeAnswerKeys.has(key))
      );
      return Object.keys(next).length === Object.keys(previous).length
        ? previous
        : next;
    });
    setCustomAnswers((previous) => {
      const next = Object.fromEntries(
        Object.entries(previous).filter(([key]) => activeAnswerKeys.has(key))
      );
      return Object.keys(next).length === Object.keys(previous).length
        ? previous
        : next;
    });
  }, [requests]);

  const handleOptionToggle = useCallback(
    (answerKey: string, optionIndex: number, multiple?: boolean) => {
      setSelected((previous) => {
        const current = previous[answerKey] ?? [];
        if (multiple) {
          const next = current.includes(optionIndex)
            ? current.filter((index) => index !== optionIndex)
            : [...current, optionIndex];
          return { ...previous, [answerKey]: next };
        }
        return { ...previous, [answerKey]: [optionIndex] };
      });
    },
    []
  );

  const handleCustomChange = useCallback((answerKey: string, value: string) => {
    setCustomAnswers((previous) => ({ ...previous, [answerKey]: value }));
  }, []);

  const handleSubmit = useCallback(
    async (question: QuestionApproval) => {
      setActionError(null);
      setActionMessage(null);
      if (!question.requestId) {
        setActionError(
          "This question request is missing its ID. Refresh the board before answering."
        );
        return;
      }
      const requestID = question.requestId;
      const validationError = validateQuestionAnswers(
        {
          id: requestID,
          questions: question.questions,
          sessionID,
        },
        selected,
        customAnswers
      );
      if (validationError) {
        setActionError(validationError);
        return;
      }
      if (submittingRef.current) {
        return;
      }

      submittingRef.current = true;
      setSubmitting(true);
      try {
        const answers = question.questions.map((item, questionIndex) => {
          const answerKey = questionAnswerKey(requestID, questionIndex, item);
          return {
            questionIndex,
            optionIndices: selected[answerKey] ?? [],
            customAnswer: customAnswers[answerKey] || undefined,
          };
        });
        const response = await fetch(
          `/api/tasks/${encodeURIComponent(sessionID)}/questions/${encodeURIComponent(requestID)}/reply`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ answers }),
            signal: AbortSignal.timeout(10_000),
          }
        );
        await requireAcceptedCommand(response, {
          fallback:
            "Could not send your answer. Your selections are still here; try again.",
          rejectedMessage:
            "The server did not accept this answer. Refresh and retry.",
        });
        setActionMessage("Answer sent. Waiting for the agent to continue…");
      } catch (error) {
        setActionError(questionCommandError(error, "answer"));
      } finally {
        submittingRef.current = false;
        setSubmitting(false);
      }
    },
    [sessionID, selected, customAnswers]
  );

  const handleReject = useCallback(
    async (question: QuestionApproval) => {
      if (!question.requestId) {
        setActionError(
          "This question request is missing its ID. Refresh the board before dismissing it."
        );
        return;
      }
      if (submittingRef.current) {
        return;
      }
      submittingRef.current = true;
      setSubmitting(true);
      setActionError(null);
      setActionMessage(null);
      try {
        const response = await fetch(
          `/api/tasks/${encodeURIComponent(sessionID)}/questions/${encodeURIComponent(question.requestId)}/reject`,
          { method: "POST", signal: AbortSignal.timeout(10_000) }
        );
        await requireAcceptedCommand(response, {
          fallback: "Could not dismiss the agent's question. Try again.",
        });
        setActionMessage(
          "Question dismissed. Waiting for the agent to continue…"
        );
      } catch (error) {
        setActionError(questionCommandError(error, "dismiss"));
      } finally {
        submittingRef.current = false;
        setSubmitting(false);
      }
    },
    [sessionID]
  );

  if (requests.length === 0) {
    return (
      <div className="flex flex-col gap-2 rounded-xs border border-white/5 bg-white/2 px-3 py-2.5">
        <p className="text-[0.7rem] text-white/45" role="status">
          No active question is available. The board may be out of date.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {actionError && (
        <p
          className="rounded-xs border border-rose-500/15 bg-rose-500/[0.03] px-3 py-2 text-[0.68rem] text-rose-300/85"
          role="alert"
        >
          {actionError}
        </p>
      )}
      {actionMessage && (
        <p className="text-[0.68rem] text-white/45" role="status">
          {actionMessage}
        </p>
      )}
      {requests.map((request, requestIndex) => (
        <QuestionRequestCard
          customAnswers={customAnswers}
          key={request.requestId ?? `missing-request-${requestIndex}`}
          onCustomChange={handleCustomChange}
          onOptionToggle={handleOptionToggle}
          onReject={handleReject}
          onSubmit={handleSubmit}
          request={request}
          requestIndex={requestIndex}
          selected={selected}
          submitting={submitting}
        />
      ))}
    </div>
  );
}
