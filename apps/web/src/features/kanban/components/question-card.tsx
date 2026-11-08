"use client";

import {
  acceptedCommandResponseSchema,
  apiErrorSchema,
  type PendingQuestion,
  pendingQuestionsResponseSchema,
} from "@chorus/contracts";
import { CheckIcon, Loader2Icon, MessageSquareIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";

interface QuestionCardProps {
  sessionID: string;
}

async function requireAcceptedQuestionCommand(
  response: Response,
  fallback: string
): Promise<void> {
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = apiErrorSchema.safeParse(payload);
    throw new Error(error.success ? error.data.message : fallback);
  }

  const accepted = acceptedCommandResponseSchema.safeParse(payload);
  if (!(accepted.success && accepted.data.accepted)) {
    throw new Error(
      "The server did not accept this answer. Refresh and retry."
    );
  }
}

async function fetchPendingQuestions(
  sessionID: string,
  signal?: AbortSignal
): Promise<PendingQuestion[]> {
  const response = await fetch(
    `/api/tasks/${encodeURIComponent(sessionID)}/questions`,
    { cache: "no-store", signal }
  );
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = apiErrorSchema.safeParse(payload);
    throw new Error(
      error.success
        ? error.data.message
        : "Could not load the agent's question. Try again."
    );
  }

  const parsed = pendingQuestionsResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      "The server returned an invalid question response. Refresh the board and try again."
    );
  }
  return parsed.data.questions;
}

