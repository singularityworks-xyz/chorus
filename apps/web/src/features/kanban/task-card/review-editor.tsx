"use client";

import type { Task } from "@chorus/contracts";
import { BorderlessFileView } from "@chorus/monaco";

interface TaskCardReviewEditorProps {
  editedPlan: string;
  isManualReview: boolean;
  onExpandPlan(): void;
  onPlanChange(plan: string): void;
  onQuestionChange(index: number, value: string): void;
  questionAnswers: string[];
  task: Task;
}

export function TaskCardReviewEditor({
  editedPlan,
  isManualReview,
  onExpandPlan,
  onPlanChange,
  onQuestionChange,
  questionAnswers,
  task,
}: TaskCardReviewEditorProps) {
  if (!isManualReview) {
    return null;
  }

  return (
    <div className="flex flex-col gap-3 border-white/5 border-t pt-2.5">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="font-medium text-[0.7rem] text-amber-400 uppercase tracking-wider">
            Plan
          </span>
          <button
            className="rounded-xs border border-white/8 bg-white/5 px-2 py-0.5 text-[0.65rem] text-white/60 transition-colors hover:border-amber-400/30 hover:bg-white/10 hover:text-amber-400"
            onClick={onExpandPlan}
            type="button"
          >
            Expand
          </button>
        </div>
        <div className="min-h-[120px] w-full overflow-hidden rounded-xs border border-white/10">
          <BorderlessFileView
            className="h-full min-h-[120px]"
            filePath="plan.md"
            height="120px"
            language="markdown"
            onChange={onPlanChange}
            value={editedPlan}
          />
        </div>
      </div>
      {task.questions && task.questions.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="font-medium text-[0.7rem] text-amber-400 uppercase tracking-wider">
            Questions
          </span>
          {task.questions.map((question, index) => (
            <div className="flex flex-col gap-1" key={question}>
              <p className="text-[0.7rem] text-white/60 leading-relaxed">
                {question}
              </p>
              <input
                className="w-full rounded-xs border border-white/10 bg-white/5 px-2.5 py-1.5 font-mono text-[0.7rem] text-white/70 leading-relaxed placeholder:text-white/20 focus:border-amber-400/40 focus:outline-none"
                onChange={(event) =>
                  onQuestionChange(index, event.target.value)
                }
                placeholder="Your answer..."
                type="text"
                value={questionAnswers[index] ?? ""}
              />
            </div>
          ))}
        </div>
      )}
      {!task.plan && (
        <div className="flex flex-col items-center gap-2 py-4 text-center">
          <span className="text-[0.72rem] text-white/30">
            Waiting for AI to generate a plan...
          </span>
        </div>
      )}
      {task.errorMessage && (
        <p
          className="rounded-xs border border-rose-500/15 bg-rose-500/[0.03] px-2.5 py-2 text-[0.68rem] text-rose-300/85 leading-relaxed"
          role="status"
        >
          {task.errorMessage}
        </p>
      )}
    </div>
  );
}
