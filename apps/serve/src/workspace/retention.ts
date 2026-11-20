import type { WorkspaceSnapshot } from "@chorus/contracts";

export const DEFAULT_RETENTION_DAYS = 30;
export const DEFAULT_DB_SIZE_CAP_MB = 512;
export const DEFAULT_SNAPSHOT_INTERVAL = 1000;
export const MUTATION_ID_RETENTION_MS = 24 * 60 * 60 * 1000;

const TERMINAL_COLUMNS = ["done", "approve"] as const;

export interface RetentionOptions {
  dbSizeCapMb?: number;
  retentionDays?: number;

  snapshotInterval?: number;
}

export interface RetentionDecision {
  shouldCompact: boolean;

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
