import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { z } from "zod";

const packageManifestSchema = z.object({
  bin: z.union([z.string(), z.record(z.string(), z.string())]),
});

const require = createRequire(import.meta.url);

export function resolveOpenCodeBinary(): string {
  const manifestPath = require.resolve("opencode-ai/package.json");
  const manifestContents: unknown = JSON.parse(
    readFileSync(manifestPath, "utf8")
  );
  const manifest = packageManifestSchema.safeParse(manifestContents);
  if (!manifest.success) {
    throw new Error(
      "The installed opencode-ai package has no valid CLI entrypoint"
    );
  }

  const bin = manifest.data.bin;
  const relativeBinary = typeof bin === "string" ? bin : bin.opencode;
  if (!relativeBinary) {
    throw new Error(
      "The installed opencode-ai package does not expose the opencode CLI"
    );
  }
  return join(dirname(manifestPath), relativeBinary);
}

export function createOpenCodeEnvironment(
  databasePath: string,
  environment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return { ...environment, OPENCODE_DB: databasePath };
}
