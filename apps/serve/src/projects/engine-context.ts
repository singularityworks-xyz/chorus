import { OpenCodeAdapter } from "@chorus/oc-adapter";
import type { RepositoryRegistry } from "./repository-registry";

export interface ProjectEngineContextOptions {
  auth?: { password: string; username: string };
  baseUrl: string;
  engineAdapterForDirectory?: (directory: string) => Promise<OpenCodeAdapter>;
  globalAdapter?: OpenCodeAdapter;
  prepareEngineDirectory?: (directory: string) => Promise<void>;
  repositoryRegistry?: RepositoryRegistry;
}

export class ProjectEngineContext {
  readonly globalAdapter: OpenCodeAdapter;
  readonly #baseUrl: string;
  readonly #auth: ProjectEngineContextOptions["auth"];
  readonly #repositoryRegistry: RepositoryRegistry | undefined;
  readonly #engineAdapterForDirectory:
    | ProjectEngineContextOptions["engineAdapterForDirectory"]
    | undefined;
  readonly #prepareEngineDirectory:
    | ProjectEngineContextOptions["prepareEngineDirectory"]
    | undefined;

  constructor(options: ProjectEngineContextOptions) {
    this.#baseUrl = options.baseUrl;
    this.#auth = options.auth;
    this.#repositoryRegistry = options.repositoryRegistry;
    this.#engineAdapterForDirectory = options.engineAdapterForDirectory;
    this.#prepareEngineDirectory = options.prepareEngineDirectory;
    this.globalAdapter =
      options.globalAdapter ??
      OpenCodeAdapter.from({ auth: options.auth, baseUrl: options.baseUrl });
  }

  get repositoryRoots(): readonly string[] | undefined {
    return this.#repositoryRegistry?.roots;
  }

  async validateDirectory(directory: string): Promise<void> {
    await this.#repositoryRegistry?.validateAuthorizedCheckout(directory);
  }

  async adapterForDirectory(directory: string): Promise<OpenCodeAdapter> {
    await this.#prepareEngineDirectory?.(directory);
    if (this.#engineAdapterForDirectory) {
      return this.#engineAdapterForDirectory(directory);
    }
    return OpenCodeAdapter.from({
      auth: this.#auth,
      baseUrl: this.#baseUrl,
      directory,
    });
  }
}
