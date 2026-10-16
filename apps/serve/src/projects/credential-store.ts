import { readFile } from "node:fs/promises";
import type {
  OpencodeCredentialCatalog,
  OpencodeCredentialSummary,
} from "@chorus/contracts";
import { openCodeStoragePaths } from "../opencode/storage-paths";

interface StoredCredentialRecord {
  type?: "api" | "oauth" | "wellknown";
}

export class OpenCodeCredentialStore {
  readonly #authPath: string;

  constructor(authFile = openCodeStoragePaths().authFile) {
    this.#authPath = authFile;
  }

  async listCredentials(): Promise<OpencodeCredentialCatalog> {
    try {
      const raw = await readFile(this.#authPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, StoredCredentialRecord>;

      const credentials: OpencodeCredentialSummary[] = Object.entries(parsed)
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
    } catch {
      return { credentials: [] };
    }
  }
}
