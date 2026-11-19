import type {
  OpencodeConfiguredProviderCatalog,
  OpencodeConfigureProviderInput,
  OpencodeCredentialCatalog,
  OpencodeModelCatalog,
  OpencodeProviderCatalog,
} from "@chorus/contracts";
import { createLogger } from "@chorus/logger";
import { AuthLoginLauncher } from "../auth-login";
import { OpenCodeCredentialStore } from "../credential-store";
import type { ProjectEngineContext } from "../engine-context";

const logger = createLogger(
  {
    env: process.env.NODE_ENV === "production" ? "production" : "development",
  },
  "SERVE:PROVIDERS"
);

export interface ProviderServiceOptions {
  authLoginLauncher?: AuthLoginLauncher;
  credentialStore?: Pick<OpenCodeCredentialStore, "listCredentials">;
  defaultDirectory: string;
  engine: ProjectEngineContext;
}

export class ProviderService {
  readonly #defaultDirectory: string;
  readonly #engine: ProjectEngineContext;
  readonly #globalAdapter: ProjectEngineContext["globalAdapter"];
  readonly #authLoginLauncher: AuthLoginLauncher;
  readonly #credentialStore: Pick<OpenCodeCredentialStore, "listCredentials">;

  constructor(options: ProviderServiceOptions) {
    this.#defaultDirectory = options.defaultDirectory;
    this.#engine = options.engine;
    this.#globalAdapter = options.engine.globalAdapter;
    this.#authLoginLauncher =
      options.authLoginLauncher ?? new AuthLoginLauncher();
    this.#credentialStore =
      options.credentialStore ?? new OpenCodeCredentialStore();
  }

  listModels(): Promise<OpencodeModelCatalog> {
    logger.debug("list-models:start", { directory: null });

    return this.#globalAdapter.providers.listModels().then((catalog) => {
      logger.info("list-models:done", {
        defaultModel: catalog.defaultModel
          ? `${catalog.defaultModel.providerID}/${catalog.defaultModel.modelID}`
          : null,
        modelCount: catalog.models.length,
      });

      return catalog;
    });
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
    return this.#globalAdapter.config
      .listConfiguredProviders()
      .then((catalog) => {
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

    const adapter = this.#globalAdapter;

    await adapter.config.configureGlobalProvider(input.providerID);

    if (input.directory) {
      await this.reloadInstance(input.directory);
    }

    const catalog = await adapter.config.listConfiguredProviders();

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
    logger.debug("list-providers:start", { directory: null });

    return this.#globalAdapter.providers.listProviders().then((catalog) => {
      logger.info("list-providers:done", {
        connectedCount: catalog.providers.filter(
          (provider) => provider.connected
        ).length,
        directory: null,
        providerCount: catalog.providers.length,
      });

      return catalog;
    });
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

  async openModels(directory = this.#defaultDirectory): Promise<boolean> {
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

  async runConnect(directory = this.#defaultDirectory): Promise<boolean> {
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

  async launchAuthLogin(directory = this.#defaultDirectory): Promise<boolean> {
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

  async #validateDirectory(directory: string): Promise<void> {
    await this.#engine.validateDirectory(directory);
  }

  #adapterForDirectory(directory: string) {
    return this.#engine.adapterForDirectory(directory);
  }
}
