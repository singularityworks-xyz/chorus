import { isIP } from "node:net";
import { homedir } from "node:os";
import path from "node:path";

export interface ServerConfig {
  autoStartOpencode: boolean;
  bindAddress: string;
  /** Delta coalescing window in ms (spec §7). */
  coalesceMs: number;
  /** Where chorus.db, snapshots, and the internal session secret live. */
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
  opencodePassword: string | undefined;
  opencodePerWorktree: boolean;
  opencodePort: number;
  opencodeUsername: string | undefined;
  port: number;
  pushAllowedHosts: string[];
  pushEnabled: string | undefined;
  /** Terminal-run step detail older than this is compacted (spec §5). */
  retentionDays: number;
  /** Events appended between full-state snapshots. */
  snapshotInterval: number;
  vapidPrivateKey: string | undefined;
  vapidPublicKey: string | undefined;
  vapidSubject: string | undefined;
}

type OpenCodeConfig = Pick<
  ServerConfig,
  | "autoStartOpencode"
  | "opencodeBaseUrl"
  | "opencodePassword"
  | "opencodeUsername"
>;

const VALID_PUSH_HOST = /^[a-z0-9.-]+$/;

function parseTcpPort(
  raw: string | undefined,
  fallback: number,
  name: string
): number {
  if (raw === undefined || raw === "") {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 65_536) {
    throw new Error(
      `Invalid ${name} "${raw}": must be a number between 1 and 65535`
    );
  }
  return parsed;
}

function parsePositive(
  raw: string | undefined,
  fallback: number,
  name: string
): number {
  if (raw === undefined || raw === "") {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name} "${raw}": must be a positive integer`);
  }
  return parsed;
}

function parseBoolean(
  raw: string | undefined,
  fallback: boolean,
  name: string
): boolean {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  throw new Error(`Invalid ${name}: expected "true" or "false"`);
}

function loadOpenCodeConfig(port: number): OpenCodeConfig {
  const explicitBaseUrl = process.env.OPENCODE_BASE_URL;
  let baseUrl: URL;
  try {
    baseUrl = new URL(explicitBaseUrl ?? `http://127.0.0.1:${String(port)}`);
    if (
      !["http:", "https:"].includes(baseUrl.protocol) ||
      baseUrl.username ||
      baseUrl.password ||
      baseUrl.pathname !== "/" ||
      baseUrl.search ||
      baseUrl.hash
    ) {
      throw new Error("unsupported URL shape");
    }
  } catch {
    throw new Error(
      "Invalid OPENCODE_BASE_URL: expected an HTTP(S) origin without credentials, path, query, or fragment"
    );
  }

  const username = process.env.OPENCODE_USERNAME?.trim();
  const password = process.env.OPENCODE_PASSWORD;
  if (Boolean(username) !== Boolean(password)) {
    throw new Error(
      "OPENCODE_USERNAME and OPENCODE_PASSWORD must be configured together"
    );
  }

  const localHostname = isLocalHost(baseUrl.hostname);
  const explicitAutoStart = process.env.OPENCODE_AUTO_START;
  if (
    explicitAutoStart !== undefined &&
    explicitAutoStart !== "true" &&
    explicitAutoStart !== "false"
  ) {
    throw new Error('Invalid OPENCODE_AUTO_START: expected "true" or "false"');
  }
  if (explicitBaseUrl && !localHostname && explicitAutoStart === "true") {
    throw new Error(
      "OPENCODE_AUTO_START=true cannot be used with a remote OPENCODE_BASE_URL; remove OPENCODE_AUTO_START or point OPENCODE_BASE_URL at localhost"
    );
  }

  return {
    autoStartOpencode:
      explicitAutoStart === "true" ||
      (explicitAutoStart !== "false" && (!explicitBaseUrl || localHostname)),
    opencodeBaseUrl: baseUrl.origin,
    opencodePassword: password || undefined,
    opencodeUsername: username || undefined,
  };
}

function isLocalHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "[::1]" ||
    normalized.startsWith("127.")
  );
}

export function loadConfig(): ServerConfig {
  const rawPort = process.env.PORT ?? "2000";
  const port = Number.parseInt(rawPort, 10);

  if (!Number.isFinite(port) || port <= 0 || port >= 65_536) {
    throw new Error(
      `Invalid PORT "${rawPort}": must be a number between 1 and 65535`
    );
  }

  // Parsed once. Reading it twice risked the two sites drifting apart, which is
  // the exact failure this change exists to prevent.
  const opencodePort = parseTcpPort(
    process.env.OPENCODE_PORT,
    4096,
    "OPENCODE_PORT"
  );
  const engine = loadOpenCodeConfig(opencodePort);
  const opencodePerWorktree = parseBoolean(
    process.env.OPENCODE_PER_WORKTREE,
    false,
    "OPENCODE_PER_WORKTREE"
  );
  if (opencodePerWorktree && !engine.autoStartOpencode) {
    throw new Error(
      "OPENCODE_PER_WORKTREE=true requires a local, managed OpenCode engine; remove OPENCODE_BASE_URL or enable local auto-start"
    );
  }

  const bindAddress = process.env.CHORUS_BIND_ADDRESS ?? "127.0.0.1";
  if (!isIP(bindAddress)) {
    throw new Error("CHORUS_BIND_ADDRESS must be a literal IP address");
  }
  return {
    port,
    bindAddress,
    hostname: process.env.HOSTNAME ?? "localhost",
    // One source of truth for the engine address. Previously the process manager
    // hardcoded 4096 and this defaulted to `http://localhost:4096`
    // independently, so overriding one silently desynchronised the port we spawn
    // on from the URL every client request went to.
    opencodePort,
    ...engine,
    opencodePerWorktree,
    opencodeDirectory: process.env.OPENCODE_DIRECTORY ?? process.cwd(),
    // ~/.chorus keeps parity with where the pre-Phase-2 store wrote, so an
    // existing operator finds their state where they expect it.
    coalesceMs: parsePositive(process.env.COALESCE_MS, 100, "COALESCE_MS"),
    dataDir: process.env.DATA_DIR ?? path.join(homedir(), ".chorus"),
    dbSizeCapMb: parsePositive(
      process.env.DB_SIZE_CAP_MB,
      512,
      "DB_SIZE_CAP_MB"
    ),
    retentionDays: parsePositive(
      process.env.RETENTION_DAYS,
      30,
      "RETENTION_DAYS"
    ),
    snapshotInterval: parsePositive(
      process.env.SNAPSHOT_INTERVAL,
      1000,
      "SNAPSHOT_INTERVAL"
    ),
    enableLegacyWorkspaceImport:
      process.env.CHORUS_ENABLE_LEGACY_WORKSPACE_IMPORT === "true",
    pushAllowedHosts: parsePushAllowedHosts(process.env.PUSH_ALLOWED_HOSTS),
    pushEnabled: process.env.PUSH_ENABLED,
    vapidPrivateKey: process.env.VAPID_PRIVATE_KEY,
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY,
    vapidSubject: process.env.VAPID_SUBJECT,
  };
}

function parsePushAllowedHosts(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  const hosts = raw
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  if (
    hosts.some(
      (host) =>
        host.length > 253 ||
        host.startsWith(".") ||
        host.endsWith(".") ||
        !VALID_PUSH_HOST.test(host) ||
        host.includes("..")
    )
  ) {
    throw new Error(
      "Invalid PUSH_ALLOWED_HOSTS: use comma-separated DNS hostnames without schemes or paths"
    );
  }
  return [...new Set(hosts)];
}
