import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./index";

describe("loadConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("returns defaults when no env vars are set", () => {
    process.env.PORT = undefined as unknown as string;
    process.env.HOSTNAME = undefined as unknown as string;
    process.env.OPENCODE_BASE_URL = undefined as unknown as string;
    process.env.OPENCODE_DIRECTORY = undefined as unknown as string;
    process.env.DATA_DIR = undefined as unknown as string;
    process.env.RETENTION_DAYS = undefined as unknown as string;
    process.env.DB_SIZE_CAP_MB = undefined as unknown as string;
    process.env.SNAPSHOT_INTERVAL = undefined as unknown as string;
    process.env.COALESCE_MS = undefined as unknown as string;

    const config = loadConfig();

    expect(config.port).toBe(2000);
    expect(config.hostname).toBe("localhost");
    expect(config.opencodeBaseUrl).toBe("http://localhost:4096");
    expect(config.opencodeDirectory).toBe(process.cwd());
    // Parity with where the pre-Phase-2 JSON store kept its state.
    expect(config.dataDir).toBe(join(homedir(), ".chorus"));
    expect(config.retentionDays).toBe(30);
    expect(config.dbSizeCapMb).toBe(512);
    expect(config.snapshotInterval).toBe(1000);
    expect(config.coalesceMs).toBe(100);
    // Off by default so the legacy import path can be deleted once migrated.
    expect(config.enableLegacyWorkspaceImport).toBe(false);
  });

  test("reads PORT from env", () => {
    process.env.PORT = "3000";

    const config = loadConfig();

    expect(config.port).toBe(3000);
  });

  test("reads HOSTNAME from env", () => {
    process.env.HOSTNAME = "0.0.0.0";

    const config = loadConfig();

    expect(config.hostname).toBe("0.0.0.0");
  });

  test("reads OPENCODE_BASE_URL from env", () => {
    process.env.OPENCODE_BASE_URL = "http://example.com:9999";

    const config = loadConfig();

    expect(config.opencodeBaseUrl).toBe("http://example.com:9999");
  });

  test("reads OPENCODE_DIRECTORY from env", () => {
    process.env.OPENCODE_DIRECTORY = "/tmp/test-dir";

    const config = loadConfig();

    expect(config.opencodeDirectory).toBe("/tmp/test-dir");
  });

  test("parses PORT as a number", () => {
    process.env.PORT = "8080";

    const config = loadConfig();

    expect(typeof config.port).toBe("number");
    expect(config.port).toBe(8080);
  });

  test("handles all env vars set simultaneously", () => {
    process.env.PORT = "5000";
    process.env.HOSTNAME = "127.0.0.1";
    process.env.OPENCODE_BASE_URL = "http://opencode:4096";
    process.env.OPENCODE_DIRECTORY = "/workspace";
    process.env.DATA_DIR = "/data";
    process.env.RETENTION_DAYS = "7";
    process.env.DB_SIZE_CAP_MB = "256";
    process.env.SNAPSHOT_INTERVAL = "500";
    process.env.COALESCE_MS = "75";
    process.env.CHORUS_ENABLE_LEGACY_WORKSPACE_IMPORT = "true";

    const config = loadConfig();

    expect(config).toEqual({
      port: 5000,
      hostname: "127.0.0.1",
      opencodeBaseUrl: "http://opencode:4096",
      opencodePort: 4096,
      opencodeDirectory: "/workspace",
      autoStartOpencode: true,
      coalesceMs: 75,
      dataDir: "/data",
      retentionDays: 7,
      dbSizeCapMb: 256,
      snapshotInterval: 500,
      enableLegacyWorkspaceImport: true,
    });
  });

  test("rejects a non-positive or non-numeric retention window", () => {
    // Each setting is checked on its own: setting all three at once would just
    // surface whichever happens to be validated first.
    process.env.RETENTION_DAYS = "0";
    expect(() => loadConfig()).toThrow('Invalid RETENTION_DAYS "0"');

    process.env.RETENTION_DAYS = "-1";
    expect(() => loadConfig()).toThrow('Invalid RETENTION_DAYS "-1"');

    process.env.RETENTION_DAYS = "many";
    expect(() => loadConfig()).toThrow('Invalid RETENTION_DAYS "many"');
  });

  test("rejects a non-positive size cap", () => {
    process.env.DB_SIZE_CAP_MB = "0";
    expect(() => loadConfig()).toThrow('Invalid DB_SIZE_CAP_MB "0"');
  });

  test("rejects a non-positive snapshot interval", () => {
    process.env.SNAPSHOT_INTERVAL = "0";
    expect(() => loadConfig()).toThrow('Invalid SNAPSHOT_INTERVAL "0"');
  });

  test("treats an empty string as unset for retention settings", () => {
    process.env.RETENTION_DAYS = "";
    expect(loadConfig().retentionDays).toBe(30);
  });

  test("throws on non-numeric PORT", () => {
    process.env.PORT = "not-a-number";

    expect(() => loadConfig()).toThrow(
      'Invalid PORT "not-a-number": must be a number between 1 and 65535'
    );
  });

  test("throws on PORT out of range (zero)", () => {
    process.env.PORT = "0";

    expect(() => loadConfig()).toThrow(
      'Invalid PORT "0": must be a number between 1 and 65535'
    );
  });

  test("throws on PORT out of range (negative)", () => {
    process.env.PORT = "-1";

    expect(() => loadConfig()).toThrow(
      'Invalid PORT "-1": must be a number between 1 and 65535'
    );
  });

  test("throws on PORT out of range (too high)", () => {
    process.env.PORT = "70000";

    expect(() => loadConfig()).toThrow(
      'Invalid PORT "70000": must be a number between 1 and 65535'
    );
  });

  test("accepts boundary ports (1 and 65535)", () => {
    process.env.PORT = "1";
    expect(loadConfig().port).toBe(1);

    process.env.PORT = "65535";
    expect(loadConfig().port).toBe(65_535);
  });
});
