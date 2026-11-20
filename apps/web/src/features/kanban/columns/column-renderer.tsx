"use client";

import { ResizablePanel } from "@/components/ui/resizable";
import { KanbanColumnBody } from "./column-body";
import type { KanbanColumnProps } from "./types";

export function KanbanColumnRenderer(props: KanbanColumnProps) {
  return (
    <ResizablePanel
      className="flex min-w-0 flex-col"
      defaultSize={25}
      minSize={15}
    >
      <KanbanColumnBody {...props} />
    </ResizablePanel>
  );
}
