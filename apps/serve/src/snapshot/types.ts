export interface SnapshotPatch {
  files: string[];
  hash: string;
}

export interface FileDiff {
  additions: number;
  after: string | null;
  before: string | null;
  deletions: number;
  file: string;
  status: "added" | "deleted" | "modified";
}

export interface GitStatus {
  ahead: number;
  behind: number;
  branch: string;
  linesAdded: number;
  linesRemoved: number;
  modified: number;
  staged: number;
  tracking: string | null;
  untracked: number;
}
