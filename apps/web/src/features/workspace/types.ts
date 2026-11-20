import type {
  BoardSeed,
  BoardSessionHistoryCommand,
  WorkspaceBoard as ContractWorkspaceBoard,
  WorkspaceHistoryEntry as ContractWorkspaceHistoryEntry,
  WorkspacePreferences as ContractWorkspacePreferences,
  ModelSelection,
  ProjectListResponse,
  QueueBoardPromptResponse,
  RepoProject,
  Task,
  WorkspaceColumnId,
} from "@chorus/contracts";
import type { PendingDrag } from "./reducer";
import type { WorkspaceSessionStatus } from "./session-status";

export type WorkspaceProject = ProjectListResponse["projects"][number];
export type WorkspaceBoardSeed = BoardSeed;

export type BoardSessionState =
  | "uninitialized"
  | "starting"
  | "active"
  | "error";

export type WorkspaceBoard = ContractWorkspaceBoard;
export type WorkspaceHistoryEntry = ContractWorkspaceHistoryEntry;
export type WorkspacePreferences = ContractWorkspacePreferences;

export interface PromptSubmissionResult extends QueueBoardPromptResponse {
  task: Task;
}

export interface SessionHistoryCommandResult {
  error?: string;
  ok: boolean;
}

export interface PromptPart {
  filename?: string;
  isDirectory?: boolean;
  lineRange?: { start: number; end: number };
  mime?: string;
  path?: string;
  text?: string;
  type: "text" | "file";
}

export interface WorkspaceContextValue {
  addRecentModel: (model: ModelSelection) => void;

  authExpired: boolean;
  boardLayoutVersion: number;
  boards: WorkspaceBoard[];
  clearSelection: () => void;

  connectionError: string | null;
  createBoardFromHistory: (entry: WorkspaceHistoryEntry) => void;
  createBoardFromProject: (project: RepoProject) => void;
  dismissComposerHint: () => void;
  dismissWorkspaceActionError: () => void;

  focusBoardLocally: (boardId: string) => void;

  hydrated: boolean;
  isLoadingRecentProjects: boolean;
  isOpeningFolder: boolean;
  isQueueingPrompt: boolean;

  lastSeq: number;
  loadProjects: () => Promise<void>;
  openFolder: () => Promise<void>;

  pendingDrags: Map<string, PendingDrag>;
  preferences: WorkspacePreferences;
  previousWorkspaces: WorkspaceHistoryEntry[];
  queuePrompt: (input: {
    agent?: string;
    model?: {
      modelID: string;
      providerID: string;
    };
    parts?: PromptPart[];
    text: string;
  }) => Promise<PromptSubmissionResult | null>;
  recentProjects: WorkspaceProject[];
  recentProjectsError: string | null;
  recentProjectsLoaded: boolean;
  removeBoard: (boardId: string) => Promise<void>;
  reorderBoardTask: (
    boardId: string,
    taskId: string,
    column: WorkspaceColumnId,
    beforeTaskId: string | null
  ) => Promise<void>;
  restoredPrompt: string;
  restorePrompt: (text: string) => void;
  selectBoard: (boardId: string) => void;
  selectedBoard?: WorkspaceBoard;
  selectedBoardId: string | null;
  sessionCommand: (
    boardId: string,
    command: BoardSessionHistoryCommand
  ) => Promise<SessionHistoryCommandResult>;
  sessionHistoryChange: { boardId: string; revision: number } | null;

  sessionStatus: WorkspaceSessionStatus;
  setBoardModel: (boardId: string, model: ModelSelection | null) => void;
  setBoardViewMode: (mode: WorkspacePreferences["boardViewMode"]) => void;
  setDefaultModelSelection: (model: ModelSelection | null) => Promise<void>;
  setSpeechVoiceId: (voiceId: string | null) => void;
  updateBoardPosition: (
    boardId: string,
    position: { x: number; y: number }
  ) => void;
  updateBoardReviewMode: (
    boardId: string,
    reviewMode: "manual" | "auto"
  ) => Promise<void>;
  workspaceActionError: string | null;
}
