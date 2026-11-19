import { resolve } from "node:path";
import {
  findTaskInColumns,
  type Task,
  type WorkspaceBoard,
} from "@chorus/contracts";
import type { OpenCodeBridge } from "../bridge/opencode/bridge";
import type { RepositoryRegistry } from "../projects/repository-registry";
import type { StoreCommit, WorkspaceStore } from "../workspace/store";
import type { BoardSessionRegistry } from "./board-session-registry";
import { BoardLifecycleError, BoardTaskCommandError } from "./errors";
import type { SessionWatchdog } from "./session-watchdog";

export interface BoardTaskRuntime {
  boardOperations: Map<string, Promise<void>>;
  bridge: OpenCodeBridge;
  closingBoards: Set<string>;
  registry: BoardSessionRegistry;
  removals: Map<string, Promise<StoreCommit | null>>;
  repositoryRegistry: RepositoryRegistry | undefined;
  watchdog: SessionWatchdog | null;
  workspaceStore: WorkspaceStore;
}

export function assertBoardOpen(
  runtime: BoardTaskRuntime,
  boardId: string
): void {
  if (runtime.closingBoards.has(boardId)) {
    throw new BoardLifecycleError(
      "board_closing",
      "this board is closing and cannot accept commands"
    );
  }
}

export async function assertCheckoutAuthorized(
  runtime: BoardTaskRuntime,
  directory: string
): Promise<void> {
  await runtime.repositoryRegistry?.validateAuthorizedCheckout(directory);
}

export function withBoardOperation<T>(
  runtime: BoardTaskRuntime,
  boardId: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = runtime.boardOperations.get(boardId) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  runtime.boardOperations.set(boardId, current);

  return previous.then(async () => {
    try {
      return await operation();
    } finally {
      release();
      if (runtime.boardOperations.get(boardId) === current) {
        runtime.boardOperations.delete(boardId);
      }
    }
  });
}

export function requireBoardTask(
  runtime: BoardTaskRuntime,
  boardId: string,
  taskId: string
): { board: WorkspaceBoard; task: Task } {
  const board = runtime.workspaceStore.getBoard(boardId);
  const task = board ? findTaskInColumns(board.columns, taskId) : null;
  if (!(board && task)) {
    throw new BoardTaskCommandError(
      "task_not_found",
      "This task is no longer on the board. Refresh and try again."
    );
  }
  return { board, task };
}

export function hasLiveTask(
  board: WorkspaceBoard,
  excludeTaskId?: string
): boolean {
  const currentTaskId = board.session.currentTaskId;
  if (currentTaskId && currentTaskId !== excludeTaskId) {
    const currentTask = findTaskInColumns(board.columns, currentTaskId);
    if (
      currentTask &&
      !(board.columns.done ?? []).some((task) => task.id === currentTaskId)
    ) {
      return true;
    }
  }

  return (board.columns.approve ?? []).some(
    (task) =>
      task.id !== excludeTaskId &&
      task.outcome === "awaiting_review" &&
      task.reviewApproved !== true
  );
}

const TRAILING_SEPARATOR = /\/$/;

export function sameDirectory(
  left: string | null | undefined,
  right: string | null | undefined
): boolean {
  if (!(left && right)) {
    return false;
  }
  return normalize(left) === normalize(right);
}

function normalize(path: string): string {
  return resolve(path).replace(TRAILING_SEPARATOR, "");
}
