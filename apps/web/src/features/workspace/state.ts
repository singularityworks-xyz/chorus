import type { BoardSeed, RepoProject } from "@chorus/contracts";
import { attachSession } from "@chorus/contracts";
import type { Columns, Task } from "@/features/kanban/components/kanban";
import type { WorkspaceBoard } from "./types";

const BOARD_X_OFFSET = 180;
const BOARD_Y_OFFSET = 120;
const BOARD_X_START = 120;
const BOARD_Y_START = 120;

function createEmptyColumns(): Columns {
  return {
    queue: [],
    in_progress: [],
    approve: [],
    done: [],
  };
}

function createTaskId(boardId: string) {
  return `${boardId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getBasename(directory: string) {
  const segments = directory.split("/").filter(Boolean);
  return segments.at(-1) ?? directory;
}

export function createBoardFromSeed(
  seed: BoardSeed,
  index: number
): WorkspaceBoard {
  return {
    boardId: crypto.randomUUID(),
    title: seed.title,
    repo: seed.repo,
    position: {
      x: BOARD_X_START + index * BOARD_X_OFFSET,
      y: BOARD_Y_START + index * BOARD_Y_OFFSET,
    },
    columns: createEmptyColumns(),
    reviewMode: "auto",
    modelSelection: null,
    session: {
      state: "uninitialized",
    },
  };
}

export function createBoardFromProject(
  project: RepoProject,
  index: number
): WorkspaceBoard {
  return createBoardFromSeed(
    {
      title: project.projectName ?? getBasename(project.directory),
      repo: {
        ...project,
      },
    },
    index
  );
}

export function createBoardFromHistoryEntry(
  entry: Pick<WorkspaceBoard, "repo" | "title">,
  index: number
): WorkspaceBoard {
  return createBoardFromSeed(
    {
      title: entry.title,
      repo: entry.repo,
    },
    index
  );
}

export function createPromptTask(input: {
  board: WorkspaceBoard;
  modelLabel: string;
  prompt: string;
}): Task {
  const taskId = createTaskId(input.board.boardId);
  const startedAt = Date.now();

  return {
    id: taskId,
    title: input.prompt.slice(0, 96),
    label:
      input.board.repo.projectName ?? getBasename(input.board.repo.directory),
    labelVariant: "primary-light",
    run: {
      elapsed: "0m 00s",
      model: input.modelLabel,
      startedAt,
      steps: [
        {
          id: `${taskId}-queued`,
          kind: "thinking",
          status: "running",
          summary: "Submitting prompt to OpenCode",
          content: input.prompt,
        },
      ],
      taskTitle: input.prompt.slice(0, 96),
    },
  };
}

export function attachPromptTask(
  board: WorkspaceBoard,
  task: Task
): WorkspaceBoard {
  return {
    ...board,
    columns: {
      ...board.columns,
      in_progress: [...board.columns.in_progress, task],
    },
    session: {
      ...board.session,
      currentTaskId: task.id,
      errorMessage: undefined,
    },
  };
}

/**
 * Delegates to the shared projector so `apps/web` and `apps/serve` cannot
 * drift on how a session binds to a board.
 */
export function attachSessionToBoard(
  board: WorkspaceBoard,
  sessionId: string
): WorkspaceBoard {
  return attachSession(board, sessionId, Date.now());
}

export function updateBoardPosition(
  board: WorkspaceBoard,
  position: { x: number; y: number }
): WorkspaceBoard {
  return {
    ...board,
    position,
  };
}

export function updateBoardColumns(
  board: WorkspaceBoard,
  columns: Columns
): WorkspaceBoard {
  return {
    ...board,
    columns,
  };
}

export function updateBoardReviewMode(
  board: WorkspaceBoard,
  reviewMode: "manual" | "auto"
): WorkspaceBoard {
  return {
    ...board,
    reviewMode,
  };
}
