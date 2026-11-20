import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Logger } from "@chorus/logger";
import type { OpenCodeBridge } from "../../bridge/opencode/bridge";
import type { ServerConfig } from "../../config";
import type { RepositoryRegistry } from "../../projects/repository-registry";
import { WorktreeManager } from "../../projects/worktree-manager";
import { WorkspaceStore } from "../../workspace/store";

async function fileExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

function legacySnapshotPaths(): string[] {
  return [
    path.join(homedir(), ".chorus", "workspace.json"),
    path.join(process.cwd(), ".chorus", "workspace.json"),
  ];
}

export async function createWorkspaceRuntime({
  bridge,
  config,
  isProduction,
  logger,
  repositoryRegistry,
}: {
  bridge: OpenCodeBridge;
  config: ServerConfig;
  isProduction: boolean;
  logger: Logger;
  repositoryRegistry: RepositoryRegistry;
}) {
  const worktrees = new WorktreeManager();
  const workspaceStore = new WorkspaceStore(config.dataDir, {
    dbSizeCapMb: config.dbSizeCapMb,
    retentionDays: config.retentionDays,
    snapshotInterval: config.snapshotInterval,
    worktreeProvisioner: worktrees,
    repositoryRegistry,
    restorePersistedRepositoryRoots: !isProduction,
  });

  if (config.enableLegacyWorkspaceImport) {
    for (const candidate of legacySnapshotPaths()) {
      if (await fileExists(candidate)) {
        await workspaceStore.load(candidate);
        logger.info("workspace-legacy-import-attempted", { from: candidate });
        break;
      }
    }
  } else {
    await workspaceStore.load();
  }

  bridge.setRecoverySessionProvider((directory) =>
    workspaceStore
      .getSnapshot()
      .boards.filter(
        (board) =>
          (board.repo.worktree ?? board.repo.directory) === directory &&
          board.session.currentTaskId !== undefined &&
          (board.session.state === "active" ||
            Object.values(board.columns)
              .flat()
              .some(
                (task) =>
                  (task.pendingApprovals?.length ?? 0) > 0 ||
                  task.pendingApproval !== undefined
              ))
      )
      .flatMap((board) =>
        board.session.sessionId ? [board.session.sessionId] : []
      )
  );

  logger.info("workspace-ready", {
    dataDir: config.dataDir,
    database: workspaceStore.databasePath,
    headSeq: workspaceStore.headSeq(),
  });

  return { workspaceStore, worktrees };
}

export async function pruneOrphanWorktrees({
  repositoryRegistry,
  workspaceStore,
  worktrees,
  logger,
}: {
  repositoryRegistry: RepositoryRegistry;
  workspaceStore: WorkspaceStore;
  worktrees: WorktreeManager;
  logger: Logger;
}): Promise<void> {
  const boards = workspaceStore.getSnapshot().boards;
  const liveBoardIds = new Set(boards.map((board) => board.boardId));
  const repositories = new Set([
    ...boards.map((board) => board.repo.directory),
    ...repositoryRegistry.roots,
  ]);

  for (const directory of repositories) {
    try {
      const removed = await worktrees.pruneOrphans(directory, liveBoardIds);
      if (removed.length > 0) {
        logger.info("worktree-orphans-pruned", {
          count: removed.length,
          repository: directory,
        });
      }
    } catch (error) {
      logger.warn("worktree-prune-failed", {
        error: error instanceof Error ? error.message : String(error),
        repository: directory,
      });
    }
  }
}
