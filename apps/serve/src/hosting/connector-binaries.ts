import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Schema } from "@chorus/contracts";
import { z } from "zod";

const manifestSchema = z.strictObject({
  platform: z.enum(["win32", "linux", "darwin"]),
  arch: z.enum(["x64", "arm64"]),
  caddy: z.strictObject({ version: z.literal("2.11.7"), sha256: sha256Schema }),
  frpc: z.strictObject({ version: z.literal("0.71.1"), sha256: sha256Schema }),
});

/** The installer supplies this manifest and the exact reviewed native releases. */
export async function verifiedConnectorBinaries(directory: string) {
  const manifestFile = join(directory, "manifest.json");
  const metadata = await lstat(manifestFile);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4096) {
    throw new Error("invalid connector manifest");
  }
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(manifestFile, "utf8"))
  );
  if (
    manifest.platform !== process.platform ||
    manifest.arch !== process.arch
  ) {
    throw new Error("connector binaries do not match this machine");
  }
  async function verify(name: "caddy" | "frpc") {
    const filename = join(
      directory,
      `${name}${process.platform === "win32" ? ".exe" : ""}`
    );
    const entry = await lstat(filename);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 200_000_000) {
      throw new Error("invalid connector binary");
    }
    const hash = createHash("sha256")
      .update(await readFile(filename))
      .digest("hex");
    if (hash !== manifest[name].sha256) {
      throw new Error("connector binary verification failed");
    }
    return filename;
  }
  return { caddy: await verify("caddy"), frpc: await verify("frpc") };
}
