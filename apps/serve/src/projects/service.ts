import { basename } from "node:path";
import type { BoardSeed, ProjectListResponse } from "@chorus/contracts";
import { createLogger } from "@chorus/logger";
import type { ProjectEngineContext } from "./engine-context";
import type { FolderPicker } from "./folder-picker";

const logger = createLogger(
  {
    env: process.env.NODE_ENV === "production" ? "production" : "development",
  },
  "SERVE:PROJECTS"
);

export interface ProjectServiceOptions {
  defaultDirectory: string;
  engine: ProjectEngineContext;
  folderPicker: FolderPicker;
  registerPickedRepository: (directory: string) => Promise<string>;
}

function toBoardSeed(
  repo: Awaited<ReturnType<ProjectService["inspectDirectory"]>>
) {
  return {
    title: repo.projectName ?? basename(repo.directory),
    repo: {
      directory: repo.directory,
      worktree: repo.worktree,
      projectId: repo.projectId,
      projectName: repo.projectName,
      branch: repo.branch,
      sandboxes: repo.sandboxes,
    },
  } satisfies BoardSeed;
}

export class ProjectService {
  readonly #defaultDirectory: string;
  readonly #engine: ProjectEngineContext;
  readonly #folderPicker: FolderPicker;
  readonly #registerPickedRepository: (directory: string) => Promise<string>;

  constructor(options: ProjectServiceOptions) {
    this.#defaultDirectory = options.defaultDirectory;
    this.#engine = options.engine;
    this.#folderPicker = options.folderPicker;
    this.#registerPickedRepository = options.registerPickedRepository;
  }

  async listProjects(): Promise<ProjectListResponse> {
    const roots = this.#engine.repositoryRoots;
    if (roots) {
      return {
        projects: roots.map((directory) => ({
          directory,
          projectName: basename(directory),
          sandboxes: [],
          worktree: directory,
        })),
      };
    }

    logger.debug("list-projects:start", { directory: this.#defaultDirectory });
    const adapter = await this.#engine.adapterForDirectory(
      this.#defaultDirectory
    );
    const projects = await adapter.projects.list({
      directory: this.#defaultDirectory,
    });
    const response = {
      projects: projects.map((project) => ({
        directory: project.directory,
        worktree: project.worktree,
        projectId: project.projectId,
        projectName: project.projectName,
        sandboxes: project.sandboxes,
      })),
    };

    logger.info("list-projects:done", {
      count: response.projects.length,
      directory: this.#defaultDirectory,
    });
    return response;
  }

  async inspectDirectory(directory: string) {
    await this.#engine.validateDirectory(directory);
    const adapter = await this.#engine.adapterForDirectory(directory);
    return adapter.projects.inspect({ directory });
  }

  async openFolder(): Promise<BoardSeed | null> {
    logger.info("open-folder:start");
    const directory = await this.#folderPicker.pickFolder();
    if (!directory) {
      logger.info("open-folder:cancelled");
      return null;
    }

    const registeredDirectory = await this.#registerPickedRepository(directory);
    const repo = await this.inspectDirectory(registeredDirectory);
    const seed = toBoardSeed(repo);
    logger.info("open-folder:done", { directory, title: seed.title });
    return seed;
  }
}
