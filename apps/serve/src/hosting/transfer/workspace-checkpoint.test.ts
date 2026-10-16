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
import {
  workspaceCheckpointSchema,
  workspaceSnapshotSchema,
} from "@chorus/contracts";
import { captureRepository } from "./capture-repository";
import { RepositoryContent } from "./content";
import { gitText, transferGit } from "./git";
import { captureReviewObjects } from "./review-objects";
import {
  publishWorkspaceCheckpoint,
  stageWorkspaceCheckpoint,
} from "./workspace-checkpoint";
import { captureWorkspaceState } from "./workspace-state";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "chorus-workspace-transfer-"));
  const source = join(root, "source");
  const worktree = join(source, ".chorus-worktrees", "board-b");
  await mkdir(source);
  await transferGit(source, [
    "init",
    "--quiet",
    "--template=",
    "--initial-branch=main",
  ]);
  await transferGit(source, ["config", "user.name", "Fixture"]);
  await transferGit(source, [
    "config",
    "user.email",
    "fixture@example.invalid",
  ]);
  await transferGit(source, ["config", "core.autocrlf", "false"]);
  await writeFile(join(source, "app.txt"), "base\n");
  await transferGit(source, ["add", "app.txt"]);
  await transferGit(source, [
    "commit",
    "--quiet",
    "--no-gpg-sign",
    "-m",
    "base",
  ]);
  await transferGit(source, [
    "worktree",
    "add",
    "--quiet",
    "--detach",
    worktree,
  ]);
  await writeFile(join(worktree, "app.txt"), "working\n");
  const primary = await captureRepository(source, join(root, "primary"));
  const secondary = await captureRepository(worktree, join(root, "secondary"));
  const reviewDirectory = join(root, "reviews");
  await mkdir(reviewDirectory);
  await transferGit(reviewDirectory, [
    "init",
    "--quiet",
    "--bare",
    "--template=",
  ]);
  const blob = await gitText(
    reviewDirectory,
    ["hash-object", "-w", "--stdin"],
    { input: "review baseline\n" }
  );
  const tree = await gitText(reviewDirectory, ["mktree"], {
    input: `100644 blob ${blob}\tapp.txt\n`,
  });
  const review = await captureReviewObjects(
    reviewDirectory,
    [tree],
    await RepositoryContent.open(primary.directory)
  );
  const repositoryId = crypto.randomUUID();
  const primaryId = crypto.randomUUID();
  const secondaryId = crypto.randomUUID();
  const authority = {
    workspaceId: crypto.randomUUID(),
    hostId: crypto.randomUUID(),
    epoch: 7,
  };
  const snapshot = workspaceSnapshotSchema.parse({
    boards: [
      {
        boardId: "board-b",
        title: "App",
        repo: { directory: source, worktree, sandboxes: [] },
        position: { x: 1, y: 2 },
        columns: { queue: [], in_progress: [], approve: [], done: [] },
        modelSelection: null,
        session: { state: "uninitialized" },
      },
    ],
    preferences: { composerHintDismissed: false },
    previousWorkspaces: [],
    revision: 3,
    selectedBoardId: "board-b",
  });
  const state = captureWorkspaceState(snapshot, authority, [
    {
      repositoryId,
      checkoutId: primaryId,
      repository: source,
      checkout: source,
    },
    {
      repositoryId,
      checkoutId: secondaryId,
      repository: source,
      checkout: worktree,
    },
  ]);
  const checkpoint = workspaceCheckpointSchema.parse({
    version: 1,
    state,
    repositories: [
      {
        repositoryId,
        primary: { checkoutId: primaryId, checkpointHash: primary.digest },
        worktrees: [
          {
            boardId: "board-b",
            checkoutId: secondaryId,
            checkpointHash: secondary.digest,
          },
        ],
        reviews: [{ checkoutId: primaryId, checkpoint: review }],
      },
    ],
  });
  const sources = [
    { checkoutId: primaryId, directory: primary.directory },
    { checkoutId: secondaryId, directory: secondary.directory },
  ];
  return {
    root,
    source,
    sources,
    tree,
    checkpoint,
    authority,
    target: join(root, "target"),
    publication: join(root, "publication"),
  };
}
async function clean(root: string) {
  if (!resolve(root).startsWith(`${resolve(tmpdir())}${sep}`)) {
    throw new Error("not a temporary directory");
  }
  await rm(root, { recursive: true, force: true });
}

