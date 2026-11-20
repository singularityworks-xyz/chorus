import type { Logger } from "@chorus/logger";
import type { OpenCodeBridge } from "../../bridge/opencode/bridge";
import type { ServerConfig } from "../../config";
import type { EngineRegistry } from "../../opencode/engine-registry";
import { ProjectEngineContext } from "../../projects/engine-context";
import { NativeFolderPicker } from "../../projects/folder-picker";
import { ProviderService } from "../../projects/providers/service";
import type { RepositoryRegistry } from "../../projects/repository-registry";
import { ProjectService } from "../../projects/service";
import { BoardTaskService } from "../../tasks/board-task-service";
import { SessionWatchdog } from "../../tasks/session-watchdog";
import type { WorkspaceStore } from "../../workspace/store";

export function createTaskRuntime({
  bridge,
  config,
  engineAuth,
  engineRegistry,
  logger,
  repositoryRegistry,
  workspaceStore,
}: {
  bridge: OpenCodeBridge;
  config: ServerConfig;
  engineAuth: { password: string; username: string } | undefined;
  engineRegistry: EngineRegistry | null;
  logger: Logger;
  repositoryRegistry: RepositoryRegistry;
  workspaceStore: WorkspaceStore;
}) {
  const watchdog = new SessionWatchdog(bridge, {
    onTimeout: (sessionId, info, message) => {
      logger.warn("watchdog-timeout", {
        sessionId,
        boardId: info.boardId,
        message,
      });

      workspaceStore
        .applyAgentEvent({
          type: "session.timeout",
          sessionID: sessionId,
          activity: "error",
          error: message,
          timestamp: Date.now(),
        })
        .then((commit) => {
          if (!commit) {
            return;
          }
          logger.info("workspace-commit-after-timeout", {
            sessionID: sessionId,
            boardId: commit.boardId,
            seq: commit.lastSeq,
          });
        })
        .catch((error) => {
          logger.error(
            "workspace-projection-failed-timeout",
            error instanceof Error ? error : undefined,
            { sessionID: sessionId }
          );
        });
    },
  });

  const boardTasks = new BoardTaskService(
    bridge,
    workspaceStore,
    undefined,
    watchdog,
    repositoryRegistry
  );
  const projectEngineContext = new ProjectEngineContext({
    auth: engineAuth,
    baseUrl: config.opencodeBaseUrl,
    engineAdapterForDirectory: engineRegistry
      ? (directory) => engineRegistry.adapterForDirectory(directory)
      : undefined,
    prepareEngineDirectory: (directory) => bridge.subscribeDirectory(directory),
    repositoryRegistry,
  });
  const projectService = new ProjectService({
    defaultDirectory: config.opencodeDirectory,
    engine: projectEngineContext,
    folderPicker: new NativeFolderPicker(),
    registerPickedRepository: (directory) =>
      workspaceStore.registerPickedRepository(directory),
  });
  const providerService = new ProviderService({
    defaultDirectory: config.opencodeDirectory,
    engine: projectEngineContext,
  });

  return { boardTasks, projectService, providerService, watchdog };
}
