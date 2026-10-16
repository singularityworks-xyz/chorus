import { createHash } from "node:crypto";
import { lstat, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MAX_WORKSPACE_MANIFEST_BYTES,
  sha256Schema,
  type WorkspaceCheckpoint,
  workspaceCheckpointSchema,
} from "@chorus/contracts";
import { syncDirectory } from "./durability";
import { RepositoryTransferError } from "./git";

export function encodeWorkspaceManifest(input: WorkspaceCheckpoint): Buffer {
  const bytes = Buffer.from(
    JSON.stringify(workspaceCheckpointSchema.parse(input))
  );
  if (bytes.length > MAX_WORKSPACE_MANIFEST_BYTES) {
    throw new RepositoryTransferError("checkpoint_too_large");
  }
  return bytes;
}

export async function writeWorkspaceManifest(
  directory: string,
  input: WorkspaceCheckpoint
) {
  const bytes = encodeWorkspaceManifest(input);
  const file = await open(join(directory, "workspace.json"), "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(directory);
  return createHash("sha256").update(bytes).digest("hex");
}

export async function readWorkspaceManifest(
  directory: string,
  digest: string
): Promise<WorkspaceCheckpoint> {
  sha256Schema.parse(digest);
  const filename = join(directory, "workspace.json");
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new RepositoryTransferError("checkpoint_invalid");
  }
  if (metadata.size > MAX_WORKSPACE_MANIFEST_BYTES) {
    throw new RepositoryTransferError("checkpoint_too_large");
  }
  const bytes = await readFile(filename);
  if (
    bytes.length !== metadata.size ||
    createHash("sha256").update(bytes).digest("hex") !== digest
  ) {
    throw new RepositoryTransferError("checkpoint_invalid");
  }
  try {
    return workspaceCheckpointSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    );
  } catch {
    throw new RepositoryTransferError("checkpoint_invalid");
  }
}
