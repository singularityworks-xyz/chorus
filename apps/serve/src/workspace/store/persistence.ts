import { constants as fsConstants } from "node:fs";
import { access, copyFile, readFile, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type WorkspaceBoard,
  type WorkspaceEvent,
  type WorkspaceSnapshot,
  workspaceSnapshotSchema,
} from "@chorus/contracts";
import { createLogger } from "@chorus/logger";
import type { RepositoryRegistry } from "../../projects/repository-registry";
import type { ChorusDatabase, StoredEvent } from "../db";
import { retentionCutoff, stripTerminalRunDetails } from "../retention";
import { projectWorkspaceEvent } from "./projection";

const logger = createLogger(
  {
    env: process.env.NODE_ENV === "production" ? "production" : "development",
  },
  "STORE"
);

const SNAPSHOT_BLOB_VERSION = 1;

interface PersistedBlob {
  snapshot: WorkspaceSnapshot;
  v: number;
}

interface LoadedWorkspaceSnapshot {
  replayed: number;
  snapshot: WorkspaceSnapshot;
  snapshotSeq: number;
}

export class WorkspacePersistence {
  readonly #database: ChorusDatabase;
  readonly #repositoryRegistry: RepositoryRegistry | undefined;

  constructor(
    database: ChorusDatabase,
    repositoryRegistry?: RepositoryRegistry
  ) {
    this.#database = database;
    this.#repositoryRegistry = repositoryRegistry;
  }

  loadLatestSnapshot(): LoadedWorkspaceSnapshot | null {
    const storedSnapshot = this.#database.latestSnapshot();
    if (!storedSnapshot) {
      return null;
    }

    let snapshot = this.#parseSnapshot(storedSnapshot.blob);
    const events = this.#database.readEventsSince(storedSnapshot.seq);
    for (const storedEvent of events) {
      snapshot = projectWorkspaceEvent(snapshot, this.decodeEvent(storedEvent));
    }
    return {
      snapshot,
      snapshotSeq: storedSnapshot.seq,
      replayed: events.length,
    };
  }

  async importLegacySnapshot(
    legacyPath: string
  ): Promise<WorkspaceSnapshot | null> {
    try {
      await access(legacyPath);
    } catch {
      return null;
    }

    const raw = await readFile(legacyPath, "utf8");
    let parsed: WorkspaceSnapshot;
    try {
      parsed = workspaceSnapshotSchema.parse(JSON.parse(raw));
    } catch (error) {
      throw new Error(
        `refusing to start: legacy workspace snapshot at ${legacyPath} is corrupt (${messageOf(error)}). Move it aside to start with an empty workspace.`
      );
    }

    const importedBoards: WorkspaceBoard[] = [];
    const checkoutOwners = new Map<string, string>();
    for (const board of parsed.boards) {
      const directory = this.#repositoryRegistry
        ? await this.#repositoryRegistry.validateCandidate(board.repo.directory)
        : resolve(board.repo.directory);
      const checkout = this.#repositoryRegistry
        ? await this.#repositoryRegistry.validateAuthorizedCheckout(
            board.repo.worktree ?? directory
          )
        : resolve(board.repo.worktree ?? directory);
      const identity =
        process.platform === "win32"
          ? checkout.toLocaleLowerCase("en-US")
          : checkout;
      const previousOwner = checkoutOwners.get(identity);
      if (previousOwner) {
        throw new Error(
          `refusing to import legacy workspace at ${legacyPath}: boards ${previousOwner} and ${board.boardId} share checkout ${checkout}; preserve the source file and provision separate Chorus worktrees before retrying`
        );
      }
      checkoutOwners.set(identity, board.boardId);
      importedBoards.push({
        ...board,
        repo: {
          ...board.repo,
          directory,
          sandboxes: [],
          worktree: checkout,
        },
      });
    }

    return projectWorkspaceEvent(
      { ...parsed, boards: importedBoards },
      {
        type: "board.selected",
        boardId: parsed.selectedBoardId,
        ts: Date.now(),
      }
    );
  }

  writeSnapshot(
    snapshot: WorkspaceSnapshot,
    retentionDays: number
  ): { head: number; snapshot: WorkspaceSnapshot } {
    const retained = stripTerminalRunDetails(
      snapshot,
      retentionCutoff(Date.now(), retentionDays)
    );
    const head = this.#database.headSeq();
    this.#database.writeSnapshot(
      head,
      Date.now(),
      JSON.stringify({
        snapshot: retained,
        v: SNAPSHOT_BLOB_VERSION,
      } satisfies PersistedBlob)
    );
    return { head, snapshot: retained };
  }

  pruneEventsBefore(head: number): void {
    this.#database.pruneEventsBefore(head);
  }

  async parkLegacySnapshot(legacyPath: string): Promise<void> {
    const parkedPath = `${legacyPath}.imported`;
    try {
      await rename(legacyPath, parkedPath);
      return;
    } catch {
      // Some Windows processes temporarily prevent a same-volume rename.
    }

    try {
      await copyFile(legacyPath, parkedPath, fsConstants.COPYFILE_EXCL);
      await unlink(legacyPath);
    } catch (error) {
      logger.warn("workspace-legacy-snapshot-not-parked", {
        path: legacyPath,
        errorName: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  decodeEvent(stored: StoredEvent): WorkspaceEvent {
    try {
      return JSON.parse(stored.payload) as WorkspaceEvent;
    } catch (error) {
      throw new Error(
        `corrupt event at seq ${stored.seq} in ${this.#database.path}: ${messageOf(error)}`
      );
    }
  }

  #parseSnapshot(blob: string): WorkspaceSnapshot {
    let parsed: PersistedBlob;
    try {
      parsed = JSON.parse(blob) as PersistedBlob;
    } catch (error) {
      throw new Error(
        `corrupt workspace snapshot in ${this.#database.path}: ${messageOf(error)}`
      );
    }

    if (parsed.v !== SNAPSHOT_BLOB_VERSION) {
      throw new Error(
        `unsupported workspace snapshot version ${String(parsed.v)} in ${this.#database.path}`
      );
    }

    try {
      return workspaceSnapshotSchema.parse(parsed.snapshot);
    } catch (error) {
      throw new Error(
        `corrupt workspace snapshot in ${this.#database.path}: ${messageOf(error)}`
      );
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
