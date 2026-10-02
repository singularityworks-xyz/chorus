import type {
  BoardSeed,
  WorkspaceBoard as ContractWorkspaceBoard,
  WorkspaceHistoryEntry as ContractWorkspaceHistoryEntry,
  WorkspacePreferences as ContractWorkspacePreferences,
  ModelSelection,
  ProjectListResponse,
  QueueBoardPromptResponse,
  RepoProject,
} from "@chorus/contracts";
import type { Columns, Task } from "@/features/kanban/components/kanban";
import type { PendingDrag } from "./reducer";

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
  /** True once the session died; the shell renders the login screen. */
  authExpired: boolean;
  boardLayoutVersion: number;
  boards: WorkspaceBoard[];
  clearSelection: () => void;
  /** Last transport or protocol error, for the status strip. */
  connectionError: string | null;
  createBoardFromHistory: (entry: WorkspaceHistoryEntry) => void;
  createBoardFromProject: (project: RepoProject) => void;
  dismissComposerHint: () => void;
  /**
   * Whether workspace state is loaded yet.
   *
   * `false` means "nothing here yet", which is otherwise indistinguishable from
   * "connected, and the workspace really is empty".
   */
  hydrated: boolean;
  isOpeningFolder: boolean;
  isQueueingPrompt: boolean;
  kanbanHistory: {
    canRedo: boolean;
    canUndo: boolean;
    redo: () => { columns: Columns; task: Task } | null;
    recordMove: (
      columnsBefore: Columns,
      columnsAfter: Columns,
      task: Task
    ) => void;
    undo: () => { columns: Columns; prompt: string; task: Task } | null;
  };
  /** Highest contiguously applied sequence, for diagnostics and e2e assertions. */
  lastSeq: number;
  loadProjects: () => Promise<void>;
  openFolder: () => Promise<void>;
  /** In-flight optimistic board positions, keyed by board id. */
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
  removeBoard: (boardId: string) => void;
  restoredPrompt: string;
  restorePrompt: (text: string) => void;
  selectBoard: (boardId: string) => void;
  selectedBoard?: WorkspaceBoard;
  selectedBoardId: string | null;
  sessionCommand: (command: "undo" | "redo") => Promise<boolean>;
  /** Socket status, so the UI can show a reconnecting strip. */
  sessionStatus: "connecting" | "live" | "offline" | "auth-expired";
  setBoardModel: (boardId: string, model: ModelSelection | null) => void;
  setBoardViewMode: (mode: WorkspacePreferences["boardViewMode"]) => void;
  setSpeechVoiceId: (voiceId: string | null) => void;
  updateBoardColumns: (boardId: string, columns: Columns) => void;
  updateBoardPosition: (
    boardId: string,
    position: { x: number; y: number }
  ) => void;
  updateBoardReviewMode: (
    boardId: string,
    reviewMode: "manual" | "auto"
  ) => void;
}
