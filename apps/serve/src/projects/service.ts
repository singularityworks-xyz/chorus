import { basename } from "node:path";
import type {
  BoardSeed,
  OpencodeConfiguredProviderCatalog,
  OpencodeConfigureProviderInput,
  OpencodeCredentialCatalog,
  OpencodeModelCatalog,
  OpencodeProviderApiAuthInput,
  OpencodeProviderAuthCatalog,
  OpencodeProviderCatalog,
  OpencodeProviderOauthAuthorization,
  OpencodeProviderOauthAuthorizeInput,
  OpencodeProviderOauthCallbackInput,
  ProjectListResponse,
} from "@chorus/contracts";
import { createLogger } from "@chorus/logger";
import { OpenCodeAdapter } from "@chorus/oc-adapter";
import { AuthLoginLauncher } from "./auth-login";
import { OpenCodeConfigStore } from "./config-store";
import { OpenCodeCredentialStore } from "./credential-store";
import type { FolderPicker } from "./folder-picker";
import type { RepositoryRegistry } from "./repository-registry";

const logger = createLogger(
  {
    env: process.env.NODE_ENV === "production" ? "production" : "development",
  },
  "SERVE:PROJECTS"
);

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
  readonly #baseUrl: string;
  readonly #defaultDirectory: string;
  readonly #auth: { password: string; username: string } | undefined;
  readonly #repositoryRegistry: RepositoryRegistry | undefined;
  readonly #folderPicker: FolderPicker;
  readonly #registerPickedRepository: (directory: string) => Promise<string>;
  readonly #authLoginLauncher = new AuthLoginLauncher();
  readonly #credentialStore = new OpenCodeCredentialStore();
  readonly #configStore = new OpenCodeConfigStore();
  readonly #engineAdapterForDirectory:
    | ((directory: string) => Promise<OpenCodeAdapter>)
    | undefined;
  readonly #prepareEngineDirectory:
    | ((directory: string) => Promise<void>)
    | undefined;

  constructor(
    baseUrl: string,
    defaultDirectory: string,
    folderPicker: FolderPicker,
    registerPickedRepository: (directory: string) => Promise<string>,
    auth?: { password: string; username: string },
    repositoryRegistry?: RepositoryRegistry,
    engineAdapterForDirectory?: (directory: string) => Promise<OpenCodeAdapter>,
    prepareEngineDirectory?: (directory: string) => Promise<void>
  ) {
    this.#baseUrl = baseUrl;
    this.#defaultDirectory = defaultDirectory;
    this.#auth = auth;
    this.#repositoryRegistry = repositoryRegistry;
    this.#engineAdapterForDirectory = engineAdapterForDirectory;
    this.#prepareEngineDirectory = prepareEngineDirectory;
    this.#folderPicker = folderPicker;
    this.#registerPickedRepository = registerPickedRepository;
  }

  async listProjects(): Promise<ProjectListResponse> {
    if (this.#repositoryRegistry) {
      const projects = this.#repositoryRegistry.roots.map((directory) => ({
        directory,
        projectName: basename(directory),
        sandboxes: [],
        worktree: directory,
      }));
      return { projects };
    }

    logger.debug("list-projects:start", {
      directory: this.#defaultDirectory,
    });
    const adapter = await this.#adapterForDirectory(this.#defaultDirectory);

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

  listModels(): Promise<OpencodeModelCatalog> {
    return this.listModelsForDirectory(this.#defaultDirectory);
  }

  listCredentials(): Promise<OpencodeCredentialCatalog> {
    logger.debug("list-credentials:start");
    return this.#credentialStore.listCredentials().then((catalog) => {
      logger.info("list-credentials:done", {
        credentialCount: catalog.credentials.length,
      });
      return catalog;
    });
  }

  listConfiguredProviders(): Promise<OpencodeConfiguredProviderCatalog> {
    logger.debug("list-configured-providers:start");
    return this.#configStore.listConfiguredProviders().then((catalog) => {
      logger.info("list-configured-providers:done", {
        providerCount: catalog.providerIDs.length,
      });
      return catalog;
    });
  }

  async reloadInstance(directory: string): Promise<boolean> {
    await this.#validateDirectory(directory);
    logger.info("instance-reload:start", { directory });
    const adapter = await this.#adapterForDirectory(directory);

    const disposed = await adapter.instances.dispose({ directory });

    logger.info("instance-reload:done", {
      directory,
      disposed,
    });

    return disposed;
  }

  async configureProvider(
    input: OpencodeConfigureProviderInput
  ): Promise<boolean> {
    if (input.directory) {
      await this.#validateDirectory(input.directory);
    }
    logger.info("configure-provider:start", {
      directory: input.directory ?? null,
      providerID: input.providerID,
    });

    const adapter = await this.#adapterForDirectory(
      input.directory ?? this.#defaultDirectory
    );

    await adapter.config.configureGlobalProvider(input.providerID);

    if (input.directory) {
      await this.reloadInstance(input.directory);
    }

    const catalog = await this.#configStore.listConfiguredProviders();

    logger.info("configure-provider:done", {
      directory: input.directory ?? null,
      providerID: input.providerID,
      configuredProviders: catalog.providerIDs.join(",") || null,
    });

    return true;
  }

  async listModelsForDirectory(
    directory: string
  ): Promise<OpencodeModelCatalog> {
    await this.#validateDirectory(directory);
    logger.debug("list-models:start", { directory });
    const adapter = await this.#adapterForDirectory(directory);

    return adapter.providers.listModels().then((catalog) => {
      logger.info("list-models:done", {
        defaultModel: catalog.defaultModel
          ? `${catalog.defaultModel.providerID}/${catalog.defaultModel.modelID}`
          : null,
        modelCount: catalog.models.length,
      });

      return catalog;
    });
  }

  listProviders(): Promise<OpencodeProviderCatalog> {
    return this.listProvidersForDirectory(this.#defaultDirectory);
  }

  async listProvidersForDirectory(
    directory: string
  ): Promise<OpencodeProviderCatalog> {
    await this.#validateDirectory(directory);
    logger.debug("list-providers:start", { directory });
    const adapter = await this.#adapterForDirectory(directory);

    return adapter.providers
      .listProviders({
        directory,
      })
      .then((catalog) => {
        logger.info("list-providers:done", {
          connectedCount: catalog.providers.filter(
            (provider) => provider.connected
          ).length,
          directory,
          providerCount: catalog.providers.length,
        });

        return catalog;
      });
  }

  async getProviderAuthMethods(
    directory: string,
    providerID: string
  ): Promise<OpencodeProviderAuthCatalog> {
    await this.#validateDirectory(directory);
    logger.info("provider-auth-methods:start", {
      directory,
      providerID,
    });
    const adapter = await this.#adapterForDirectory(directory);

    return adapter.providers
      .getAuthMethods({
        directory,
        providerID,
      })
      .then((catalog) => {
        logger.info("provider-auth-methods:done", {
          directory,
          methodCount: catalog.methods.length,
          providerID,
        });
        return catalog;
      });
  }

  async authorizeProviderOauth(
    input: OpencodeProviderOauthAuthorizeInput
  ): Promise<OpencodeProviderOauthAuthorization> {
    await this.#validateDirectory(input.directory);
    logger.info("provider-oauth-authorize:start", {
      directory: input.directory,
      method: input.method,
      providerID: input.providerID,
    });
    const adapter = await this.#adapterForDirectory(input.directory);

    return adapter.providers
      .authorizeOauth({
        directory: input.directory,
        inputs: input.inputs,
        method: input.method,
        providerID: input.providerID,
      })
      .then((authorization) => {
        logger.info("provider-oauth-authorize:done", {
          directory: input.directory,
          method: input.method,
          oauthMethod: authorization.method,
          providerID: input.providerID,
        });
        return authorization;
      });
  }

  async completeProviderOauth(
    input: OpencodeProviderOauthCallbackInput
  ): Promise<boolean> {
    await this.#validateDirectory(input.directory);
    logger.info("provider-oauth-callback:start", {
      directory: input.directory,
      method: input.method,
      providerID: input.providerID,
    });
    const adapter = await this.#adapterForDirectory(input.directory);

    return adapter.providers
      .completeOauth({
        code: input.code,
        directory: input.directory,
        method: input.method,
        providerID: input.providerID,
      })
      .then(async (completed) => {
        if (completed) {
          await this.reloadInstance(input.directory);
        }

        logger.info("provider-oauth-callback:done", {
          completed,
          directory: input.directory,
          method: input.method,
          providerID: input.providerID,
        });
        return completed;
      });
  }

  async setProviderApiAuth(
    input: OpencodeProviderApiAuthInput
  ): Promise<boolean> {
    await this.#validateDirectory(input.directory);
    logger.info("provider-api-auth:start", {
      directory: input.directory,
      providerID: input.providerID,
    });
    const adapter = await this.#adapterForDirectory(input.directory);

    return adapter.providers
      .setApiAuth({
        directory: input.directory,
        key: input.key,
        providerID: input.providerID,
      })
      .then(async (saved) => {
        if (saved) {
          await this.reloadInstance(input.directory);
        }

        logger.info("provider-api-auth:done", {
          directory: input.directory,
          providerID: input.providerID,
          saved,
        });
        return saved;
      });
  }

  async openModels(directory: string): Promise<boolean> {
    await this.#validateDirectory(directory);
    logger.info("open-models:start", { directory });
    const adapter = await this.#adapterForDirectory(directory);

    return adapter.tui.openModels({ directory }).then((opened) => {
      if (opened) {
        logger.info("open-models:done", { directory, opened });
      } else {
        logger.warn("open-models:no-op", { directory, opened });
      }

      return opened;
    });
  }

  async runConnect(directory: string): Promise<boolean> {
    await this.#validateDirectory(directory);
    logger.info("run-connect:start", { directory });
    const adapter = await this.#adapterForDirectory(directory);

    return adapter.tui.runConnect({ directory }).then((opened) => {
      if (opened) {
        logger.info("run-connect:done", { directory, opened });
      } else {
        logger.warn("run-connect:no-op", { directory, opened });
      }

      return opened;
    });
  }

  async launchAuthLogin(directory: string): Promise<boolean> {
    await this.#validateDirectory(directory);
    logger.info("auth-login:start", { directory });
    const before = await this.#credentialStore.listCredentials();
    const launched = await this.#authLoginLauncher.launch(directory);

    if (launched) {
      const after = await this.#credentialStore.listCredentials();
      const changedProviderID = after.credentials.find((credential) => {
        const previous = before.credentials.find(
          (entry) => entry.id === credential.id
        );

        return previous?.type !== credential.type;
      })?.id;

      if (changedProviderID) {
        await this.configureProvider({
          directory,
          providerID: changedProviderID,
        });
      } else {
        await this.reloadInstance(directory);
      }

      logger.info("auth-login:launched", { directory });
    } else {
      logger.warn("auth-login:failed", { directory });
    }

    return launched;
  }

  async inspectDirectory(directory: string) {
    await this.#validateDirectory(directory);
    const adapter = await this.#adapterForDirectory(directory);

    return adapter.projects.inspect({ directory });
  }

  async #validateDirectory(directory: string): Promise<void> {
    await this.#repositoryRegistry?.validateAuthorizedCheckout(directory);
  }

  async #adapterForDirectory(directory: string): Promise<OpenCodeAdapter> {
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
    logger.info("open-folder:done", {
      directory,
      title: seed.title,
    });
    return seed;
  }

  createBoardSeedFromProject(project: ProjectListResponse["projects"][number]) {
    return {
      title: project.projectName ?? basename(project.directory),
      repo: {
        ...project,
      },
    } satisfies BoardSeed;
  }
}
