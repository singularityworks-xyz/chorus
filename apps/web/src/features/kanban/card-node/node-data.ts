import type { GitStatus } from "@/lib/opencode-client";
import type { KanbanCardData } from "../types";

export const KANBAN_CARD_NODE_TYPE = "kanbanCard";

export interface KanbanCardNodeData {
  boardId: string;
  columns: KanbanCardData["columns"];
  filePath?: string;
  gitBranch?: string;
  gitStatus?: GitStatus | null;
  hasMobilePrompt?: boolean;
  isRemoving?: boolean;
  onRemove: (id: string) => void;
  projectName?: string;
  reviewMode?: "manual" | "auto";
  sessionId?: string;
  sessionState: "uninitialized" | "starting" | "active" | "error";
  title: string;
  [key: string]: unknown;
}
