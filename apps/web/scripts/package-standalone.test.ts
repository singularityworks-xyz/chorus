import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageStandaloneAssets } from "./package-standalone";

describe("packageStandaloneAssets", () => {
  test("copies fresh public and Next static assets into the traced app output", async () => {
    const root = await mkdtemp(join(tmpdir(), "chorus-standalone-assets-"));
    const app = join(root, "apps", "web");
    const output = join(app, ".next", "standalone", "apps", "web");
    try {
      await mkdir(join(output, ".next", "static", "chunks"), {
        recursive: true,
      });
      await mkdir(join(output, "public"), { recursive: true });
      await mkdir(join(app, ".next", "static", "chunks"), {
        recursive: true,
      });
      await mkdir(join(app, "public"), { recursive: true });
      await writeFile(join(output, "server.js"), "standalone server");
      await writeFile(
        join(output, ".next", "static", "chunks", "stale.js"),
        "stale"
      );
      await writeFile(join(output, "public", "stale.svg"), "stale");
      await writeFile(
        join(app, ".next", "static", "chunks", "main.js"),
        "current runtime"
      );
      await writeFile(
        join(app, "public", "manifest.webmanifest"),
        "current public"
      );

      await packageStandaloneAssets({ appDirectory: app, tracingRoot: root });

      expect(
        await readFile(
          join(output, ".next", "static", "chunks", "main.js"),
          "utf8"
        )
      ).toBe("current runtime");
      expect(
        await readFile(join(output, "public", "manifest.webmanifest"), "utf8")
      ).toBe("current public");
      await expect(
        readFile(join(output, ".next", "static", "chunks", "stale.js"))
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        readFile(join(output, "public", "stale.svg"))
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("fails clearly when Next has not emitted standalone assets", async () => {
    const root = await mkdtemp(join(tmpdir(), "chorus-standalone-missing-"));
    const app = join(root, "apps", "web");
    try {
      await mkdir(app, { recursive: true });
      await expect(
        packageStandaloneAssets({ appDirectory: app, tracingRoot: root })
      ).rejects.toThrow("Standalone server is missing");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("rejects an app directory outside the tracing root", async () => {
    const root = await mkdtemp(join(tmpdir(), "chorus-standalone-path-"));
    try {
      await expect(
        packageStandaloneAssets({
          appDirectory: join(root, "../web"),
          tracingRoot: root,
        })
      ).rejects.toThrow("must be inside the tracing root");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
