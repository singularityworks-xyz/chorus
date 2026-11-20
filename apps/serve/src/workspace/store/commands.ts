import type {
  WorkspaceBoard,
  WorkspaceEvent,
  WorkspaceMutation,
  WorkspaceSnapshot,
} from "@chorus/contracts";
import type { RepositoryRegistry } from "../../projects/repository-registry";
import type { MetaChange } from "../database/types";
import type { ChorusDatabase } from "../db";
import { attachSessionToBoard } from "../projector";
import { WorkspaceMutationProcessor, worktreeCleanupKey } from "./mutations";
import { diffSessionEvent } from "./projection";
import type { StoreCommit, WorktreeProvisioner } from "./types";

interface WorkspaceCommandServiceOptions {
  commit(
    events: WorkspaceEvent[],
    boardId: string | null,
    mutationKey: { id: string; ts: number } | null,
    metaChanges?: MetaChange[]
  ): StoreCommit;
  database: ChorusDatabase;
  enqueue<T>(work: () => Promise<T>): Promise<T>;
  getBoard(boardId: string): WorkspaceBoard | undefined;
  getSnapshot(): WorkspaceSnapshot;
  repositoryRegistry?: RepositoryRegistry;
  worktreeProvisioner?: WorktreeProvisioner;
}

export class WorkspaceCommandService {
  readonly #database: ChorusDatabase;
  readonly #enqueue: WorkspaceCommandServiceOptions["enqueue"];
  readonly #getBoard: WorkspaceCommandServiceOptions["getBoard"];
  readonly #commit: WorkspaceCommandServiceOptions["commit"];
  readonly #mutations: WorkspaceMutationProcessor;

  constructor(options: WorkspaceCommandServiceOptions) {
    this.#database = options.database;
    this.#enqueue = options.enqueue;
    this.#getBoard = options.getBoard;
    this.#commit = options.commit;
    this.#mutations = new WorkspaceMutationProcessor({
      database: options.database,
      getSnapshot: options.getSnapshot,
      repositoryRegistry: options.repositoryRegistry,
      worktreeProvisioner: options.worktreeProvisioner,
    });
  }

  applyMutation(mutation: WorkspaceMutation): Promise<StoreCommit | null> {
    return this.#enqueue(() => this.#applyMutationInQueue(mutation));
  }

  reconcileWorktreeIntents(): Promise<void> {
    return this.#mutations.reconcileWorktreeIntents();
  }

  applyBoardEvents(
    boardId: string,
    events: WorkspaceEvent[]
  ): Promise<StoreCommit | null> {
    return this.applyBoardEventsIf(boardId, events, () => true);
  }

  applyBoardEventsIf(
    boardId: string,
    events: WorkspaceEvent[],
    shouldCommit: (board: WorkspaceBoard) => boolean
  ): Promise<StoreCommit | null> {
    if (events.length === 0) {
      return Promise.resolve(null);
    }

    return this.#run(() => {
      const board = this.#getBoard(boardId);
      if (!board) {
        return null;
      }

      if (
        events.some((event) => "boardId" in event && event.boardId !== boardId)
      ) {
        throw new Error(
          `applyBoardEvents received an event for a different board than ${boardId}`
        );
      }

      if (!shouldCommit(board)) {
        return null;
      }

      return this.#commit(events, boardId, null);
    });
  }

  updateBoardSession(
    boardId: string,
    update: Partial<WorkspaceBoard["session"]>
  ): Promise<StoreCommit | null> {
    return this.#run(() => {
      const board = this.#getBoard(boardId);
      if (!board) {
        return null;
      }

      const events: WorkspaceEvent[] = [];

      if (update.sessionId) {
        const attached = attachSessionToBoard(board, update.sessionId);
        const sessionEvent = diffSessionEvent(board, attached);
        if (sessionEvent) {
          events.push(sessionEvent);
        }
      }

      const patch = withoutKeys(update, ["sessionId"]);
      if (Object.keys(patch).length > 0) {
        events.push({
          type: "board.session_patched",
          boardId,
          ts: Date.now(),
          session: patch,
        });
      }

      if (events.length === 0) {
        return null;
      }

      return this.#commit(events, boardId, null);
    });
  }

  updateBoardReviewMode(
    boardId: string,
    reviewMode: "manual" | "auto"
  ): Promise<StoreCommit | null> {
    return this.#run(() => {
      if (!this.#getBoard(boardId)) {
        return null;
      }

      return this.#commit(
        [
          {
            type: "board.review_mode_set",
            boardId,
            ts: Date.now(),
            reviewMode,
          },
        ],
        boardId,
        null
      );
    });
  }

  #run<T>(work: () => T): Promise<T> {
    return this.#enqueue(() => Promise.resolve(work()));
  }

  async #applyMutationInQueue(
    mutation: WorkspaceMutation
  ): Promise<StoreCommit | null> {
    if (this.#database.mutationIdSeen(mutation.mutationId)) {
      return null;
    }

    const now = Date.now();
    const produced = await this.#mutations.produce(mutation, now);
    if (!produced) {
      return null;
    }
    if (produced.events.length !== 1) {
      throw new Error(
        `mutation ${mutation.type} produced ${produced.events.length} events; the 1-mutation-to-1-event contract requires exactly 1`
      );
    }

    const metaChanges = [...(produced.metaChanges ?? [])];
    if (produced.cleanup) {
      metaChanges.push({
        key: worktreeCleanupKey(produced.cleanup.boardId),
        value: JSON.stringify(produced.cleanup),
      });
    }

    let commit: StoreCommit;
    try {
      commit = this.#commit(
        produced.events,
        produced.boardId,
        { id: mutation.mutationId, ts: now },
        metaChanges
      );
    } catch (error) {
      await this.#mutations.compensateProvisionedBoard(produced.events);
      throw error;
    }

    if (produced.cleanup) {
      await this.#mutations.finishCommittedCleanup(produced.cleanup);
    }
    return commit;
  }
}

function withoutKeys<T extends object>(
  value: T,
  keys: readonly (keyof T)[]
): Partial<T> {
  const copy: Partial<T> = { ...value };
  for (const key of keys) {
    delete copy[key];
  }
  return copy;
}
