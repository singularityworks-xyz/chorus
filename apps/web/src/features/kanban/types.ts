import type { Columns } from "@chorus/contracts";

export interface ChangedFile {
  added: number;
  path: string;
  removed: number;
}

export interface KanbanCardData {
  columns: Columns;
  id: string;
  reviewMode?: "manual" | "auto";
  title: string;
}
