import type { BoardViewMode } from "@chorus/contracts";
import { FolderIcon, XIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useEffect } from "react";
import { cn } from "@/lib/utils";
import type { WorkspaceContextValue } from "../types";

type MobileMenuDrawerProps = Pick<
  WorkspaceContextValue,
  | "createBoardFromHistory"
  | "createBoardFromProject"
  | "isLoadingRecentProjects"
  | "isOpeningFolder"
  | "loadProjects"
  | "previousWorkspaces"
  | "recentProjects"
  | "recentProjectsError"
  | "recentProjectsLoaded"
  | "setBoardViewMode"
> & {
  boardViewMode: BoardViewMode;
  onClose: () => void;
  onOpenFolder: () => void;
  open: boolean;
};

export function MobileMenuDrawer({
  open,
  onClose,
  onOpenFolder,
  boardViewMode,
  isOpeningFolder,
  isLoadingRecentProjects,
  recentProjectsError,
  recentProjectsLoaded,
  loadProjects,
  previousWorkspaces,
  recentProjects,
  createBoardFromHistory,
  createBoardFromProject,
  setBoardViewMode,
}: MobileMenuDrawerProps) {
  // Lock body scroll while drawer is open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <>
      <button
        aria-label="Close menu"
        className="fixed inset-0 z-60 cursor-default bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        type="button"
      />
      <div
        className={cn(
          "fixed inset-y-0 left-0 z-61 flex w-72 flex-col",
          "border-white/10 border-r bg-zinc-950/95 shadow-[4px_0_40px_rgba(0,0,0,0.6)] backdrop-blur-2xl"
        )}
      >
        <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-white/8 border-b px-4">
          <Link
            aria-label="Go to Chorus home"
            className="flex items-center gap-2 rounded-xs transition-colors hover:text-white/90"
            href="/"
            onClick={onClose}
          >
            <Image
              alt="Chorus logo"
              className="h-5 w-6 invert"
              height={19}
              loading="eager"
              src="/chorus.svg"
              width={24}
            />
            <span className="select-none font-semibold text-sm text-white tracking-[0.02em]">
              Chorus
            </span>
          </Link>
          <button
            className="flex size-7 items-center justify-center rounded-xs text-white/30 transition-colors hover:bg-white/8 hover:text-white/70"
            onClick={onClose}
            type="button"
          >
            <XIcon className="size-4" />
          </button>
        </div>
        <div className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
          <div className="mb-1">
            <p className="mb-1 px-2 font-semibold text-[0.6rem] text-white/25 uppercase tracking-widest">
              File
            </p>
            <button
              className="flex w-full items-center gap-2.5 rounded-xs px-3 py-2.5 text-sm text-white/70 transition-colors hover:bg-white/6 hover:text-white"
              onClick={() => {
                onOpenFolder();
                onClose();
              }}
              type="button"
            >
              <span className="text-white/40">
                <FolderIcon className="size-4" />
              </span>
              {isOpeningFolder ? "Opening…" : "Open Folder…"}
            </button>

            {previousWorkspaces.length > 0 && (
              <>
                <p className="mt-3 mb-1 px-2 font-semibold text-[0.6rem] text-white/25 uppercase tracking-widest">
                  Previous Working
                </p>
                {previousWorkspaces.map((entry) => (
                  <button
                    className="flex w-full flex-col rounded-xs px-3 py-2 transition-colors hover:bg-white/6"
                    key={entry.id}
                    onClick={() => {
                      createBoardFromHistory(entry);
                      onClose();
                    }}
                    type="button"
                  >
                    <span className="truncate font-medium text-sm text-white/85">
                      {entry.title}
                    </span>
                    <span className="truncate text-[0.67rem] text-white/35">
                      {entry.repo.directory}
                    </span>
                  </button>
                ))}
              </>
            )}

            <p className="mt-3 mb-1 px-2 font-semibold text-[0.6rem] text-white/25 uppercase tracking-widest">
              Known Projects
            </p>
            {(isLoadingRecentProjects ||
              !(recentProjectsLoaded || recentProjectsError)) && (
              <p
                className="px-3 py-2 text-[0.67rem] text-white/40"
                role="status"
              >
                {recentProjects.length > 0
                  ? "Refreshing known projects…"
                  : "Loading known projects…"}
              </p>
            )}
            {recentProjectsError && (
              <div
                className="flex flex-col gap-2 rounded-xs border border-rose-500/15 bg-rose-500/[0.03] px-3 py-2 text-[0.67rem] text-rose-200/80"
                role="alert"
              >
                <span>{recentProjectsError}</span>
                <button
                  className="self-start underline underline-offset-2 disabled:opacity-50"
                  disabled={isLoadingRecentProjects}
                  onClick={loadProjects}
                  type="button"
                >
                  {isLoadingRecentProjects ? "Retrying…" : "Retry"}
                </button>
              </div>
            )}
            {recentProjects.length === 0 &&
              recentProjectsLoaded &&
              !isLoadingRecentProjects &&
              !recentProjectsError && (
                <p className="px-3 py-2 text-[0.67rem] text-white/40">
                  No known projects yet
                </p>
              )}
            {recentProjects.map((project) => (
              <button
                className="flex w-full flex-col rounded-xs px-3 py-2 transition-colors hover:bg-white/6"
                key={`${project.projectId ?? project.directory}`}
                onClick={() => {
                  createBoardFromProject(project);
                  onClose();
                }}
                type="button"
              >
                <span className="truncate font-medium text-sm text-white/85">
                  {project.projectName ??
                    project.directory.split("/").filter(Boolean).at(-1) ??
                    project.directory}
                </span>
                <span className="truncate text-[0.67rem] text-white/35">
                  {project.directory}
                </span>
              </button>
            ))}
          </div>

          <div className="my-1 h-px bg-white/6" />

          <div>
            <p className="mb-1 px-2 font-semibold text-[0.6rem] text-white/25 uppercase tracking-widest">
              View
            </p>
            <button
              className={cn(
                "flex w-full flex-col items-start rounded-xs px-3 py-2.5 text-left transition-colors",
                boardViewMode === "stacked"
                  ? "bg-white/8 text-white"
                  : "text-white/65 hover:bg-white/6 hover:text-white"
              )}
              onClick={() => {
                setBoardViewMode("stacked");
                onClose();
              }}
              type="button"
            >
              <span className="font-medium text-sm">Stacked</span>
              <span className="text-[0.67rem] text-white/40">
                Layer boards into a card stack with visible title bars.
              </span>
            </button>
            <button
              className={cn(
                "mt-1 flex w-full flex-col items-start rounded-xs px-3 py-2.5 text-left transition-colors",
                boardViewMode === "relaxed"
                  ? "bg-white/8 text-white"
                  : "text-white/65 hover:bg-white/6 hover:text-white"
              )}
              onClick={() => {
                setBoardViewMode("relaxed");
                onClose();
              }}
              type="button"
            >
              <span className="font-medium text-sm">Relaxed</span>
              <span className="text-[0.67rem] text-white/40">
                Auto-arrange boards into a clean grid with no overlap.
              </span>
            </button>
          </div>

          <div className="my-1 h-px bg-white/6" />
          <div>
            <p className="mb-1 px-2 font-semibold text-[0.6rem] text-white/25 uppercase tracking-widest">
              Menu
            </p>
            <Link
              className="flex w-full items-center rounded-xs px-3 py-2.5 text-sm text-white/60 transition-colors hover:bg-white/6 hover:text-white"
              href="/help"
              onClick={onClose}
            >
              Help
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
