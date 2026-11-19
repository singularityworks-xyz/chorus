"use client";

import {
  type Columns,
  type Task,
  type WorkspaceColumnId,
  workspaceColumnIdSchema,
} from "@chorus/contracts";
import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ComponentProps } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

interface KanbanContextValue {
  activeId: string | null;
  getItemValue: (item: Task) => string;
  value: Columns;
}

const KanbanContext = createContext<KanbanContextValue | null>(null);

function useKanbanContext() {
  const ctx = useContext(KanbanContext);
  if (!ctx) {
    throw new Error("Kanban components must be used within a Kanban");
  }
  return ctx;
}

export function Kanban({
  id,
  value,
  onReorderTask,
  getItemValue,
  children,
}: {
  id?: string;
  value: Columns;
  onReorderTask: (
    taskId: string,
    column: WorkspaceColumnId,
    beforeTaskId: string | null
  ) => void;
  getItemValue: (item: Task) => string;
  children: React.ReactNode;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [isMounted, setIsMounted] = useState(false);
  const fallbackId = useId();
  const dndContextId = id ?? fallbackId;

  useEffect(() => {
    setIsMounted(true);
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 2 } }),
    useSensor(TouchSensor, { activationConstraint: { distance: 2 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const findTaskById = useCallback(
    (columns: Columns, id: string): Task | null => {
      for (const tasks of Object.values(columns)) {
        const found = tasks.find((t) => getItemValue(t) === id);
        if (found) {
          return found;
        }
      }
      return null;
    },
    [getItemValue]
  );

  function handleDragStart(event: DragStartEvent) {
    const id = event.active.id.toString();
    setActiveId(id);
    setActiveTask(findTaskById(value, id));
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setActiveId(null);
    setActiveTask(null);

    if (!over) {
      return;
    }

    const activeId = active.id.toString();
    const overId = over.id.toString();

    if (activeId === overId) {
      return;
    }

    const activeContainer = Object.entries(value).find(([, tasks]) =>
      tasks.some((t) => getItemValue(t) === activeId)
    );
    const overContainer = Object.entries(value).find(([, tasks]) =>
      tasks.some((t) => getItemValue(t) === overId)
    );

    if (!(activeContainer && overContainer)) {
      return;
    }

    const [activeColId, activeTasks] = activeContainer;
    const [overColId, overTasks] = overContainer;

    const activeIndex = activeTasks.findIndex(
      (t) => getItemValue(t) === activeId
    );
    const overIndex = overTasks.findIndex((t) => getItemValue(t) === overId);

    if (activeColId === overColId) {
      const parsedColumn = workspaceColumnIdSchema.safeParse(activeColId);
      if (!parsedColumn.success) {
        return;
      }

      const reordered = arrayMove(activeTasks, activeIndex, overIndex);
      const reorderedIndex = reordered.findIndex(
        (task) => getItemValue(task) === activeId
      );
      const nextTask = reordered[reorderedIndex + 1];
      onReorderTask(
        activeId,
        parsedColumn.data,
        nextTask ? getItemValue(nextTask) : null
      );
    }
  }

  return (
    <KanbanContext.Provider value={{ value, getItemValue, activeId }}>
      <DndContext
        collisionDetection={closestCorners}
        id={dndContextId}
        onDragEnd={handleDragEnd}
        onDragStart={handleDragStart}
        sensors={sensors}
      >
        {children}
        {isMounted
          ? createPortal(
              <DragOverlay>
                {activeTask ? (
                  <div className="rotate-2 scale-105 opacity-90">
                    <div className="rounded-xs border border-border/50 bg-card p-3 text-[14px] shadow-xl dark:border-white/10 dark:bg-[#1e1e1e] dark:shadow-2xl">
                      <span className="font-medium text-foreground text-sm dark:text-white/90">
                        {activeTask.title}
                      </span>
                    </div>
                  </div>
                ) : null}
              </DragOverlay>,
              document.body
            )
          : null}
      </DndContext>
    </KanbanContext.Provider>
  );
}

export function KanbanBoard({ className, children }: ComponentProps<"div">) {
  return <div className={cn("grid gap-3", className)}>{children}</div>;
}

export function KanbanColumn({
  value: columnId,
  className,
  children,
}: {
  value: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn("flex h-full min-h-0 flex-col", className)}
      data-column={columnId}
    >
      {children}
    </div>
  );
}

export function KanbanColumnContent({
  value: columnId,
  className,
  children,
}: {
  value: string;
  className?: string;
  children: React.ReactNode;
}) {
  const { value, getItemValue } = useKanbanContext();
  const tasks = value[columnId] || [];
  const itemIds = tasks.map((t) => getItemValue(t));

  return (
    <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
      <div className={cn("min-h-20", className)}>{children}</div>
    </SortableContext>
  );
}

export function KanbanItem({
  value,
  children,
  className,
  disabled,
  ...props
}: {
  value: string;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
} & ComponentProps<"div">) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: value });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div
      className={cn(
        disabled ? "" : "cursor-grab active:cursor-grabbing",
        className
      )}
      ref={setNodeRef}
      style={style}
      {...(disabled ? {} : attributes)}
      {...(disabled ? {} : listeners)}
      {...props}
    >
      {children}
    </div>
  );
}

export function KanbanItemHandle({
  children,
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div className={cn("touch-none", className)} {...props}>
      {children}
    </div>
  );
}
