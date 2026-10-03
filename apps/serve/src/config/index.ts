import { homedir } from "node:os";
import path from "node:path";

export interface ServerConfig {
  autoStartOpencode: boolean;
  /** Delta coalescing window in ms (spec §7). */
  coalesceMs: number;
  /** Where chorus.db, snapshots, and chorus.token live. */
  dataDir: string;
  /** Hard ceiling on chorus.db before the log compacts itself (spec §5). */
  dbSizeCapMb: number;
  /**
   * One-shot import of the pre-Phase-2 `workspace.json` into SQLite. Off by
   * default so the path can be deleted once the migration is confirmed; a
   * corrupt legacy file aborts boot rather than starting empty.
   */
  enableLegacyWorkspaceImport: boolean;
  hostname: string;
  opencodeBaseUrl: string;
  opencodeDirectory: string;
  opencodePort: number;
  port: number;
  /** Terminal-run step detail older than this is compacted (spec §5). */
  retentionDays: number;
  /** Events appended between full-state snapshots. */
  snapshotInterval: number;
}

export function loadConfig(): ServerConfig {
  const rawPort = process.env.PORT ?? "2000";
  const port = Number.parseInt(rawPort, 10);

  if (!Number.isFinite(port) || port <= 0 || port >= 65_536) {
    throw new Error(
      `Invalid PORT "${rawPort}": must be a number between 1 and 65535`
    );
  }

  const positive = (
    raw: string | undefined,
    fallback: number,
    name: string
  ) => {
    if (raw === undefined || raw === "") {
      return fallback;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`Invalid ${name} "${raw}": must be a positive integer`);
    }
    return parsed;
  };

  return {
    port,
    hostname: process.env.HOSTNAME ?? "localhost",
    // One source of truth for the engine address. Previously the process manager
    // hardcoded 4096 and this defaulted to `http://localhost:4096`
    // independently, so overriding one silently desynchronised the port we spawn
    // on from the URL every client request went to.
    opencodePort: positive(process.env.OPENCODE_PORT, 4096, "OPENCODE_PORT"),
    opencodeBaseUrl:
      process.env.OPENCODE_BASE_URL ??
      `http://localhost:${String(positive(process.env.OPENCODE_PORT, 4096, "OPENCODE_PORT"))}`,
    opencodeDirectory: process.env.OPENCODE_DIRECTORY ?? process.cwd(),
    autoStartOpencode: process.env.OPENCODE_AUTO_START !== "false",
    // ~/.chorus keeps parity with where the pre-Phase-2 store wrote, so an
    // existing operator finds their state where they expect it.
    coalesceMs: positive(process.env.COALESCE_MS, 100, "COALESCE_MS"),
    dataDir: process.env.DATA_DIR ?? path.join(homedir(), ".chorus"),
    dbSizeCapMb: positive(process.env.DB_SIZE_CAP_MB, 512, "DB_SIZE_CAP_MB"),
    retentionDays: positive(process.env.RETENTION_DAYS, 30, "RETENTION_DAYS"),
    snapshotInterval: positive(
      process.env.SNAPSHOT_INTERVAL,
      1000,
      "SNAPSHOT_INTERVAL"
    ),
    enableLegacyWorkspaceImport:
      process.env.CHORUS_ENABLE_LEGACY_WORKSPACE_IMPORT === "true",
  };
}
