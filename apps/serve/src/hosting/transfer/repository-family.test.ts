import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { captureRepository } from "./capture-repository";
import { RepositoryContent } from "./content";
import { gitText, transferGit } from "./git";
import { stageRepositoryFamily } from "./stage-repository-family";

function reference(checkpoint: Awaited<ReturnType<typeof captureRepository>>) {
  return { directory: checkpoint.directory, digest: checkpoint.digest };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "chorus-family-transfer-"));
  const repo = join(root, "source");
  const worktree = join(repo, ".chorus-worktrees", "board-b");
  await mkdir(repo);
  await transferGit(repo, [
    "init",
    "--quiet",
    "--template=",
    "--initial-branch=main",
  ]);
  await transferGit(repo, ["config", "user.name", "Fixture"]);
  await transferGit(repo, ["config", "user.email", "fixture@example.invalid"]);
  await transferGit(repo, ["config", "core.autocrlf", "false"]);
  await writeFile(join(repo, "file.txt"), "base\n");
  await transferGit(repo, ["add", "file.txt"]);
  await transferGit(repo, ["commit", "--quiet", "--no-gpg-sign", "-m", "base"]);
  await transferGit(repo, [
    "worktree",
    "add",
    "--quiet",
    "-b",
    "second",
    worktree,
  ]);
  return { root, repo, worktree, target: join(root, "target") };
}

async function clean(root: string) {
  if (!resolve(root).startsWith(`${resolve(tmpdir())}${sep}`)) {
    throw new Error("not a temporary directory");
  }
  await rm(root, { recursive: true, force: true });
}

describe("repository family staging", () => {
  test("rolls back the whole new family when a linked worktree fails restoration", async () => {
    const files = await fixture();
    try {
      const primary = await captureRepository(
        files.repo,
        join(files.root, "primary")
      );
      const secondary = await captureRepository(
        files.worktree,
        join(files.root, "secondary")
      );
      const content = await RepositoryContent.open(secondary.directory);
      const patch = Buffer.from(
        "diff --git a/link b/link\nnew file mode 120000\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+../outside\n\\ No newline at end of file\n"
      );
      const bytes = Buffer.from(
        JSON.stringify({
          ...secondary.checkpoint,
          staged: await content.put(patch),
        })
      );
      await writeFile(join(secondary.directory, "manifest.json"), bytes);
      const digest = createHash("sha256").update(bytes).digest("hex");
      await mkdir(files.target);
      await writeFile(join(files.target, "keep.txt"), "existing manual work");
      await expect(
        stageRepositoryFamily(
          {
            primary: reference(primary),
            worktrees: [
              { directory: secondary.directory, digest, boardId: "board-b" },
            ],
          },
          files.target
        )
      ).rejects.toThrow("checkpoint_invalid");
      expect(await readdir(files.target)).toEqual(["keep.txt"]);
      expect(await gitText(files.repo, ["symbolic-ref", "HEAD"])).toBe(
        "refs/heads/main"
      );
      expect(await gitText(files.worktree, ["symbolic-ref", "HEAD"])).toBe(
        "refs/heads/second"
      );
    } finally {
      await clean(files.root);
    }
  }, 60_000);
  test("restores a real shared worktree with its own index and working files", async () => {
    const files = await fixture();
    try {
      await writeFile(join(files.repo, "file.txt"), "primary only\n");
      await writeFile(join(files.worktree, "file.txt"), "staged\n");
      await transferGit(files.worktree, ["add", "file.txt"]);
      await writeFile(join(files.worktree, "file.txt"), "working only\n");
      await writeFile(join(files.worktree, "untracked.txt"), "new\n");
      const primary = await captureRepository(
        files.repo,
        join(files.root, "primary")
      );
      const worktree = await captureRepository(
        files.worktree,
        join(files.root, "secondary")
      );
      const staged = await stageRepositoryFamily(
        {
          primary: reference(primary),
          worktrees: [{ ...reference(worktree), boardId: "board-b" }],
        },
        files.target
      );
      const path = staged.worktrees.get("board-b");
      if (!path) {
        throw new Error("worktree missing");
      }
      expect(
        await gitText(path, [
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ])
      ).toBe(
        await gitText(staged.repository, [
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ])
      );
      expect(await gitText(path, ["symbolic-ref", "HEAD"])).toBe(
        "refs/heads/second"
      );
      expect(await gitText(path, ["diff", "--cached", "--binary"])).toBe(
        await gitText(files.worktree, ["diff", "--cached", "--binary"])
      );
      expect(await readFile(join(path, "file.txt"), "utf8")).toBe(
        "working only\n"
      );
      expect(await readFile(join(path, "untracked.txt"), "utf8")).toBe("new\n");
      expect(await readFile(join(staged.repository, "file.txt"), "utf8")).toBe(
        "primary only\n"
      );
      expect(
        await gitText(staged.repository, ["worktree", "list", "--porcelain"])
      ).toContain(path.replaceAll("\\", "/"));
    } finally {
      await clean(files.root);
    }
  }, 60_000);

  test("imports a detached worktree commit unreachable from ordinary branches", async () => {
    const files = await fixture();
    try {
      await transferGit(files.worktree, ["checkout", "--quiet", "--detach"]);
      await writeFile(
        join(files.worktree, "detached.txt"),
        "detached history\n"
      );
      await transferGit(files.worktree, ["add", "detached.txt"]);
      await transferGit(files.worktree, [
        "commit",
        "--quiet",
        "--no-gpg-sign",
        "-m",
        "detached",
      ]);
      const primary = await captureRepository(
        files.repo,
        join(files.root, "primary")
      );
      const worktree = await captureRepository(
        files.worktree,
        join(files.root, "secondary")
      );
      const staged = await stageRepositoryFamily(
        {
          primary: reference(primary),
          worktrees: [{ ...reference(worktree), boardId: "board-b" }],
        },
        files.target
      );
      const path = staged.worktrees.get("board-b");
      if (!path) {
        throw new Error("worktree missing");
      }
      expect(await gitText(path, ["rev-parse", "HEAD"])).toBe(
        worktree.checkpoint.head ?? ""
      );
      expect(await readFile(join(path, "detached.txt"), "utf8")).toBe(
        "detached history\n"
      );
    } finally {
      await clean(files.root);
    }
  }, 60_000);

  test("rejects duplicate worktree branches and unsafe names before target writes", async () => {
    const files = await fixture();
    try {
      const primary = await captureRepository(
        files.repo,
        join(files.root, "primary")
      );
      await mkdir(files.target);
      await writeFile(join(files.target, "keep.txt"), "manual work");
      await expect(
        stageRepositoryFamily(
          {
            primary: reference(primary),
            worktrees: [{ ...reference(primary), boardId: "board-b" }],
          },
          files.target
        )
      ).rejects.toThrow("checkpoint_invalid");
      await expect(
        stageRepositoryFamily(
          {
            primary: reference(primary),
            worktrees: [{ ...reference(primary), boardId: "../escape" }],
          },
          files.target
        )
      ).rejects.toThrow();
      expect(await readdir(files.target)).toEqual(["keep.txt"]);
    } finally {
      await clean(files.root);
    }
  }, 60_000);
});
