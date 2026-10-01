import { describe, expect, test } from "bun:test";
import type { WorkspaceSnapshot } from "@chorus/contracts";
import {
  DEFAULT_DB_SIZE_CAP_MB,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_SNAPSHOT_INTERVAL,
  isOverSizeCap,
  retentionCutoff,
  shouldSnapshot,
  stripTerminalRunDetails,
} from "./retention";

const T0 = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function snapshotWith(
  columns: WorkspaceSnapshot["boards"][number]["columns"]
): WorkspaceSnapshot {
  return {
    boards: [
      {
        boardId: "b1",
        columns,
        modelSelection: null,
        position: { x: 0, y: 0 },
        repo: { directory: "/tmp/repo", sandboxes: [], worktree: "/tmp/repo" },
        reviewMode: "auto",
        session: { state: "active" },
        title: "Repo",
      },
    ],
    preferences: {
      boardViewMode: "relaxed",
      composerHintDismissed: false,
      recentlyUsedModels: [],
      speechVoiceId: null,
    },
    previousWorkspaces: [],
    revision: 1,
    selectedBoardId: "b1",
  };
}

function run(startedAt: number, steps = 3) {
  return {
    elapsed: "1m 00s",
    model: "claude",
    startedAt,
    steps: Array.from({ length: steps }, (_unused, index) => ({
      id: `s${index}`,
      kind: "response" as const,
      status: "done" as const,
      summary: `step ${index}`,
    })),
    taskTitle: "Work",
  };
}

const EMPTY = { approve: [], done: [], in_progress: [], queue: [] };

describe("retention thresholds", () => {
  test("defaults match the spec §5 values", () => {
    expect(DEFAULT_RETENTION_DAYS).toBe(30);
    expect(DEFAULT_DB_SIZE_CAP_MB).toBe(512);
    expect(DEFAULT_SNAPSHOT_INTERVAL).toBe(1000);
  });

  test("the cutoff sits retentionDays before now", () => {
    expect(retentionCutoff(T0)).toBe(T0 - 30 * DAY);
    expect(retentionCutoff(T0, 7)).toBe(T0 - 7 * DAY);
  });

  test("a snapshot is due once the interval is reached", () => {
    expect(shouldSnapshot(0)).toBe(false);
    expect(shouldSnapshot(999)).toBe(false);
    expect(shouldSnapshot(1000)).toBe(true);
    expect(shouldSnapshot(2500)).toBe(true);
    expect(shouldSnapshot(10, 5)).toBe(true);
  });

  test("the size cap is inclusive of the boundary", () => {
    expect(isOverSizeCap(512 * 1024 * 1024)).toBe(false);
    expect(isOverSizeCap(512 * 1024 * 1024 + 1)).toBe(true);
    expect(isOverSizeCap(0)).toBe(false);
  });
});

