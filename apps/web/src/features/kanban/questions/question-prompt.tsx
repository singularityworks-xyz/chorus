"use client";

import { CheckIcon, MessageSquareIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { questionAnswerKey } from "./answer-validation";
import type { QuestionPromptProps } from "./types";

export function QuestionPrompt({
  customAnswers,
  onCustomChange,
  onOptionToggle,
  question,
  questionIndex,
  requestKey,
  selected,
}: QuestionPromptProps) {
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
