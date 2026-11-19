import type { SequencedRecord } from "../../workspace/store";
import type { BufferedRecord } from "./types";

export function bufferOf(record: SequencedRecord): BufferedRecord {
  return {
    boardId: record.boardId,
    event: record.event,
    fromSeq: record.seq,
    toSeq: record.seq,
  };
}

export function mergeKeyFor(record: BufferedRecord): string {
  const event = record.event;
  if (event.type === "step.delta_appended") {
    return `${record.boardId ?? ""}|delta|${event.taskId}|${event.stepId}`;
  }
  if (event.type === "step.upserted") {
    return `${record.boardId ?? ""}|upsert|${event.taskId}|${event.step.id}`;
  }
  return `${record.boardId ?? ""}|${record.fromSeq}`;
}

export function mergeRecords(
  target: BufferedRecord,
  next: SequencedRecord
): boolean {
  // A merged frame owns every sequence in its declared range.
  if (next.seq !== target.toSeq + 1) {
    return false;
  }

  const current = target.event;
  const incoming = next.event;

  if (
    current.type === "step.delta_appended" &&
    incoming.type === "step.delta_appended"
  ) {
    if (
      current.taskId !== incoming.taskId ||
      current.stepId !== incoming.stepId
    ) {
      return false;
    }
    target.event = {
      ...current,
      delta: `${current.delta}${incoming.delta}`,
      ts: incoming.ts,
    };
    target.toSeq = next.seq;
    return true;
  }

  if (current.type === "step.upserted" && incoming.type === "step.upserted") {
    if (
      current.taskId !== incoming.taskId ||
      current.step.id !== incoming.step.id
    ) {
      return false;
    }
    target.event = { ...current, step: incoming.step, ts: incoming.ts };
    target.toSeq = next.seq;
    return true;
  }

  return false;
}
