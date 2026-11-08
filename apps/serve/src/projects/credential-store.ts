import { readFile } from "node:fs/promises";
import type {
  OpencodeCredentialCatalog,
  OpencodeCredentialSummary,
} from "@chorus/contracts";
import { z } from "zod";
import { openCodeStoragePaths } from "../opencode/storage-paths";

const credentialFileSchema = z.record(
  z.string(),
  z
    .object({
      type: z.enum(["api", "oauth", "wellknown"]).optional(),
    })
    .passthrough()
);

export class OpenCodeCredentialStoreError extends Error {
  readonly code: "credentials_invalid" | "credentials_read_failed";

  constructor(
    code: "credentials_invalid" | "credentials_read_failed",
    cause?: unknown
  ) {
    super(
      code === "credentials_invalid"
        ? "OpenCode credentials have an unsupported or invalid format"
        : "OpenCode credentials could not be read",
      { cause }
    );
    this.code = code;
    this.name = "OpenCodeCredentialStoreError";
  }
}

export class OpenCodeCredentialStore {
  readonly #authPath: string;

  constructor(authFile = openCodeStoragePaths().authFile) {
    this.#authPath = authFile;
  }

  async listCredentials(): Promise<OpencodeCredentialCatalog> {
    let raw: string;
    try {
      raw = await readFile(this.#authPath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { credentials: [] };
      }
      throw new OpenCodeCredentialStoreError("credentials_read_failed", error);
    }

    let contents: unknown;
    try {
      contents = JSON.parse(raw);
    } catch (error) {
      throw new OpenCodeCredentialStoreError("credentials_invalid", error);
    }
    const parsed = credentialFileSchema.safeParse(contents);
    if (!parsed.success) {
      throw new OpenCodeCredentialStoreError(
        "credentials_invalid",
        parsed.error
      );
    }

    const credentials: OpencodeCredentialSummary[] = Object.entries(parsed.data)
      .flatMap(([id, value]) =>
        value.type
          ? [
              {
                id,
                type: value.type,
              },
            ]
          : []
      )
      .sort((left, right) => left.id.localeCompare(right.id));

    return { credentials };
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error && "code" in error && typeof error.code === "string"
  );
}
