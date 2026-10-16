import { open } from "node:fs/promises";

/** Windows supports file FlushFileBuffers, but not Node directory fsync. */
export async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