describe("whole-workspace checkpoint staging", () => {
  test("binds state, repository family and review objects and survives source artifact loss", async () => {
    const files = await fixture();
    try {
      const published = await publishWorkspaceCheckpoint(
        files.checkpoint,
        files.sources,
        files.publication
      );
      for (const source of files.sources) {
        await rm(source.directory, { recursive: true, force: true });
      }
      const staged = await stageWorkspaceCheckpoint(
        published.directory,
        published.digest,
        files.target
      );
      const board = staged.snapshot.boards[0];
      if (!(board && staged.reviewStores[0])) {
        throw new Error("staged workspace missing");
      }
      expect(staged.authority).toEqual(files.authority);
      expect(staged.snapshot.revision).toBe(3);
      expect(board.repo.directory).not.toBe(files.source);
      expect(await readFile(join(board.repo.worktree, "app.txt"), "utf8")).toBe(
        "working\n"
      );
      expect(
        await gitText(board.repo.directory, [
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ])
      ).toBe(
        await gitText(board.repo.worktree, [
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ])
      );
      expect(
        await gitText(staged.reviewStores[0].directory, [
          "show",
          `${files.tree}:app.txt`,
        ])
      ).toBe("review baseline");
      expect(await readdir(files.target)).toHaveLength(1);
    } finally {
      await clean(files.root);
    }
  }, 60_000);
  test("rejects altered nested metadata before staging and preserves existing target work", async () => {
    const files = await fixture();
    try {
      const published = await publishWorkspaceCheckpoint(
        files.checkpoint,
        files.sources,
        files.publication
      );
      const manifestPath = join(published.directory, "workspace.json");
      const manifest = await readFile(manifestPath);
      await writeFile(
        manifestPath,
        Buffer.concat([manifest, Buffer.from("\n")])
      );
      await expect(
        stageWorkspaceCheckpoint(
          published.directory,
          published.digest,
          files.target
        )
      ).rejects.toThrow("checkpoint_invalid");
      await writeFile(manifestPath, manifest);
      const primary = files.checkpoint.repositories[0]?.primary;
      if (!primary) {
        throw new Error("fixture repository missing");
      }
      await writeFile(
        join(
          published.directory,
          "checkouts",
          primary.checkoutId,
          "manifest.json"
        ),
        "{}"
      );
      await mkdir(files.target);
      await writeFile(join(files.target, "keep.txt"), "manual work");
      await expect(
        stageWorkspaceCheckpoint(
          published.directory,
          published.digest,
          files.target
        )
      ).rejects.toThrow("checkpoint_invalid");
      expect(await readdir(files.target)).toEqual(["keep.txt"]);
    } finally {
      await clean(files.root);
    }
  }, 60_000);
  test("rolls back all new repository and review staging after invalid review-root verification", async () => {
    const files = await fixture();
    try {
      const review = files.checkpoint.repositories[0]?.reviews[0];
      if (!review) {
        throw new Error("fixture review missing");
      }
      review.checkpoint.trees = ["a".repeat(40)];
      const published = await publishWorkspaceCheckpoint(
        files.checkpoint,
        files.sources,
        files.publication
      );
      await mkdir(files.target);
      await writeFile(join(files.target, "keep.txt"), "manual work");
      await expect(
        stageWorkspaceCheckpoint(
          published.directory,
          published.digest,
          files.target
        )
      ).rejects.toThrow("checkpoint_invalid");
      expect(await readdir(files.target)).toEqual(["keep.txt"]);
    } finally {
      await clean(files.root);
    }
  }, 60_000);
  test("rejects inconsistent checkout graphs and duplicate artifact sources", async () => {
    const files = await fixture();
    try {
      const repository = files.checkpoint.repositories[0];
      if (!repository) {
        throw new Error("fixture repository missing");
      }
      expect(
        workspaceCheckpointSchema.safeParse({
          ...files.checkpoint,
          repositories: [repository, repository],
        }).success
      ).toBe(false);
      expect(
        workspaceCheckpointSchema.safeParse({
          ...files.checkpoint,
          repositories: [],
        }).success
      ).toBe(false);
      const wrongBoard = structuredClone(files.checkpoint);
      const worktree = wrongBoard.repositories[0]?.worktrees[0];
      if (!worktree) {
        throw new Error("fixture worktree missing");
      }
      worktree.boardId = "different-board";
      expect(workspaceCheckpointSchema.safeParse(wrongBoard).success).toBe(
        false
      );
      await expect(
        publishWorkspaceCheckpoint(
          files.checkpoint,
          [...files.sources, ...files.sources],
          files.publication
        )
      ).rejects.toThrow("checkpoint_invalid");
      await expect(
        publishWorkspaceCheckpoint(
          files.checkpoint,
          files.sources.slice(0, 1),
          files.publication
        )
      ).rejects.toThrow("checkpoint_invalid");
    } finally {
      await clean(files.root);
    }
  }, 60_000);
});
