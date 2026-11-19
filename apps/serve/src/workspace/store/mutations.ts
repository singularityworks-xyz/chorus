import type {
  BoardSeed,
  WorkspaceBoard,
  WorkspaceEvent,
  WorkspaceMutation,
  WorkspaceSnapshot,
} from "@chorus/contracts";
import { createLogger } from "@chorus/logger";
import { z } from "zod";
import type { RepositoryRegistry } from "../../projects/repository-registry";
import type { ChorusDatabase, MetaChange } from "../db";
import type { WorktreeProvisioner } from "../store";
import { createBoardFromSeed } from "./projection";

const logger = createLogger(
  {
    env: process.env.NODE_ENV === "production" ? "production" : "development",
  },
  "STORE"
);

const WORKTREE_CLEANUP_PREFIX = "worktree-cleanup:v1:";
const WORKTREE_PROVISION_PREFIX = "worktree-provision:v1:";
const worktreeCleanupSchema = z.object({
  boardId: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  repoDirectory: z.string().min(1),
});

export type WorktreeCleanup = z.infer<typeof worktreeCleanupSchema>;

export interface ProducedMutation {
  boardId: string | null;
  cleanup?: WorktreeCleanup;
  events: WorkspaceEvent[];
  metaChanges?: MetaChange[];
}

interface WorkspaceMutationProcessorOptions {
  database: ChorusDatabase;
  getSnapshot(): WorkspaceSnapshot;
  repositoryRegistry?: RepositoryRegistry;
  worktreeProvisioner?: WorktreeProvisioner;
}

export function worktreeCleanupKey(boardId: string): string {
  return `${WORKTREE_CLEANUP_PREFIX}${boardId}`;
}

export class WorkspaceMutationProcessor {
  readonly #database: ChorusDatabase;
  readonly #getSnapshot: () => WorkspaceSnapshot;
  readonly #repositoryRegistry: RepositoryRegistry | undefined;
  readonly #worktreeProvisioner: WorktreeProvisioner | undefined;

  constructor(options: WorkspaceMutationProcessorOptions) {
    this.#database = options.database;
    this.#getSnapshot = options.getSnapshot;
    this.#repositoryRegistry = options.repositoryRegistry;
    this.#worktreeProvisioner = options.worktreeProvisioner;
  }

  async produce(
    mutation: WorkspaceMutation,
    now: number
  ): Promise<ProducedMutation | null> {
    switch (mutation.type) {
      case "board.create": {
        const result = await this.#createBoard(mutation.payload.seed);
        const board = result.board;
        return {
          boardId: board.boardId,
          metaChanges: result.metaChanges,
          events: [
            { type: "board.created", boardId: board.boardId, board, ts: now },
          ],
        };
      }

      case "board.remove": {
        const board = this.#getSnapshot().boards.find(
          (entry) => entry.boardId === mutation.payload.boardId
        );
        if (!board) {
          return null;
        }

        const hasOwnedWorktree =
          board.repo.worktree !== board.repo.directory &&
          Boolean(this.#worktreeProvisioner?.removeWorktree);
        if (hasOwnedWorktree) {
          if (this.#repositoryRegistry) {
            await this.#repositoryRegistry.validateCandidate(
              board.repo.directory
            );
            await this.#repositoryRegistry.validateAuthorizedCheckout(
              board.repo.worktree ?? board.repo.directory
            );
          }
          await this.#worktreeProvisioner?.assertRemovable?.(
            board.repo.directory,
            board.boardId
          );
        }

