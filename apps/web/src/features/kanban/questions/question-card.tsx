"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { requireAcceptedCommand } from "../command-client";
import {
  questionAnswerKey,
  validateQuestionAnswers,
} from "./answer-validation";
import { QuestionRequestCard } from "./question-request-card";
import type { QuestionApproval, QuestionCardProps } from "./types";

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
