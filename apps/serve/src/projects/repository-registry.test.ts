import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceStore } from "../workspace/store";
import { RepositoryRegistry } from "./repository-registry";
import { WorktreeManager } from "./worktree-manager";

function makeRepository(): string {
  const directory = mkdtempSync(join(tmpdir(), "chorus-repository-registry-"));
  execFileSync("git", ["init", "--quiet"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "chorus@example.test"], {
    cwd: directory,
  });
  execFileSync("git", ["config", "user.name", "Chorus Test"], {
    cwd: directory,
  });
  writeFileSync(join(directory, "README.md"), "registry fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: directory });
  execFileSync("git", ["commit", "--quiet", "-m", "initial"], {
    cwd: directory,
  });
  return directory;
}

describe("RepositoryRegistry", () => {
  test("starts empty and rejects arbitrary client paths", async () => {
    const repository = makeRepository();
    const registry = await RepositoryRegistry.fromEnvironment(undefined);
    try {
      expect(registry.roots).toEqual([]);
      await expect(registry.validateCandidate(repository)).rejects.toThrow(
        "not approved by the operator"
      );
    } finally {
      rmSync(repository, { force: true, recursive: true });
    }
  });

  test("accepts only exact configured Git roots and canonicalizes aliases", async () => {
    const repository = makeRepository();
    const registry = await RepositoryRegistry.fromEnvironment(
      JSON.stringify([repository])
    );
    try {
      expect(await registry.validateCandidate(repository)).toBe(repository);
      await expect(
        registry.validateCandidate(join(repository, "README.md"))
      ).rejects.toThrow();
    } finally {
      rmSync(repository, { force: true, recursive: true });
    }
  });

  test("authorizes only the configured root and its registered managed worktrees", async () => {
    const repository = makeRepository();
    const unapprovedRepository = makeRepository();
    const registry = await RepositoryRegistry.fromEnvironment(
      JSON.stringify([repository])
    );
    const worktrees = new WorktreeManager();
    let worktree: string | undefined;
    try {
      expect(await registry.validateAuthorizedCheckout(repository)).toBe(
        repository
      );
      worktree = await worktrees.ensureWorktree(repository, "board-1");
      expect(await registry.validateAuthorizedCheckout(worktree)).toBe(
        worktree
      );
      await expect(
        registry.validateAuthorizedCheckout(unapprovedRepository)
      ).rejects.toThrow("not approved by the operator");
      await expect(
        registry.validateAuthorizedCheckout(join(worktree, "nested"))
      ).rejects.toThrow("checkout");
    } finally {
      if (worktree) {
        await worktrees.removeWorktree(repository, "board-1");
      }
      rmSync(repository, { force: true, recursive: true });
      rmSync(unapprovedRepository, { force: true, recursive: true });
    }
  });

  test("rejects malformed root configuration and non-Git directories", async () => {
    const directory = mkdtempSync(join(tmpdir(), "chorus-not-git-"));
    try {
      await expect(
        RepositoryRegistry.fromEnvironment("not-json")
      ).rejects.toThrow("JSON array");
      await expect(
        RepositoryRegistry.fromEnvironment(JSON.stringify([directory]))
      ).rejects.toThrow("Git checkout root");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("store validates board creation and replaces client executable paths", async () => {
    const repository = makeRepository();
    const unapprovedRepository = makeRepository();
    const dataDirectory = mkdtempSync(join(tmpdir(), "chorus-registry-db-"));
    const registry = await RepositoryRegistry.fromEnvironment(
      JSON.stringify([repository])
    );
    const store = new WorkspaceStore(dataDirectory, {
      repositoryRegistry: registry,
    });
    try {
      await store.load();
      const commit = await store.applyMutation({
        baseRevision: null,
        clientId: "registry-test",
        mutationId: crypto.randomUUID(),
        payload: {
          seed: {
            repo: {
              directory: repository,
              worktree: join(repository, "outside-client-value"),
              sandboxes: ["C:/private"],
            },
            title: "Trusted repo",
          },
        },
        type: "board.create",
      });

      const created = commit?.events[0];
      expect(created?.type).toBe("board.created");
      if (created?.type === "board.created") {
        expect(created.board.repo.directory).toBe(repository);
        expect(created.board.repo.worktree).toBe(repository);
        expect(created.board.repo.sandboxes).toEqual([]);
      }

      await expect(
        store.applyMutation({
          baseRevision: null,
          clientId: "registry-test",
          mutationId: crypto.randomUUID(),
          payload: {
            seed: {
              repo: {
                directory: unapprovedRepository,
                sandboxes: [],
                worktree: unapprovedRepository,
              },
              title: "Unapproved",
            },
          },
          type: "board.create",
        })
      ).rejects.toThrow("not approved by the operator");
    } finally {
      await store.close();
      rmSync(dataDirectory, { force: true, recursive: true });
      rmSync(repository, { force: true, recursive: true });
      rmSync(unapprovedRepository, { force: true, recursive: true });
    }
  });

  test("persists host-picker registrations across restart", async () => {
    const repository = makeRepository();
    const dataDirectory = mkdtempSync(
      join(tmpdir(), "chorus-registry-restart-")
    );
    const registry = await RepositoryRegistry.fromEnvironment(undefined);
    const first = new WorkspaceStore(dataDirectory, {
      repositoryRegistry: registry,
    });
    const secondRegistry = await RepositoryRegistry.fromEnvironment(undefined);
    let second: WorkspaceStore | undefined;
    try {
      await first.load();
      expect(await first.registerPickedRepository(repository)).toBe(repository);
      await first.close();

      second = new WorkspaceStore(dataDirectory, {
        repositoryRegistry: secondRegistry,
      });
      await second.load();
      expect(await secondRegistry.validateCandidate(repository)).toBe(
        repository
      );
    } finally {
      await first.close();
      await second?.close();
      rmSync(dataDirectory, { force: true, recursive: true });
      rmSync(repository, { force: true, recursive: true });
    }
  });

  test("production store boot does not restore local picker roots as authority", async () => {
    const repository = makeRepository();
    const dataDirectory = mkdtempSync(
      join(tmpdir(), "chorus-registry-production-")
    );
    const first = new WorkspaceStore(dataDirectory, {
      repositoryRegistry: await RepositoryRegistry.fromEnvironment(undefined),
    });
    const productionRegistry =
      await RepositoryRegistry.fromEnvironment(undefined);
    const production = new WorkspaceStore(dataDirectory, {
      repositoryRegistry: productionRegistry,
      restorePersistedRepositoryRoots: false,
    });
    try {
      await first.load();
      await first.registerPickedRepository(repository);
      await first.close();
      await production.load();
      await expect(
        productionRegistry.validateCandidate(repository)
      ).rejects.toThrow("not approved by the operator");
    } finally {
      await first.close();
      await production.close();
      rmSync(dataDirectory, { force: true, recursive: true });
      rmSync(repository, { force: true, recursive: true });
    }
  });
});
