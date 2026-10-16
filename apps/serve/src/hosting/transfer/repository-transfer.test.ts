import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { MAX_REPOSITORY_FILE_BYTES } from "@chorus/contracts";
import { captureRepository } from "./capture-repository";
import { RepositoryContent } from "./content";
import { gitText, transferGit } from "./git";
import { stageRepository } from "./stage-repository";

async function fixture(committed = true) {
  const root = await mkdtemp(join(tmpdir(), "chorus-repository-transfer-"));
  const repo = join(root, "source");
  await mkdir(repo);
  await transferGit(repo, [
    "init",
    "--quiet",
    "--template=",
    "--initial-branch=main",
  ]);
  await transferGit(repo, ["config", "user.name", "Transfer fixture"]);
  await transferGit(repo, ["config", "user.email", "fixture@example.invalid"]);
  await transferGit(repo, ["config", "core.autocrlf", "false"]);
  await writeFile(join(repo, ".gitignore"), "ignored/\nprivate.env\n");
  await writeFile(join(repo, "README.md"), "base\n");
  await writeFile(join(repo, "removed.txt"), "delete me\n");
  await writeFile(join(repo, "binary.bin"), Buffer.from([0, 255, 1, 128]));
  if (committed) {
    await transferGit(repo, ["add", "."]);
    await transferGit(repo, [
      "commit",
      "--quiet",
      "--no-gpg-sign",
      "-m",
      "base",
    ]);
    await transferGit(repo, ["branch", "feature"]);
    await transferGit(repo, ["tag", "v1"]);
  }
  return {
    root,
    repo,
    checkpoint: join(root, "checkpoint"),
    target: join(root, "targets"),
  };
}

async function clean(root: string) {
  if (!resolve(root).startsWith(`${resolve(tmpdir())}${sep}`)) {
    throw new Error("refusing to remove a non-temporary directory");
  }
  await rm(root, { recursive: true, force: true });
}

