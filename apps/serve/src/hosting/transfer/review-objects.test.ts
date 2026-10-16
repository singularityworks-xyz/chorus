import { describe, expect, test } from "bun:test";
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
import { RepositoryContent } from "./content";
import { gitText, transferGit } from "./git";
import { captureReviewObjects, stageReviewObjects } from "./review-objects";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "chorus-review-transfer-"));
  const source = join(root, "source");
  await mkdir(source);
  await transferGit(source, ["init", "--quiet", "--bare", "--template="]);
  const blob = await gitText(source, ["hash-object", "-w", "--stdin"], {
    input: "review before\n",
  });
  const tree = await gitText(source, ["mktree"], {
    input: `100644 blob ${blob}\tbefore.txt\n`,
  });
  const privateBlob = await gitText(source, ["hash-object", "-w", "--stdin"], {
    input: "unrelated private content\n",
  });
  await transferGit(source, [
    "config",
    "chorus.private",
    "fixture-secret-must-not-transfer",
  ]);
  const content = await RepositoryContent.create(join(root, "checkpoint"));
  return {
    root,
    source,
    blob,
    tree,
    privateBlob,
    content,
    target: join(root, "target"),
  };
}

async function clean(root: string) {
  if (!resolve(root).startsWith(`${resolve(tmpdir())}${sep}`)) {
    throw new Error("not a temporary directory");
  }
  await rm(root, { recursive: true, force: true });
}

describe("review object checkpoints", () => {
  test("preserves loose tree roots across source loss without copying unrelated objects or config", async () => {
    const files = await fixture();
    try {
      const checkpoint = await captureReviewObjects(
        files.source,
        [files.tree, files.tree],
        files.content
      );
      expect(checkpoint.trees).toEqual([files.tree]);
      await rm(files.source, { recursive: true, force: true });
      const target = await stageReviewObjects(
        checkpoint,
        files.content,
        files.target
      );
      expect(await gitText(target, ["show", `${files.tree}:before.txt`])).toBe(
        "review before"
      );
      await expect(
        gitText(target, ["cat-file", "-t", files.privateBlob])
      ).rejects.toThrow();
      expect(await readFile(join(target, "config"), "utf8")).not.toContain(
        "fixture-secret"
      );
      expect(
        await gitText(target, ["rev-parse", `refs/chorus/review/${files.tree}`])
      ).toBe(files.tree);
    } finally {
      await clean(files.root);
    }
  }, 30_000);
  test("rejects blobs, links, traversal roots and metadata paths before packing", async () => {
    const files = await fixture();
    try {
      await expect(
        captureReviewObjects(files.source, [files.blob], files.content)
      ).rejects.toThrow("checkpoint_invalid");
      await expect(
        captureReviewObjects(files.source, ["--all"], files.content)
      ).rejects.toThrow();
      for (const input of [
        `120000 blob ${files.blob}\tlink\n`,
        `100644 blob ${files.blob}\tREADME\n100644 blob ${files.blob}\treadme\n`,
      ]) {
        const tree = await gitText(files.source, ["mktree"], {
          input,
        });
        await expect(
          captureReviewObjects(files.source, [tree], files.content)
        ).rejects.toThrow("checkpoint_invalid");
      }
      const controlTree = await gitText(files.source, ["mktree"], {
        input: `040000 tree ${files.tree}\t.git\n`,
      });
      await expect(
        captureReviewObjects(files.source, [controlTree], files.content)
      ).rejects.toThrow("checkpoint_invalid");
    } finally {
      await clean(files.root);
    }
  }, 30_000);
  test("removes only its own staging directory after a correctly hashed malformed pack", async () => {
    const files = await fixture();
    try {
      const checkpoint = await captureReviewObjects(
        files.source,
        [files.tree],
        files.content
      );
      const objects = await files.content.put(Buffer.from("not a Git pack"));
      await mkdir(files.target);
      await writeFile(join(files.target, "keep.txt"), "manual edits");
      await expect(
        stageReviewObjects(
          { ...checkpoint, objects },
          files.content,
          files.target
        )
      ).rejects.toThrow("checkpoint_invalid");
      expect(await readdir(files.target)).toEqual(["keep.txt"]);
    } finally {
      await clean(files.root);
    }
  }, 30_000);
  test("revalidates tree safety on import even when the sender supplied a real pack", async () => {
    const files = await fixture();
    try {
      const unsafe = await gitText(files.source, ["mktree"], {
        input: `120000 blob ${files.blob}\tlink\n`,
      });
      const pack = await transferGit(
        files.source,
        ["pack-objects", "--stdout", "--revs"],
        { input: `${unsafe}\n` }
      );
      const objects = await files.content.put(pack.bytes);
      await expect(
        stageReviewObjects(
          { version: 1, objectFormat: "sha1", trees: [unsafe], objects },
          files.content,
          files.target
        )
      ).rejects.toThrow("checkpoint_invalid");
      expect(await readdir(files.target)).toEqual([]);
    } finally {
      await clean(files.root);
    }
  }, 30_000);
});
