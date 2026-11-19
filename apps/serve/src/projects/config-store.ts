import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { openCodeStoragePaths } from "../opencode/storage-paths";

const opencodeConfigSchema = z
  .object({
    $schema: z.string().optional(),
    disabled_providers: z.array(z.string()).optional(),
    enabled_providers: z.array(z.string()).optional(),
    provider: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

type OpencodeConfigFile = z.infer<typeof opencodeConfigSchema>;

export class OpenCodeConfigStoreError extends Error {
  readonly code: "config_invalid" | "config_read_failed";

  constructor(code: "config_invalid" | "config_read_failed", cause?: unknown) {
    super(
      code === "config_invalid"
        ? "OpenCode global configuration is invalid; no settings were changed"
        : "OpenCode global configuration could not be read; no settings were changed",
      { cause }
    );
    this.code = code;
    this.name = "OpenCodeConfigStoreError";
  }
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
    let raw: string;
    try {
      raw = await readFile(this.#configPath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return {
          $schema: "https://opencode.ai/config.json",
        };
      }
      throw new OpenCodeConfigStoreError("config_read_failed", error);
    }

    let contents: unknown;
    try {
      contents = JSON.parse(raw);
    } catch (error) {
      throw new OpenCodeConfigStoreError("config_invalid", error);
    }
    const parsed = opencodeConfigSchema.safeParse(contents);
    if (!parsed.success) {
      throw new OpenCodeConfigStoreError("config_invalid", parsed.error);
    }
    return parsed.data;
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error && "code" in error && typeof error.code === "string"
  );
}
