import type {
  BoardSessionHistoryCommand,
  BoardTaskFinalizeReviewInput,
  QueueBoardPromptInput,
  WorkspaceMutation,
} from "@chorus/contracts";
import type { OpenCodeBridge } from "../bridge/opencode/bridge";
import type { RepositoryRegistry } from "../projects/repository-registry";
import type { StoreCommit, WorkspaceStore } from "../workspace/store";
import { BoardSessionRegistry } from "./board-session-registry";
import { BoardSessionHistory } from "./history/service";
import { BoardTaskLifecycle } from "./lifecycle/service";
import { BoardTaskQueue } from "./queue/service";
import { BoardTaskReview } from "./review/service";
import type { BoardTaskRuntime } from "./runtime";
import type { SessionWatchdog } from "./session-watchdog";

export class BoardTaskService {
  readonly #runtime: BoardTaskRuntime;
  readonly #history: BoardSessionHistory;
  readonly #lifecycle: BoardTaskLifecycle;
  readonly #queue: BoardTaskQueue;
  readonly #review: BoardTaskReview;

  constructor(
    bridge: OpenCodeBridge,
    workspaceStore: WorkspaceStore,
    registry = new BoardSessionRegistry(),
    watchdog: SessionWatchdog | null = null,
    repositoryRegistry?: RepositoryRegistry
  ) {
    const runtime: BoardTaskRuntime = {
      boardOperations: new Map(),
      bridge,
      closingBoards: new Set(),
      registry,
      removals: new Map<string, Promise<StoreCommit | null>>(),
      repositoryRegistry,
      watchdog,
      workspaceStore,
    };
    this.#runtime = runtime;
    this.#history = new BoardSessionHistory(runtime);
    this.#lifecycle = new BoardTaskLifecycle(runtime);
    this.#queue = new BoardTaskQueue(runtime);
    this.#review = new BoardTaskReview(runtime);
  }

  get registry() {
    return this.#runtime.registry;
  }

  getWorkspaceSnapshot() {
    return this.#runtime.workspaceStore.getSnapshot();
  }

  getSessionHistoryState(boardId: string) {
    return this.#history.getSessionHistoryState(boardId);
  }

  sessionHistoryCommand(boardId: string, command: BoardSessionHistoryCommand) {
    return this.#history.sessionHistoryCommand(boardId, command);
  }

  assertBoardOpen(boardId: string): void {
    this.#lifecycle.assertBoardOpen(boardId);
  }

  assertCheckoutAuthorized(directory: string): Promise<void> {
    return this.#lifecycle.assertCheckoutAuthorized(directory);
  }

  removeBoard(
    mutation: Extract<WorkspaceMutation, { type: "board.remove" }>
  ): Promise<StoreCommit | null> {
    return this.#lifecycle.removeBoard(mutation);
  }

  queuePrompt(rawInput: QueueBoardPromptInput) {
    return this.#queue.queuePrompt(rawInput);
  }

  runQueuedTask(boardId: string, taskId: string) {
    return this.#queue.runQueuedTask(boardId, taskId);
  }

  retryTask(boardId: string, taskId: string) {
    return this.#queue.retryTask(boardId, taskId);
  }

  abortTask(boardId: string, taskId: string) {
    return this.#lifecycle.abortTask(boardId, taskId);
  }

  finalizeReview(
    boardId: string,
    taskId: string,
    input: BoardTaskFinalizeReviewInput
  ) {
    return this.#review.finalizeReview(boardId, taskId, input);
  }

  rejectReview(boardId: string, taskId: string) {
    return this.#review.rejectReview(boardId, taskId);
  }
}