        return {
          boardId: board.boardId,
          ...(hasOwnedWorktree
            ? {
                cleanup: {
                  boardId: board.boardId,
                  createdAt: now,
                  repoDirectory: board.repo.directory,
                },
              }
            : {}),
          events: [{ type: "board.removed", boardId: board.boardId, ts: now }],
        };
      }

      case "board.select":
        return {
          boardId: mutation.payload.boardId,
          events: [
            {
              type: "board.selected",
              boardId: mutation.payload.boardId,
              ts: now,
            },
          ],
        };

      case "board.move":
        return this.#existingBoardMutation(mutation.payload.boardId, {
          type: "board.moved",
          boardId: mutation.payload.boardId,
          ts: now,
          position: mutation.payload.position,
        });

      case "board.task.reorder":
        return this.#existingBoardMutation(mutation.payload.boardId, {
          type: "card.reordered",
          boardId: mutation.payload.boardId,
          ts: now,
          taskId: mutation.payload.taskId,
          column: mutation.payload.column,
          beforeTaskId: mutation.payload.beforeTaskId,
        });

      case "board.session.patch":
        return this.#existingBoardMutation(mutation.payload.boardId, {
          type: "board.session_patched",
          boardId: mutation.payload.boardId,
          ts: now,
          session: mutation.payload.session,
        });

      case "board.model.set":
        return this.#existingBoardMutation(mutation.payload.boardId, {
          type: "board.model_set",
          boardId: mutation.payload.boardId,
          ts: now,
          model: mutation.payload.model,
        });

      case "board.review_mode.set":
        return this.#existingBoardMutation(mutation.payload.boardId, {
          type: "board.review_mode_set",
          boardId: mutation.payload.boardId,
          ts: now,
          reviewMode: mutation.payload.reviewMode,
        });

      case "board.task.plan.update":
        return this.#existingBoardMutation(mutation.payload.boardId, {
          type: "board.task_plan_updated",
          boardId: mutation.payload.boardId,
          ts: now,
          taskId: mutation.payload.taskId,
          plan: mutation.payload.plan,
          questions: mutation.payload.questions,
        });

      case "preference.recently_used_models.add":
        return {
          boardId: null,
          events: [
            {
              type: "preference.recent_model_added",
              ts: now,
              model: mutation.payload.model,
            },
          ],
        };

      case "preference.default_model.set":
        return {
          boardId: null,
          events: [
            {
              type: "preference.default_model_set",
              ts: now,
              model: mutation.payload.model,
            },
          ],
        };

      case "preference.dismiss_composer_hint":
        return {
          boardId: null,
          events: [{ type: "preference.composer_hint_dismissed", ts: now }],
        };

      case "preference.speech_voice.set":
        return {
          boardId: null,
          events: [
            {
              type: "preference.speech_voice_set",
              ts: now,
              voiceId: mutation.payload.voiceId,
            },
          ],
        };

      case "preference.set_voice":
        return {
          boardId: null,
          events: [
            {
              type: "preference.speech_voice_set",
              ts: now,
              voiceId: mutation.payload.voice,
            },
          ],
        };

      case "preference.board_view_mode.set":
        return {
          boardId: null,
          events: [
            {
              type: "preference.board_view_mode_set",
              ts: now,
              mode: mutation.payload.mode,
            },
          ],
        };

      default:
        throw new Error(
          `unhandled workspace mutation type: ${String(
            (mutation as { type: string }).type
          )}`
        );
    }
  }

  async reconcileWorktreeIntents(): Promise<void> {
    const boardIds = new Set(
      this.#getSnapshot().boards.map((board) => board.boardId)
    );
    const records = [
      ...this.#database.entriesWithPrefix(WORKTREE_CLEANUP_PREFIX),
      ...this.#database.entriesWithPrefix(WORKTREE_PROVISION_PREFIX),
    ];

    for (const [key, raw] of records) {
      let intent: WorktreeCleanup | null;
      try {
        intent = this.#parseIntent(raw);
      } catch {
        intent = null;
      }
      if (!intent) {
        logger.error("worktree-intent-invalid", undefined, { key });
        continue;
      }
      if (boardIds.has(intent.boardId)) {
        this.#database.deleteMeta(key);
        continue;
      }
      await this.#finishCleanup(intent, key);
    }
  }

  async compensateProvisionedBoard(events: WorkspaceEvent[]): Promise<void> {
    const created = events.find((event) => event.type === "board.created");
    if (created?.type !== "board.created") {
      return;
    }
    const key = `${WORKTREE_PROVISION_PREFIX}${created.board.boardId}`;
    const rawIntent = this.#database.getMeta(key);
    const intent = rawIntent ? this.#parseIntent(rawIntent) : null;
    if (intent) {
      await this.#finishCleanup(intent, key);
    }
  }

  async finishCommittedCleanup(intent: WorktreeCleanup): Promise<void> {
    await this.#finishCleanup(intent, worktreeCleanupKey(intent.boardId));
  }

  async #createBoard(
    seed: BoardSeed
  ): Promise<{ board: WorkspaceBoard; metaChanges?: MetaChange[] }> {
    const registry = this.#repositoryRegistry;
    const directory = registry
      ? await registry.validateCandidate(seed.repo.directory)
      : seed.repo.directory;
    const trustedSeed = registry
      ? {
          ...seed,
          repo: {
            branch: seed.repo.branch,
            directory,
            projectId: seed.repo.projectId,
            projectName: seed.repo.projectName,
            sandboxes: [],
            worktree: directory,
          },
        }
      : seed;
    const snapshot = this.#getSnapshot();
    const board = createBoardFromSeed(trustedSeed, snapshot.boards.length);
    const provisioner = this.#worktreeProvisioner;
    if (!provisioner?.needsWorktree(snapshot.boards, board.repo.directory)) {
      return { board };
    }

    const intent: WorktreeCleanup = {
      boardId: board.boardId,
      createdAt: Date.now(),
      repoDirectory: board.repo.directory,
    };
    const intentKey = `${WORKTREE_PROVISION_PREFIX}${board.boardId}`;
    this.#database.setMeta(intentKey, JSON.stringify(intent));
    try {
      const worktree = await provisioner.ensureWorktree(
        board.repo.directory,
        board.boardId
      );
      return {
        board: { ...board, repo: { ...board.repo, worktree } },
        metaChanges: [{ key: intentKey, value: null }],
      };
    } catch (error) {
      await this.#finishCleanup(intent, intentKey);
      throw error;
    }
  }

  #existingBoardMutation(
    boardId: string,
    event: WorkspaceEvent
  ): ProducedMutation | null {
    if (
      !this.#getSnapshot().boards.some((board) => board.boardId === boardId)
    ) {
      return null;
    }
    return { boardId, events: [event] };
  }

  #parseIntent(raw: string): WorktreeCleanup | null {
    const parsed = worktreeCleanupSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  }

  async #finishCleanup(
    intent: WorktreeCleanup,
    intentKey: string
  ): Promise<void> {
    const provisioner = this.#worktreeProvisioner;
    if (!provisioner?.removeWorktree) {
      logger.warn("worktree-cleanup-unavailable", { boardId: intent.boardId });
      return;
    }

    try {
      await provisioner.removeWorktree(intent.repoDirectory, intent.boardId);
      this.#database.deleteMeta(intentKey);
      logger.info("worktree-cleanup-complete", { boardId: intent.boardId });
    } catch (error) {
      logger.warn("worktree-cleanup-pending", {
        boardId: intent.boardId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
