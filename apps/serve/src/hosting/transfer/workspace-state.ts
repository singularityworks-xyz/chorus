import { isAbsolute, resolve } from "node:path";
import {
  type PortableWorkspaceState,
  portableWorkspaceStateSchema,
  type RepoContext,
  type WorkspaceAuthority,
  type WorkspaceSnapshot,
  workspaceSnapshotSchema,
} from "@chorus/contracts";
import { z } from "zod";
import { RepositoryTransferError } from "./git";
import { portableTaskPaths } from "./workspace-task-paths";

const absolutePathSchema = z.string().min(1).refine(isAbsolute);
const bindingSchema = z.strictObject({
  repositoryId: z.uuid(),
  checkoutId: z.uuid(),
  repository: absolutePathSchema,
  checkout: absolutePathSchema,
});
export type WorkspaceCheckoutBinding = z.infer<typeof bindingSchema>;
const MAX_WORKSPACE_STATE_BYTES = 16 * 1024 * 1024;

function pathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Bindings must describe authorized captured checkouts, or verified inactive targets. */
function indexedBindings(input: WorkspaceCheckoutBinding[]) {
  const bindings = z.array(bindingSchema).max(1000).parse(input);
  const byCheckout = new Map<string, WorkspaceCheckoutBinding>();
  const byId = new Map<string, WorkspaceCheckoutBinding>();
  const repositories = new Map<string, string>();
  const rootIds = new Map<string, string>();
  for (const binding of bindings) {
    const root = pathKey(binding.repository);
    const key = pathKey(binding.checkout);
    if (
      byCheckout.has(key) ||
      byId.has(binding.checkoutId) ||
      (repositories.has(binding.repositoryId) &&
        repositories.get(binding.repositoryId) !== root) ||
      (rootIds.has(root) && rootIds.get(root) !== binding.repositoryId)
    ) {
      throw new RepositoryTransferError("checkpoint_invalid");
    }
    byCheckout.set(key, binding);
    byId.set(binding.checkoutId, binding);
    repositories.set(binding.repositoryId, root);
    rootIds.set(root, binding.repositoryId);
  }
  for (const [id, root] of repositories) {
    if (byCheckout.get(root)?.repositoryId !== id) {
      throw new RepositoryTransferError("checkpoint_invalid");
    }
  }
  return { byCheckout, byId };
}

function assertStateSize(value: unknown): void {
  if (
    Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_WORKSPACE_STATE_BYTES
  ) {
    throw new RepositoryTransferError("checkpoint_too_large");
  }
}

/** Exports the typed workspace projection only: no database, auth metadata or machine config. */
export function captureWorkspaceState(
  snapshotInput: WorkspaceSnapshot,
  authority: WorkspaceAuthority,
  bindings: WorkspaceCheckoutBinding[]
): PortableWorkspaceState {
  const snapshot = workspaceSnapshotSchema.parse(snapshotInput);
  const { byCheckout } = indexedBindings(bindings);
  function mapRepo(repo: RepoContext) {
    const root = byCheckout.get(pathKey(repo.directory));
    const checkout = byCheckout.get(pathKey(repo.worktree));
    if (
      !(root && checkout) ||
      root.repositoryId !== checkout.repositoryId ||
      pathKey(root.repository) !== pathKey(root.checkout)
    ) {
      throw new RepositoryTransferError("checkpoint_invalid");
    }
    const sandboxCheckoutIds = repo.sandboxes.map((path) => {
      const sandbox = byCheckout.get(pathKey(path));
      if (!sandbox || sandbox.repositoryId !== root.repositoryId) {
        throw new RepositoryTransferError("checkpoint_invalid");
      }
      return sandbox.checkoutId;
    });
    return {
      repositoryId: root.repositoryId,
      checkoutId: checkout.checkoutId,
      sandboxCheckoutIds,
      branch: repo.branch,
      projectName: repo.projectName,
    };
  }
  const state = portableWorkspaceStateSchema.parse({
    version: 1,
    authority,
    boards: snapshot.boards.map((board) => ({
      ...board,
      repo: mapRepo(board.repo),
      columns: portableTaskPaths(board.columns, board.repo.worktree),
    })),
    preferences: snapshot.preferences,
    previousWorkspaces: snapshot.previousWorkspaces.map((entry) => {
      const repo = mapRepo(entry.repo);
      // History IDs can be absolute paths or engine-local project IDs.
      return { ...entry, id: repo.checkoutId, repo };
    }),
    selectedBoardId: snapshot.selectedBoardId,
    revision: snapshot.revision,
  });
  assertStateSize(state);
  return state;
}

/** Path projection only. The result remains inactive until handoff/continuation validation. */
export function restoreWorkspaceState(
  input: PortableWorkspaceState,
  bindings: WorkspaceCheckoutBinding[]
): WorkspaceSnapshot {
  assertStateSize(input);
  const state = portableWorkspaceStateSchema.parse(input);
  const { byId, byCheckout } = indexedBindings(bindings);
  function mapRepo(
    repo: PortableWorkspaceState["boards"][number]["repo"]
  ): RepoContext {
    const checkout = byId.get(repo.checkoutId);
    if (!checkout || checkout.repositoryId !== repo.repositoryId) {
      throw new RepositoryTransferError("checkpoint_invalid");
    }
    const root = byCheckout.get(pathKey(checkout.repository));
    if (root?.repositoryId !== repo.repositoryId) {
      throw new RepositoryTransferError("checkpoint_invalid");
    }
    const sandboxes = repo.sandboxCheckoutIds.map((id) => {
      const sandbox = byId.get(id);
      if (!sandbox || sandbox.repositoryId !== repo.repositoryId) {
        throw new RepositoryTransferError("checkpoint_invalid");
      }
      return sandbox.checkout;
    });
    return {
      directory: root.checkout,
      worktree: checkout.checkout,
      branch: repo.branch,
      projectName: repo.projectName,
      sandboxes,
    };
  }
  return workspaceSnapshotSchema.parse({
    boards: state.boards.map((board) => ({
      ...board,
      repo: mapRepo(board.repo),
    })),
    preferences: state.preferences,
    previousWorkspaces: state.previousWorkspaces.map((entry) => {
      const repo = mapRepo(entry.repo);
      return { ...entry, id: repo.worktree, repo };
    }),
    revision: state.revision,
    selectedBoardId: state.selectedBoardId,
  });
}
