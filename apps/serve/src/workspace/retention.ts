import type { WorkspaceSnapshot } from "@chorus/contracts";

/**
 * Retention policy (spec §5).
 *
 * Terminal-run *detail* is pruned after `RETENTION_DAYS`; card and board records
 * persist until the board is deleted. So a 40-day-old finished run loses its
 * step transcript — the agent's thinking, tool calls, and streamed deltas — but
 * the card itself, its title, and its diff summary stay on the canvas. That is
 * the difference between a log that bounds its own growth and one that quietly
 * deletes the operator's history.
 *
 * Pure functions, deliberately: the math is unit-testable without a database,
 * and the store stays responsible only for calling them and snapshotting.
 */

export const DEFAULT_RETENTION_DAYS = 30;
export const DEFAULT_DB_SIZE_CAP_MB = 512;
export const DEFAULT_SNAPSHOT_INTERVAL = 1000;
export const MUTATION_ID_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Lanes whose runs are terminal and therefore eligible for detail pruning. */
const TERMINAL_COLUMNS = ["done", "approve"] as const;

export interface RetentionOptions {
  /** Compacts the log when the database file exceeds this many megabytes. */
  dbSizeCapMb?: number;
  retentionDays?: number;
  /** Snapshot every N appended events. */
  snapshotInterval?: number;
}

export interface RetentionDecision {
  /** True when the database file is over its cap and needs compacting. */
  shouldCompact: boolean;
  /** True when the snapshot should be written before appending more events. */
  shouldSnapshot: boolean;
}

export function retentionCutoff(
  now: number,
  retentionDays = DEFAULT_RETENTION_DAYS
): number {
  return now - retentionDays * 24 * 60 * 60 * 1000;
}

export function shouldSnapshot(
  eventsSinceSnapshot: number,
  interval = DEFAULT_SNAPSHOT_INTERVAL
): boolean {
  return eventsSinceSnapshot >= interval;
}

export function isOverSizeCap(
  dbSizeBytes: number,
  capMb = DEFAULT_DB_SIZE_CAP_MB
): boolean {
  return dbSizeBytes > capMb * 1024 * 1024;
}

/**
 * Strips step transcripts from terminal runs older than `cutoff`, leaving the
 * cards themselves intact. Returns the same snapshot reference when nothing is
 * eligible, so the caller can skip a pointless snapshot write.
 */
export function stripTerminalRunDetails(
  snapshot: WorkspaceSnapshot,
  cutoff: number
): WorkspaceSnapshot {
  let changed = false;

  const boards = snapshot.boards.map((board) => {
    const columns = { ...board.columns };
    let boardChanged = false;

    for (const columnId of TERMINAL_COLUMNS) {
      const tasks = columns[columnId];
      if (!tasks) {
        continue;
      }

      let columnChanged = false;
      const nextTasks = tasks.map((task) => {
        const run = task.run;
        if (!run || run.steps.length === 0) {
          return task;
        }

        const startedAt = run.startedAt ?? 0;
        if (startedAt >= cutoff) {
          return task;
        }

        columnChanged = true;
        // Keep the last line of context so the card still shows *something*
        // meaningful, rather than an empty transcript.
        const tail = run.steps.at(-1);
        return {
          ...task,
          run: {
            ...run,
            steps: [
              {
                id: `${run.taskTitle}-compacted`,
                kind: tail?.kind ?? "response",
                status: "done" as const,
                summary:
                  tail?.summary ??
                  `Run detail compacted after ${DEFAULT_RETENTION_DAYS} days`,
              },
            ],
          },
        };
      });

      if (columnChanged) {
        columns[columnId] = nextTasks;
        boardChanged = true;
      }
    }

    if (!boardChanged) {
      return board;
    }

    changed = true;
    return { ...board, columns };
  });

  return changed ? { ...snapshot, boards } : snapshot;
}
