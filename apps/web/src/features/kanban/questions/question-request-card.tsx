"use client";

import { CheckIcon, Loader2Icon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { QuestionPrompt } from "./question-prompt";
import type { QuestionRequestCardProps } from "./types";

export function QuestionRequestCard({
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
