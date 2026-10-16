import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { verifiedConnectorBinaries } from "./connector-binaries";

describe("packaged connector integrity", () => {
  test("verifies release hashes before execution and rejects corruption or the wrong platform", async () => {
    const root = await mkdtemp(join(tmpdir(), "chorus-connectors-"));
    const extension = process.platform === "win32" ? ".exe" : "";
    const content = "verification-fixture-never-executed";
    const hash = createHash("sha256").update(content).digest("hex");
    const manifest = {
      platform: process.platform,
      arch: process.arch,
      caddy: { version: "2.11.7", sha256: hash },
      frpc: { version: "0.71.1", sha256: hash },
    };
    try {
      await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
      await writeFile(join(root, `caddy${extension}`), content);
      await writeFile(join(root, `frpc${extension}`), content);
      expect(await verifiedConnectorBinaries(root)).toEqual({
        caddy: join(root, `caddy${extension}`),
        frpc: join(root, `frpc${extension}`),
      });
      await writeFile(join(root, `frpc${extension}`), "tampered");
      await expect(verifiedConnectorBinaries(root)).rejects.toThrow(
        "verification failed"
      );
      await writeFile(
        join(root, "manifest.json"),
        JSON.stringify({
          ...manifest,
          arch: process.arch === "x64" ? "arm64" : "x64",
        })
      );
      await expect(verifiedConnectorBinaries(root)).rejects.toThrow(
        "do not match"
      );
    } finally {
      if (resolve(root).startsWith(`${resolve(tmpdir())}${sep}`)) {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
});
