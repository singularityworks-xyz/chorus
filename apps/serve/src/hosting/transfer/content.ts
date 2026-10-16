import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  type CheckpointContent,
  checkpointContentSchema,
  MAX_REPOSITORY_CHECKPOINT_BYTES,
  type RepositoryCheckpoint,
  repositoryCheckpointSchema,
} from "@chorus/contracts";
import { ensurePrivateHostDirectory } from "../private-directory";
import { syncDirectory } from "./durability";
import { RepositoryTransferError } from "./git";

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

async function regularFile(filename: string, bytes: number) {
  const metadata = await lstat(filename);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.size !== bytes
  ) {
    throw new RepositoryTransferError("checkpoint_invalid");
  }
}

export async function contentDigest(filename: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/** Flat content addressing: repository paths are never archive extraction paths. */
export class RepositoryContent {
  readonly root: string;
  private constructor(root: string) {
    this.root = root;
  }

  static async create(directory: string): Promise<RepositoryContent> {
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        throw new RepositoryTransferError("destination_exists");
      }
      throw error;
    }
    const root = await ensurePrivateHostDirectory(directory);
    await mkdir(join(root, "data"), { mode: 0o700 });
    return new RepositoryContent(await realpath(root));
  }

  static async open(directory: string): Promise<RepositoryContent> {
    const root = resolve(directory);
    const metadata = await lstat(root);
    const data = await lstat(join(root, "data"));
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      !data.isDirectory() ||
      data.isSymbolicLink()
    ) {
      throw new RepositoryTransferError("checkpoint_invalid");
    }
    return new RepositoryContent(await realpath(root));
  }

  async put(bytes: Uint8Array): Promise<CheckpointContent> {
    if (bytes.length > MAX_REPOSITORY_CHECKPOINT_BYTES) {
      throw new RepositoryTransferError("checkpoint_too_large");
    }
    const reference = {
      digest: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    };
    const filename = join(this.root, "data", reference.digest);
    try {
      const file = await open(filename, "wx", 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      ) {
        throw error;
      }
      await this.path(reference);
    }
    return reference;
  }

  async path(input: CheckpointContent): Promise<string> {
    const reference = checkpointContentSchema.parse(input);
    const filename = join(this.root, "data", reference.digest);
    await regularFile(filename, reference.bytes);
    if ((await contentDigest(filename)) !== reference.digest) {
      throw new RepositoryTransferError("checkpoint_invalid");
    }
    return filename;
  }

  async manifest(): Promise<{
    checkpoint: RepositoryCheckpoint;
    digest: string;
  }> {
    const filename = join(this.root, "manifest.json");
    const metadata = await lstat(filename);
    if (metadata.size > MAX_MANIFEST_BYTES) {
      throw new RepositoryTransferError("checkpoint_too_large");
    }
    await regularFile(filename, metadata.size);
    const bytes = await readFile(filename);
    try {
      return {
        checkpoint: repositoryCheckpointSchema.parse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
        ),
        digest: createHash("sha256").update(bytes).digest("hex"),
      };
    } catch {
      throw new RepositoryTransferError("checkpoint_invalid");
    }
  }

  async save(checkpoint: RepositoryCheckpoint): Promise<string> {
    const bytes = Buffer.from(
      JSON.stringify(repositoryCheckpointSchema.parse(checkpoint))
    );
    if (bytes.length > MAX_MANIFEST_BYTES) {
      throw new RepositoryTransferError("checkpoint_too_large");
    }
    const file = await open(join(this.root, "manifest.json"), "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await syncDirectory(join(this.root, "data"));
    await syncDirectory(this.root);
    await syncDirectory(dirname(this.root));
    return createHash("sha256").update(bytes).digest("hex");
  }
}
