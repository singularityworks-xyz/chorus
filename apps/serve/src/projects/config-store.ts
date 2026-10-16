import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { openCodeStoragePaths } from "../opencode/storage-paths";

interface OpencodeConfigFile {
  $schema?: string;
  disabled_providers?: string[];
  enabled_providers?: string[];
  provider?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

export interface ConfiguredProviderCatalog {
  providerIDs: string[];
}

export class OpenCodeConfigStore {
  readonly #configDir: string;
  readonly #configPath: string;

  constructor(configDirectory = openCodeStoragePaths().configDirectory) {
    this.#configDir = configDirectory;
    this.#configPath = path.join(configDirectory, "opencode.json");
  }

  async read(): Promise<OpencodeConfigFile> {
    try {
      const raw = await readFile(this.#configPath, "utf8");
      return JSON.parse(raw) as OpencodeConfigFile;
    } catch {
      return {
        $schema: "https://opencode.ai/config.json",
      };
    }
  }

  async write(config: OpencodeConfigFile): Promise<void> {
    await mkdir(this.#configDir, { recursive: true });
    await writeFile(
      this.#configPath,
      `${JSON.stringify(config, null, 2)}\n`,
      "utf8"
    );
  }

  async listConfiguredProviders(): Promise<ConfiguredProviderCatalog> {
    const config = await this.read();
    return {
      providerIDs: Object.keys(config.provider ?? {}).sort((left, right) =>
        left.localeCompare(right)
      ),
    };
  }

  async configureProvider(
    providerID: string
  ): Promise<ConfiguredProviderCatalog> {
    const config = await this.read();
    const provider = {
      ...(config.provider ?? {}),
      [providerID]: config.provider?.[providerID] ?? {},
    };

    const disabledProviders = (config.disabled_providers ?? []).filter(
      (disabledProviderID) => disabledProviderID !== providerID
    );

    await this.write({
      ...config,
      provider,
      disabled_providers:
        disabledProviders.length > 0 ? disabledProviders : undefined,
    });

    return this.listConfiguredProviders();
  }
}
