import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { resolveToken } from "./token";

describe("installed production signing root", () => {
  test("persists an encrypted internal root without requiring an operator token", async () => {
    const root = await mkdtemp(join(tmpdir(), "chorus-managed-entry-"));
    try {
      const options = {
        dataDir: root,
        isProduction: true,
        managedLocalEntry: true,
      };
      const first = await resolveToken(options);
      expect(first.source).toBe("host-vault");
      expect(first.token).toHaveLength(64);
      const second = await resolveToken(options);
      expect(second.token).toBe(first.token);
      expect(
        (await readFile(join(root, "host", "vault.db"))).includes(
          Buffer.from(first.token)
        )
      ).toBe(false);
      await expect(readFile(join(root, "chorus.token"))).rejects.toThrow();
    } finally {
      if (resolve(root).startsWith(`${resolve(tmpdir())}${sep}`)) {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
});