export function QuestionCard({ sessionID }: QuestionCardProps) {
  const [questions, setQuestions] = useState<PendingQuestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Record<string, number[]>>({});
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>(
    {}
  );
  const [submitting, setSubmitting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const loadQuestions = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setLoadError(null);
      setQuestions([]);
      try {
        const pending = await fetchPendingQuestions(sessionID, signal);
        if (!signal?.aborted) {
          setQuestions(pending);
        }
      } catch (error) {
        if (!signal?.aborted) {
          setLoadError(
            error instanceof Error
              ? error.message
              : "Could not load the agent's question. Try again."
          );
        }
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
        }
      }
    },
    [sessionID]
  );

  useEffect(() => {
    const controller = new AbortController();
    loadQuestions(controller.signal);
    return () => controller.abort();
  }, [loadQuestions]);

  const handleOptionToggle = useCallback(
    (answerKey: string, oIndex: number, multiple?: boolean) => {
      setSelected((prev) => {
        const current = prev[answerKey] ?? [];
        if (multiple) {
          const next = current.includes(oIndex)
            ? current.filter((i) => i !== oIndex)
            : [...current, oIndex];
          return { ...prev, [answerKey]: next };
        }
        return { ...prev, [answerKey]: [oIndex] };
      });
    },
    []
  );

  const handleCustomChange = useCallback((answerKey: string, value: string) => {
    setCustomAnswers((prev) => ({ ...prev, [answerKey]: value }));
  }, []);

  const handleSubmit = useCallback(
    async (question: PendingQuestion) => {
      setSubmitting(true);
      setActionError(null);
      setActionMessage(null);
      try {
        const answers = question.questions.map((_q, qIndex) => {
          const answerKey = `${question.id}:${qIndex}`;
          return {
            questionIndex: qIndex,
            optionIndices: selected[answerKey] ?? [],
            customAnswer: customAnswers[answerKey] || undefined,
          };
        });

        const response = await fetch(
          `/api/tasks/${encodeURIComponent(sessionID)}/questions/${encodeURIComponent(question.id)}/reply`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ answers }),
          }
        );
        await requireAcceptedQuestionCommand(
          response,
          "Could not send your answer. Your selections are still here; try again."
        );
        setActionMessage("Answer sent. Waiting for the agent to continue…");
      } catch (error) {
        setActionError(
          error instanceof Error
            ? error.message
            : "Could not send your answer. Your selections are still here; try again."
        );
      } finally {
        setSubmitting(false);
      }
    },
    [sessionID, selected, customAnswers]
  );

  const handleReject = useCallback(
    async (question: PendingQuestion) => {
      setSubmitting(true);
      setActionError(null);
      setActionMessage(null);
      try {
        const response = await fetch(
          `/api/tasks/${encodeURIComponent(sessionID)}/questions/${encodeURIComponent(question.id)}/reject`,
          { method: "POST" }
        );
        await requireAcceptedQuestionCommand(
          response,
          "Could not dismiss the agent's question. Try again."
        );
        setActionMessage(
          "Question dismissed. Waiting for the agent to continue…"
        );
      } catch (error) {
        setActionError(
          error instanceof Error
            ? error.message
            : "Could not dismiss the agent's question. Try again."
        );
      } finally {
        setSubmitting(false);
      }
    },
    [sessionID]
  );

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-xs border border-white/5 bg-white/2 px-3 py-2">
        <Loader2Icon className="size-3 animate-spin text-white/30" />
        <span className="text-[0.7rem] text-white/30">Loading question…</span>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-col gap-2 rounded-xs border border-rose-500/15 bg-rose-500/[0.03] px-3 py-2.5">
        <p className="text-[0.7rem] text-rose-300/85" role="alert">
          {loadError}
        </p>
        <button
          className="self-start rounded-xs border border-white/10 px-2 py-1 text-[0.65rem] text-white/60 hover:bg-white/5"
          onClick={() => loadQuestions()}
          type="button"
        >
          Retry loading
        </button>
      </div>
    );
  }

  if (questions.length === 0) {
    return null;
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
      {questions.map((q) =>
        q.questions.map((qi, qiIdx) => {
          const questionKey = `${q.id}-q${qiIdx}-${qi.header}`;
          const answerKey = `${q.id}:${qiIdx}`;
          return (
            <div
              className="flex flex-col gap-2 rounded-xs border border-amber-500/10 bg-amber-500/[0.03] px-3 py-2.5"
              key={questionKey}
            >
              <div className="flex items-start gap-2">
                <MessageSquareIcon className="mt-0.5 size-3 shrink-0 text-amber-400/60" />
                <div className="min-w-0 flex-1">
                  <span className="font-medium font-mono text-[0.6rem] text-amber-400/50 uppercase tracking-wider">
                    {qi.header}
                  </span>
                  <p className="mt-0.5 text-[0.72rem] text-white/60 leading-relaxed">
                    {qi.question}
                  </p>
                </div>
              </div>

              {qi.options.length > 0 && (
                <div className="flex flex-col gap-1 pl-5">
                  {qi.options.map((opt, oIdx) => {
                    const isSelected = (selected[answerKey] ?? []).includes(
                      oIdx
                    );
                    return (
                      <button
                        className={cn(
                          "flex items-start gap-2 rounded-xs border px-2.5 py-1.5 text-left transition-colors",
                          isSelected
                            ? "border-amber-500/30 bg-amber-500/10"
                            : "border-white/5 bg-white/2 hover:bg-white/5"
                        )}
                        key={`${q.id}-${qi.header}-opt-${opt.label}`}
                        onClick={() =>
                          handleOptionToggle(answerKey, oIdx, qi.multiple)
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
                            {opt.label}
                          </span>
                          {opt.description && (
                            <p className="text-[0.62rem] text-white/35">
                              {opt.description}
                            </p>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}

              {qi.custom !== false && (
                <textarea
                  className="w-full resize-none rounded-xs border border-white/5 bg-white/2 px-2.5 py-1.5 font-mono text-[0.68rem] text-white/60 placeholder:text-white/20 focus:border-amber-500/30 focus:outline-none focus:ring-1 focus:ring-amber-500/20"
                  onChange={(e) =>
                    handleCustomChange(answerKey, e.target.value)
                  }
                  placeholder="Type a custom answer…"
                  rows={2}
                  value={customAnswers[answerKey] ?? ""}
                />
              )}

              <div className="flex items-center justify-end gap-1.5 pt-0.5">
                <button
                  className={cn(
                    "flex items-center gap-1 rounded-xs border px-2.5 py-1.5 font-medium text-[0.65rem] transition-colors",
                    submitting
                      ? "cursor-not-allowed border-white/5 bg-white/5 text-white/20"
                      : "border-rose-500/15 bg-rose-500/10 text-rose-400 hover:bg-rose-500/20"
                  )}
                  disabled={submitting}
                  onClick={() => handleReject(q)}
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
                  disabled={submitting}
                  onClick={() => handleSubmit(q)}
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
        })
      )}
    </div>
  );
}
