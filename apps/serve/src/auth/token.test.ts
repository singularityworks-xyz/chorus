import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateToken,
  MissingTokenError,
  persistToken,
  resolveToken,
  TOKEN_FILE_NAME,
} from "./token";

const HEX_64 = /^[0-9a-f]{64}$/;

/** File-mode mask: keeps the permission bits and drops the file-type bits. */
const MODE_MASK = 0o777;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "chorus-token-"));
}

describe("CHORUS_TOKEN lifecycle (spec §6.1, decision #4)", () => {
  test("generates 64 hex chars — 256 bits, not a UUID", () => {
    const token = generateToken();

    // 32 bytes hex-encoded. A UUID v4 would be 36 chars with dashes; 122 bits is
    // the entropy the plan explicitly rejects for this value.
    expect(token).toHaveLength(64);
    expect(token).toMatch(HEX_64);
  });

  test("generated tokens do not repeat", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 64; index += 1) {
      seen.add(generateToken());
    }

    expect(seen.size).toBe(64);
  });

  test("the token file is written with 0600", async () => {
    const dir = tempDir();
    try {
      const path = await persistToken(dir, generateToken());

      // biome-ignore lint/suspicious/noBitwiseOperators: reading POSIX mode bits
      expect(statSync(path).mode & MODE_MASK).toBe(0o600);
      expect(path.endsWith(TOKEN_FILE_NAME)).toBe(true);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("production without CHORUS_TOKEN refuses to boot", async () => {
    const dir = tempDir();
    try {
      // Auto-generating here would hand an operator a credential they cannot
      // find, on a machine that is about to be exposed to the internet.
      await expect(
        resolveToken({ dataDir: dir, isProduction: true })
      ).rejects.toBeInstanceOf(MissingTokenError);

      await expect(
        resolveToken({ dataDir: dir, envToken: "   ", isProduction: true })
      ).rejects.toBeInstanceOf(MissingTokenError);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("the production error names .env.example", async () => {
    const dir = tempDir();
    try {
      const outcome = await resolveToken({
        dataDir: dir,
        isProduction: true,
      }).then(
        () => null,
        (caught: unknown) => caught
      );

      expect(outcome).toBeInstanceOf(MissingTokenError);
      const message = outcome instanceof Error ? outcome.message : "";
      expect(message).toContain(".env.example");
      expect(message).toContain("CHORUS_TOKEN");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("production accepts an explicit token and writes no file", async () => {
    const dir = tempDir();
    try {
      const resolved = await resolveToken({
        dataDir: dir,
        envToken: "operator-chosen-token",
        isProduction: true,
      });

      expect(resolved.source).toBe("environment");
      expect(resolved.token).toBe("operator-chosen-token");
      // An operator-supplied token is never written to disk.
      expect(() => statSync(join(dir, TOKEN_FILE_NAME))).toThrow();
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("development generates on first boot and reuses on the next", async () => {
    const dir = tempDir();
    try {
      const first = await resolveToken({ dataDir: dir, isProduction: false });

      expect(first.source).toBe("generated");
      expect(first.token).toHaveLength(64);
      // biome-ignore lint/suspicious/noBitwiseOperators: reading POSIX mode bits
      expect(statSync(first.tokenPath).mode & MODE_MASK).toBe(0o600);

      // A restart must not orphan the token the operator already copied out.
      const second = await resolveToken({ dataDir: dir, isProduction: false });
      expect(second.source).toBe("persisted");
      expect(second.token).toBe(first.token);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("the env token wins over a persisted file in development", async () => {
    const dir = tempDir();
    try {
      await persistToken(dir, "from-disk");

      const resolved = await resolveToken({
        dataDir: dir,
        envToken: "from-env",
        isProduction: false,
      });

      expect(resolved.source).toBe("environment");
      expect(resolved.token).toBe("from-env");
      // The on-disk token is left alone rather than overwritten.
      expect(readFileSync(join(dir, TOKEN_FILE_NAME), "utf8").trim()).toBe(
        "from-disk"
      );
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("a blank persisted file is replaced rather than trusted", async () => {
    const dir = tempDir();
    try {
      const path = join(dir, TOKEN_FILE_NAME);
      await Bun.write(path, "\n\n");

      const resolved = await resolveToken({
        dataDir: dir,
        isProduction: false,
      });

      expect(resolved.source).toBe("generated");
      expect(resolved.token).toHaveLength(64);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