describe("stripTerminalRunDetails", () => {
  test("compacts an old terminal run but keeps the card", () => {
    const snapshot = snapshotWith({
      ...EMPTY,
      done: [
        {
          id: "task-1",
          label: "repo",
          labelVariant: "success-light",
          run: run(T0 - 40 * DAY),
          title: "Old work",
        },
      ],
    });

    const next = stripTerminalRunDetails(snapshot, T0 - 30 * DAY);
    const card = next.boards[0]?.columns.done[0];

    expect(card?.id).toBe("task-1");
    expect(card?.title).toBe("Old work");
    expect(card?.run?.steps).toHaveLength(1);
  });

  test("keeps the last step as context", () => {
    const snapshot = snapshotWith({
      ...EMPTY,
      done: [
        {
          id: "task-1",
          label: "repo",
          labelVariant: "success-light",
          run: run(T0 - 40 * DAY, 3),
          title: "Old work",
        },
      ],
    });

    const next = stripTerminalRunDetails(snapshot, T0 - 30 * DAY);
    expect(next.boards[0]?.columns.done[0]?.run?.steps[0].summary).toBe(
      "step 2"
    );
  });

  test("leaves a recent terminal run alone", () => {
    const snapshot = snapshotWith({
      ...EMPTY,
      done: [
        {
          id: "task-1",
          label: "repo",
          labelVariant: "success-light",
          run: run(T0 - 2 * DAY),
          title: "Recent work",
        },
      ],
    });

    const next = stripTerminalRunDetails(snapshot, T0 - 30 * DAY);
    expect(next.boards[0]?.columns.done[0]?.run?.steps).toHaveLength(3);
  });

  test("treats the exact cutoff as still retained", () => {
    const cutoff = T0 - 30 * DAY;
    const snapshot = snapshotWith({
      ...EMPTY,
      done: [
        {
          id: "task-1",
          label: "repo",
          labelVariant: "success-light",
          run: run(cutoff),
          title: "Boundary",
        },
      ],
    });

    expect(
      stripTerminalRunDetails(snapshot, cutoff).boards[0]?.columns.done[0]?.run
        ?.steps
    ).toHaveLength(3);
  });

  test("also compacts the approve lane", () => {
    const snapshot = snapshotWith({
      ...EMPTY,
      approve: [
        {
          id: "task-1",
          label: "repo",
          labelVariant: "warning-light",
          run: run(T0 - 90 * DAY),
          title: "Long waiting",
        },
      ],
    });

    expect(
      stripTerminalRunDetails(snapshot, T0 - 30 * DAY).boards[0]?.columns
        .approve[0]?.run?.steps
    ).toHaveLength(1);
  });

  test("never touches active lanes", () => {
    const snapshot = snapshotWith({
      ...EMPTY,
      in_progress: [
        {
          id: "task-1",
          label: "repo",
          labelVariant: "primary-light",
          run: run(T0 - 90 * DAY),
          title: "Long running",
        },
      ],
      queue: [
        {
          id: "task-2",
          label: "repo",
          labelVariant: "info-light",
          run: run(T0 - 90 * DAY),
          title: "Long queued",
        },
      ],
    });

    const next = stripTerminalRunDetails(snapshot, T0 - 30 * DAY);
    expect(next.boards[0]?.columns.in_progress[0]?.run?.steps).toHaveLength(3);
    expect(next.boards[0]?.columns.queue[0]?.run?.steps).toHaveLength(3);
  });

  test("skips cards with no run and leaves them intact", () => {
    const snapshot = snapshotWith({
      ...EMPTY,
      done: [
        {
          id: "task-1",
          label: "repo",
          labelVariant: "success-light",
          title: "No run",
        },
      ],
    });

    expect(
      stripTerminalRunDetails(snapshot, T0 - 30 * DAY).boards[0]?.columns
        .done[0]
    ).toEqual(snapshot.boards[0]?.columns.done[0]);
  });

  test("returns the same reference when nothing is eligible", () => {
    // Lets the store skip a pointless snapshot write.
    const snapshot = snapshotWith(EMPTY);
    expect(stripTerminalRunDetails(snapshot, T0 - 30 * DAY)).toBe(snapshot);
  });

  test("does not mutate the input snapshot", () => {
    const snapshot = snapshotWith({
      ...EMPTY,
      done: [
        {
          id: "task-1",
          label: "repo",
          labelVariant: "success-light",
          run: run(T0 - 40 * DAY),
          title: "Old work",
        },
      ],
    });
    const before = structuredClone(snapshot);

    stripTerminalRunDetails(snapshot, T0 - 30 * DAY);

    expect(snapshot).toEqual(before);
  });

  test("handles a run with a missing startedAt conservatively", () => {
    const snapshot = snapshotWith({
      ...EMPTY,
      done: [
        {
          id: "task-1",
          label: "repo",
          labelVariant: "success-light",
          run: { ...run(T0 - 40 * DAY), startedAt: undefined },
          title: "Undated",
        },
      ],
    });

    // Treated as started at 0, i.e. older than any cutoff, so it is compacted.
    expect(
      stripTerminalRunDetails(snapshot, T0 - 30 * DAY).boards[0]?.columns
        .done[0]?.run?.steps
    ).toHaveLength(1);
  });
});
