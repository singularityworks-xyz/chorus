import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { resolveDbPath } from "./connection";

export function restoreDatabaseFile(
  dataDir: string,
  sourceFile: string
): { integrity: string; path: string } {
  mkdirSync(dataDir, { recursive: true });
  const dbPath = resolveDbPath(dataDir);
  // Sidecars belong to the current target database, not the replacement file.
  for (const suffix of ["-wal", "-shm"]) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }

  copyFileSync(sourceFile, dbPath);
  chmodSync(dbPath, 0o600);
  let probe: Database | null = null;
  try {
    probe = new Database(dbPath, { create: false });
    const row = probe
      .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
      .get();
    return { integrity: row?.integrity_check ?? "unknown", path: dbPath };
  } catch (error) {
    return {
      integrity: `unreadable: ${error instanceof Error ? error.message : String(error)}`,
      path: dbPath,
    };
  } finally {
    probe?.close();
  }
}
