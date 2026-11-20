import type { WorkspaceEvent } from "@chorus/contracts";

export interface SequencedRecord {
  boardId: string | null;
  event: WorkspaceEvent;
  seq: number;
}

export interface StoreCommit {
  boardId: string | null;
  events: WorkspaceEvent[];
  firstSeq: number;
  lastSeq: number;
}

export interface WorktreeProvisioner {
  assertRemovable?(repoDirectory: string, boardId: string): Promise<void>;
  ensureWorktree(
    repoDirectory: string,
    boardId: string,
    branch?: string
  ): Promise<string>;
  needsWorktree(
    boards: ReadonlyArray<{ repo: { directory: string } }>,
    repoDirectory: string
  ): boolean;
  removeWorktree?(repoDirectory: string, boardId: string): Promise<void>;
}