describe("portable repository checkpoints", () => {
  test("rejects external object stores, grafts and partial clones before creating a checkpoint", async () => {
    const files = await fixture();
    try {
      await writeFile(
        join(files.repo, ".git", "objects", "info", "alternates"),
        "../external\n"
      );
      await expect(
        captureRepository(files.repo, files.checkpoint)
      ).rejects.toThrow("repository_not_ready");
      expect(existsSync(files.checkpoint)).toBe(false);
      await rm(join(files.repo, ".git", "objects", "info", "alternates"));
      await mkdir(join(files.repo, ".git", "info"), { recursive: true });
      await writeFile(join(files.repo, ".git", "info", "grafts"), "");
      await expect(
        captureRepository(files.repo, files.checkpoint)
      ).rejects.toThrow("repository_not_ready");
      await rm(join(files.repo, ".git", "info", "grafts"));
      await transferGit(files.repo, [
        "config",
        "remote.origin.promisor",
        "true",
      ]);
      await expect(
        captureRepository(files.repo, files.checkpoint)
      ).rejects.toThrow("repository_not_ready");
      expect(existsSync(files.checkpoint)).toBe(false);
    } finally {
      await clean(files.root);
    }
  }, 30_000);
  test("preserves executable changes or rejects an incompatible Windows target", async () => {
    const files = await fixture();
    try {
      const captured = await captureRepository(files.repo, files.checkpoint);
      const manifest = {
        ...captured.checkpoint,
        files: captured.checkpoint.files.map((file) =>
          file.path === "README.md" ? { ...file, mode: "100755" } : file
        ),
      };
      const bytes = Buffer.from(JSON.stringify(manifest));
      await writeFile(join(files.checkpoint, "manifest.json"), bytes);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (process.platform === "win32") {
        await expect(
          stageRepository(files.checkpoint, digest, files.target)
        ).rejects.toThrow("target_incompatible");
        expect(await readdir(files.target)).toEqual([]);
      } else {
        const target = await stageRepository(
          files.checkpoint,
          digest,
          files.target
        );
        expect(await gitText(target, ["diff", "--summary"])).toContain(
          "mode change 100644 => 100755 README.md"
        );
      }
    } finally {
      await clean(files.root);
    }
  }, 30_000);
  test("rolls back validly hashed patches targeting Git metadata or introducing links", async () => {
    const files = await fixture();
    try {
      const captured = await captureRepository(files.repo, files.checkpoint);
      const content = await RepositoryContent.open(files.checkpoint);
      await mkdir(files.target);
      await writeFile(join(files.target, "keep.txt"), "manual work");
      for (const patch of [
        "diff --git a/.git/config b/.git/config\nnew file mode 100644\n--- /dev/null\n+++ b/.git/config\n@@ -0,0 +1 @@\n+malicious fixture\n",
        "diff --git a/link b/link\nnew file mode 120000\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+../outside\n\\ No newline at end of file\n",
      ]) {
        const manifest = {
          ...captured.checkpoint,
          staged: await content.put(Buffer.from(patch)),
        };
        const bytes = Buffer.from(JSON.stringify(manifest));
        await writeFile(join(files.checkpoint, "manifest.json"), bytes);
        const digest = createHash("sha256").update(bytes).digest("hex");
        await expect(
          stageRepository(files.checkpoint, digest, files.target)
        ).rejects.toThrow("checkpoint_invalid");
        expect(await readdir(files.target)).toEqual(["keep.txt"]);
      }
      expect(await readFile(join(files.target, "keep.txt"), "utf8")).toBe(
        "manual work"
      );
    } finally {
      await clean(files.root);
    }
  }, 30_000);
  test("preserves a completely empty repository", async () => {
    const files = await fixture(false);
    try {
      for (const name of [
        ".gitignore",
        "README.md",
        "removed.txt",
        "binary.bin",
      ]) {
        await rm(join(files.repo, name));
      }
      const captured = await captureRepository(files.repo, files.checkpoint);
      expect(captured.checkpoint.files).toEqual([]);
      const target = await stageRepository(
        files.checkpoint,
        captured.digest,
        files.target
      );
      expect(await gitText(target, ["status", "--porcelain"])).toBe("");
      expect(await gitText(target, ["symbolic-ref", "HEAD"])).toBe(
        "refs/heads/main"
      );
    } finally {
      await clean(files.root);
    }
  }, 30_000);
  test("rejects configured clean filters before comparing worktree content", async () => {
    const files = await fixture();
    try {
      await writeFile(
        join(files.repo, ".gitattributes"),
        "README.md filter=unsupported\n"
      );
      await transferGit(files.repo, [
        "config",
        "filter.unsupported.clean",
        "unavailable-filter-must-not-run",
      ]);
      await writeFile(join(files.repo, "README.md"), "pending content\n");
      await expect(
        captureRepository(files.repo, files.checkpoint)
      ).rejects.toThrow("repository_not_ready");
      expect(existsSync(files.checkpoint)).toBe(false);
    } finally {
      await clean(files.root);
    }
  }, 30_000);
  test("rejects special index states and links before capturing any content", async () => {
    const files = await fixture();
    try {
      await writeFile(join(files.repo, "intent.txt"), "pending\n");
      await transferGit(files.repo, ["add", "--intent-to-add", "intent.txt"]);
      await expect(
        captureRepository(files.repo, files.checkpoint)
      ).rejects.toThrow("repository_not_ready");
      await transferGit(files.repo, ["reset", "--quiet", "--", "intent.txt"]);
      await transferGit(files.repo, [
        "update-index",
        "--assume-unchanged",
        "README.md",
      ]);
      await expect(
        captureRepository(files.repo, files.checkpoint)
      ).rejects.toThrow("repository_not_ready");
      await transferGit(files.repo, [
        "update-index",
        "--no-assume-unchanged",
        "README.md",
      ]);
      const link = await gitText(files.repo, ["hash-object", "-w", "--stdin"], {
        input: "../private",
      });
      await transferGit(files.repo, [
        "update-index",
        "--add",
        "--cacheinfo",
        `120000,${link},unsafe-link`,
      ]);
      await expect(
        captureRepository(files.repo, files.checkpoint)
      ).rejects.toThrow("repository_not_ready");
      expect(existsSync(files.checkpoint)).toBe(false);
    } finally {
      await clean(files.root);
    }
  }, 30_000);

  test("enforces file limits and discards only its own failed checkpoint", async () => {
    const files = await fixture();
    try {
      const large = join(files.repo, "large.bin");
      await writeFile(large, "");
      await truncate(large, MAX_REPOSITORY_FILE_BYTES + 1);
      await expect(
        captureRepository(files.repo, files.checkpoint)
      ).rejects.toThrow("checkpoint_too_large");
      expect(existsSync(files.checkpoint)).toBe(false);
      expect(existsSync(large)).toBe(true);
      expect(await readFile(join(files.repo, "README.md"), "utf8")).toBe(
        "base\n"
      );
    } finally {
      await clean(files.root);
    }
  }, 30_000);

  test("retains detached HEAD and refuses shallow history", async () => {
    const files = await fixture();
    try {
      await transferGit(files.repo, ["checkout", "--quiet", "--detach"]);
      const captured = await captureRepository(files.repo, files.checkpoint);
      expect(captured.checkpoint.branch).toBeNull();
      const target = await stageRepository(
        files.checkpoint,
        captured.digest,
        files.target
      );
      expect(
        await gitText(target, ["symbolic-ref", "--quiet", "HEAD"], {
          allowFailure: true,
        })
      ).toBe("");
      expect(await gitText(target, ["rev-parse", "HEAD"])).toBe(
        captured.checkpoint.head ?? ""
      );
      await writeFile(
        join(files.repo, ".git", "shallow"),
        `${captured.checkpoint.head}\n`
      );
      await expect(
        captureRepository(files.repo, join(files.root, "shallow-checkpoint"))
      ).rejects.toThrow("repository_not_ready");
    } finally {
      await clean(files.root);
    }
  }, 30_000);

  test("preserves code/history and staged/unstaged bytes while excluding ignored files and machine configuration", async () => {
    const files = await fixture();
    try {
      await transferGit(files.repo, [
        "remote",
        "add",
        "origin",
        "https://fixture:private-configuration@example.invalid/repo.git",
      ]);
      await writeFile(join(files.repo, "README.md"), "staged\n");
      await writeFile(
        join(files.repo, "binary.bin"),
        Buffer.from([0, 255, 2, 128])
      );
      await writeFile(join(files.repo, "new staged.txt"), "new\n");
      await transferGit(files.repo, [
        "add",
        "README.md",
        "binary.bin",
        "new staged.txt",
      ]);
      await writeFile(join(files.repo, "README.md"), "unstaged\r\n");
      await writeFile(
        join(files.repo, "binary.bin"),
        Buffer.from([0, 255, 3, 128])
      );
      await rm(join(files.repo, "removed.txt"));
      await writeFile(join(files.repo, "notes file.txt"), "untracked\n");
      await mkdir(join(files.repo, "ignored"));
      await writeFile(join(files.repo, "ignored", "cache"), "do not transfer");
      await writeFile(
        join(files.repo, "private.env"),
        "private fixture configuration"
      );
      const ignoreFile = join(files.root, "global-ignore");
      await writeFile(ignoreFile, "extra.env\n");
      await transferGit(files.repo, [
        "config",
        "core.excludesFile",
        ignoreFile,
      ]);
      await writeFile(
        join(files.repo, "extra.env"),
        "machine-only ignored data"
      );
      await mkdir(join(files.repo, ".chorus-worktrees"));
      await writeFile(
        join(files.repo, ".chorus-worktrees", "control"),
        "not portable workspace data"
      );
      const sourceHead = await gitText(files.repo, ["rev-parse", "HEAD"]);
      const captured = await captureRepository(files.repo, files.checkpoint);
      const target = await stageRepository(
        files.checkpoint,
        captured.digest,
        files.target
      );
      expect(await readFile(join(target, "README.md"), "utf8")).toBe(
        "unstaged\r\n"
      );
      expect(await gitText(target, ["show", ":README.md"])).toBe("staged");
      expect(await readFile(join(target, "binary.bin"))).toEqual(
        Buffer.from([0, 255, 3, 128])
      );
      expect(await readFile(join(target, "notes file.txt"), "utf8")).toBe(
        "untracked\n"
      );
      expect(existsSync(join(target, "removed.txt"))).toBe(false);
      expect(existsSync(join(target, "private.env"))).toBe(false);
      expect(existsSync(join(target, "extra.env"))).toBe(false);
      expect(existsSync(join(target, "ignored"))).toBe(false);
      expect(existsSync(join(target, ".chorus-worktrees"))).toBe(false);
      expect(await gitText(target, ["rev-parse", "HEAD"])).toBe(sourceHead);
      expect(await gitText(target, ["symbolic-ref", "HEAD"])).toBe(
        "refs/heads/main"
      );
      expect(await gitText(target, ["show-ref"])).toBe(
        await gitText(files.repo, ["show-ref"])
      );
      expect(
        await gitText(target, ["diff", "--cached", "--binary", "--full-index"])
      ).toBe(
        await gitText(files.repo, [
          "diff",
          "--cached",
          "--binary",
          "--full-index",
        ])
      );
      expect(await gitText(target, ["diff", "--binary", "--full-index"])).toBe(
        await gitText(files.repo, ["diff", "--binary", "--full-index"])
      );
      expect(
        await gitText(target, ["config", "--get", "remote.origin.url"], {
          allowFailure: true,
        })
      ).toBe("");
      expect(
        await readFile(join(files.checkpoint, "manifest.json"), "utf8")
      ).not.toContain("private-configuration");
    } finally {
      await clean(files.root);
    }
  }, 30_000);

  test("stages a repository with no commits without inventing history", async () => {
    const files = await fixture(false);
    try {
      await transferGit(files.repo, ["add", "README.md"]);
      const captured = await captureRepository(files.repo, files.checkpoint);
      expect(captured.checkpoint.head).toBeNull();
      expect(captured.checkpoint.history).toBeNull();
      const target = await stageRepository(
        files.checkpoint,
        captured.digest,
        files.target
      );
      expect(await gitText(target, ["show", ":README.md"])).toBe("base");
      expect(await readFile(join(target, "README.md"), "utf8")).toBe("base\n");
      expect(await gitText(target, ["symbolic-ref", "HEAD"])).toBe(
        "refs/heads/main"
      );
    } finally {
      await clean(files.root);
    }
  }, 30_000);

  test("rejects altered payloads and preserves existing destination work", async () => {
    const files = await fixture();
    try {
      const captured = await captureRepository(files.repo, files.checkpoint);
      await mkdir(join(files.target, "existing"), { recursive: true });
      await writeFile(
        join(files.target, "existing", "keep.txt"),
        "manual edits"
      );
      await expect(
        stageRepository(files.checkpoint, "0".repeat(64), files.target)
      ).rejects.toThrow("checkpoint_invalid");
      const content = captured.checkpoint.files[0]?.content;
      if (!content) {
        throw new Error("fixture checkpoint must contain a file");
      }
      await writeFile(
        join(files.checkpoint, "data", content.digest),
        "altered"
      );
      await expect(
        stageRepository(files.checkpoint, captured.digest, files.target)
      ).rejects.toThrow("checkpoint_invalid");
      expect(
        await readFile(join(files.target, "existing", "keep.txt"), "utf8")
      ).toBe("manual edits");
      await expect(
        captureRepository(files.repo, files.checkpoint)
      ).rejects.toThrow("destination_exists");
    } finally {
      await clean(files.root);
    }
  }, 30_000);
});
