import { sha256Schema } from "@chorus/contracts";
import { RepositoryContent } from "./content";
import { RepositoryTransferError } from "./git";

export async function verifiedCheckpoint(
  directory: string,
  expectedDigest: string
) {
  sha256Schema.parse(expectedDigest);
  const content = await RepositoryContent.open(directory);
  const { checkpoint, digest } = await content.manifest();
  if (digest !== expectedDigest) {
    throw new RepositoryTransferError("checkpoint_invalid");
  }
  for (const reference of [
    checkpoint.staged,
    ...(checkpoint.history ? [checkpoint.history] : []),
    ...checkpoint.files.map((file) => file.content),
  ]) {
    await content.path(reference);
  }
  return { content, checkpoint };
}
